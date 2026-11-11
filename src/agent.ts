import { config } from "./config.js";
import { formatYmd, resolveTime, zonedYmd } from "./dates.js";
import { guessEntities } from "./entities.js";
import { StreamFence, parseMemory } from "./fence.js";
import { streamAnswer } from "./llm.js";
import type { MemoryStore } from "./memory.js";
import { planTurn } from "./plan.js";
import { searchMany } from "./search.js";
import type { SourceLink } from "./types.js";

const PACKET_CHARS = 9_000;

// Stable across turns so DeepSeek's prefix cache hits. The date goes in the user packet.
const SYSTEM = [
  "You are Minimi, a chat agent with memory and web search.",
  "Lead with the answer. Be brief. No preamble.",
  "Never invent an earlier conversation. If memory says none, say so and ask for the missing names.",
  "If the user is checking an old answer, the first line is: Still correct, Changed, Partly changed, Not in memory, or Could not verify.",
  "Price or product changes: before → after, the old date, and a markdown link for the new figure.",
  "Current facts come only from the search block. If a figure is missing, say you could not verify it.",
  'End with a line ---MEMORY--- then JSON {"topics":[],"entities":[],"claims":[{"subject":"","aspect":"pricing|launch|feature|other","value":"","source":""}]}.',
  "entities are product or company names. claims are only facts you just asserted. The user never sees this block.",
].join("\n");

export type TurnEvent =
  | { type: "status"; text: string }
  | { type: "token"; text: string }
  | { type: "meta"; recalled: string[]; sources: SourceLink[] };

export async function handleMessage(input: {
  store: MemoryStore;
  threadId: string;
  message: string;
  now?: Date;
  signal?: AbortSignal;
  emit: (event: TurnEvent) => void;
}): Promise<void> {
  const now = input.now ?? new Date();
  const started = Date.now();
  const message = input.message.trim();
  const time = resolveTime(message, now, config.timezone);
  const all = await input.store.allEpisodes();
  const plan = planTurn({ message, time, episodes: all, now });
  const thread = await input.store.getThread(input.threadId);
  const recent = plan.episodes.length ? [] : (thread?.messages ?? []).slice(-4);

  const recalled = [...new Set(plan.episodes.map((episode) => formatYmd(episode.day)))];
  input.emit({ type: "meta", recalled, sources: [] });

  if (plan.missingMemory) {
    input.emit({ type: "status", text: "No note from that day" });
  } else if (plan.reused) {
    input.emit({ type: "status", text: "Using a saved answer" });
  } else if (plan.queries.length) {
    input.emit({
      type: "status",
      text: plan.queries.length === 1 ? `Searching ${plan.queries[0]}` : `Searching ${plan.queries.length} queries`,
    });
  } else {
    input.emit({ type: "status", text: "Thinking" });
  }

  const results = plan.queries.length ? await searchMany(plan.queries) : [];
  const cacheHits = results.filter((group) => group.cached).length;
  if (results.length) input.emit({ type: "status", text: "Writing" });

  const fence = new StreamFence();
  const sources = collectSources(results);
  const { usage } = await streamAnswer(
    [
      { role: "system", content: SYSTEM },
      ...recent.map((item) => ({ role: item.role, content: clip(item.content, 350) })),
      {
        role: "user",
        content: packet({
          today: `${formatYmd(zonedYmd(now, config.timezone))} (${config.timezone})`,
          message,
          timeLabel: time.label,
          time,
          plan,
          results,
        }),
      },
    ],
    (delta) => {
      const piece = fence.push(delta);
      if (piece) input.emit({ type: "token", text: piece });
    },
    input.signal
  );
  const tail = fence.finish();
  if (tail) input.emit({ type: "token", text: tail });

  const reply = visibleReply(fence.text());
  const memory = parseMemory(fence.text());
  const entities = memory?.entities.length
    ? memory.entities
    : guessEntities(`${message}\n${reply}`).slice(0, 8);
  const topics = memory?.topics ?? [];
  const claims = memory?.claims ?? [];

  await input.store.appendExchange({
    threadId: input.threadId,
    user: message,
    assistant: reply,
    at: now,
    day: zonedYmd(now, config.timezone),
    topics,
    entities,
    claims,
    sources,
    recalled,
  });

  input.emit({ type: "meta", recalled, sources });
  const promptTokens = usage?.promptTokens ?? 0;
  const completionTokens = usage?.completionTokens ?? 0;
  console.log(
    `[turn] intent=${plan.intent} searches=${results.length} cache=${cacheHits} in=${promptTokens} out=${completionTokens} ms=${Date.now() - started}`
  );
}

function packet(input: {
  today: string;
  message: string;
  timeLabel: string;
  time: { mentioned: boolean; days: string[] };
  plan: ReturnType<typeof planTurn>;
  results: Awaited<ReturnType<typeof searchMany>>;
}): string {
  const lines: string[] = [];
  lines.push(`Today is ${input.today}.`);
  lines.push(input.time.mentioned ? `Time reference: ${input.timeLabel}.` : "Time reference: none.");
  if (input.time.days.length > 1) {
    lines.push(
      "More than one day matched. Prefer the day that fits the topic. If they asked what they said and several days have notes, name each date."
    );
  }
  if (input.plan.reused) {
    lines.push("These claims are from an earlier chat and are still fresh. Answer from them. Do not say you searched again.");
  }
  if (input.plan.intent === "recall" && input.plan.episodes.length) {
    lines.push("They are asking what they asked before. Quote those user lines. Do not say the record is missing.");
  }
  lines.push("", "Notes from memory:");
  if (!input.plan.episodes.length) {
    lines.push(
      input.plan.missingMemory
        ? "(none for that day. Say you do not have that conversation. Do not invent the list or the old answer.)"
        : "(none)"
    );
  } else {
    for (const episode of input.plan.episodes) {
      lines.push(`--- ${formatYmd(episode.day)} ---`);
      lines.push(`User: ${clip(episode.user, 400)}`);
      if (episode.claims.length) {
        lines.push("Claims you stated then:");
        for (const claim of episode.claims) {
          lines.push(
            `- ${claim.subject} / ${claim.aspect}: ${claim.value}${claim.source ? ` (${claim.source})` : ""}`
          );
        }
      } else {
        lines.push(`Your earlier answer: ${clip(episode.assistant, 450)}`);
      }
    }
  }

  if (input.results.length) {
    lines.push("", "Web search just now:");
    for (const group of input.results) {
      lines.push(`Query: ${group.query}`);
      if (!group.hits.length) {
        lines.push("(no results)");
        continue;
      }
      for (const hit of group.hits.slice(0, 2)) {
        lines.push(`- ${hit.title} | ${hit.url}`);
        if (hit.snippet) lines.push(`  ${clip(hit.snippet, 160)}`);
        if (hit.extract) lines.push(`  Page: ${clip(hit.extract, 500)}`);
      }
    }
  } else if (input.plan.intent === "verify" && !input.plan.missingMemory) {
    lines.push("", "Web search returned nothing. Say you could not verify.");
  }

  lines.push("", `User message: ${input.message}`);
  const text = lines.join("\n");
  return text.length <= PACKET_CHARS ? text : `${text.slice(0, PACKET_CHARS)}\n[truncated]`;
}

function collectSources(results: Awaited<ReturnType<typeof searchMany>>): SourceLink[] {
  const sources: SourceLink[] = [];
  for (const group of results) {
    for (const hit of group.hits) {
      if (!sources.some((source) => source.url === hit.url)) {
        sources.push({ title: hit.title, url: hit.url });
      }
    }
  }
  return sources.slice(0, 8);
}

function visibleReply(full: string): string {
  const at = full.search(/---\s*MEMORY\s*---/);
  return (at >= 0 ? full.slice(0, at) : full).trim();
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
