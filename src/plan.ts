import { config } from "./config.js";
import { guessEntities } from "./entities.js";
import type { ResolvedTime } from "./dates.js";
import type { Episode } from "./types.js";

export type Intent = "chitchat" | "recall" | "verify" | "fresh" | "chat";

export type Plan = {
  intent: Intent;
  queries: string[];
  episodes: Episode[];
  missingMemory: boolean;
  reused: boolean;
};

const TOKEN_STOP = new Set(
  "the a an on we you me my our your for and has have had any them then what did ask asked about was were still correct today changed change pricing price since this that with from does can could would should just than into over after before last next past earlier previously monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december not answer answers something big shipped ship them those same are how who when where which why".split(
    /\s+/
  )
);

export function classify(message: string): Intent {
  const text = message.trim().toLowerCase();
  if (/^(hi|hello|hey|thanks|thank you|ok|okay|cool|got it|goodbye|bye)\b[.!]*$/.test(text)) return "chitchat";

  const recall = refersToPast(text);
  const verify =
    /still (correct|true|accurate|right)|changed|any change|pricing|price|shipped|launch|changelog|update|since then|any of them|anymore/.test(
      text
    );

  if (recall && verify) return "verify";
  if (recall) return "recall";
  if (verify) return "verify";
  if (/\?/.test(text) || /^(what|who|when|where|which|why|how|did|does|is|are|can|has|have)\b/.test(text)) {
    return "fresh";
  }
  if (text.length < 48) return "chat";
  return "fresh";
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9.+-]+/)
    .filter((word) => word.length > 2 && !TOKEN_STOP.has(word));
}

function rank(all: Episode[], message: string, time: ResolvedTime) {
  const words = tokens(message);
  return all
    .map((episode) => {
      const blob = `${episode.user}\n${episode.assistant}\n${episode.topics.join(" ")}\n${episode.entities.join(" ")}`.toLowerCase();
      let topic = 0;
      for (const word of words) if (blob.includes(word)) topic += 3;
      for (const name of episode.entities) {
        if (name && message.toLowerCase().includes(name.toLowerCase())) topic += 6;
      }
      const dayIndex = time.days.indexOf(episode.day);
      const date = dayIndex === 0 ? 5 : dayIndex > 0 ? 3 : 0;
      return { episode, topic, date };
    })
    .sort(
      (a, b) => b.topic + b.date - (a.topic + a.date) || (a.episode.at < b.episode.at ? 1 : -1)
    );
}

export function selectEpisodes(all: Episode[], message: string, time: ResolvedTime): Episode[] {
  const ranked = rank(all, message, time);
  if (time.days.length) {
    const onDays = ranked.filter((row) => time.days.includes(row.episode.day));
    const topical = onDays.filter((row) => row.topic >= 3);
    return (topical.length ? topical : onDays).slice(0, 4).map((row) => row.episode);
  }

  const anaphora = time.since || refersToPast(message) || /\b(them|those|since then|still correct|still true|your answer|that answer|the same)\b/i.test(message);
  if (!anaphora) return [];
  const substantive = ranked.filter((row) => {
    const kind = classify(row.episode.user);
    return kind !== "recall" && kind !== "chitchat";
  });
  const pool = substantive.length ? substantive : ranked;
  const topical = pool.filter((row) => row.topic >= 3);
  return (topical.length ? topical : pool).slice(0, 2).map((row) => row.episode);
}

/** "what I asked earlier" is about this chat, not a web query. */
function refersToPast(text: string): boolean {
  return /what did i ask|what i asked|what have i asked|i asked you|asked (earlier|before)|my (last|previous|earlier) question|what was my question|remind me|do you remember|what did we|we (talked|spoke|discussed)|just asked|previously|earlier/.test(
    text
  );
}

function unique(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const clean = name.trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function queryFor(name: string, message: string, episodes: Episode[]): string {
  const lower = message.toLowerCase();
  const aspects = episodes.flatMap((episode) =>
    episode.claims
      .filter((claim) => claim.subject.toLowerCase() === name.toLowerCase())
      .map((claim) => claim.aspect)
  );
  const price = /pric|cost|plan|tier/.test(lower) || aspects.includes("pricing");
  const news =
    /ship|launch|changelog|release|update|news|announc|something big/.test(lower) || aspects.includes("launch");
  if (price && news) return `${name} pricing and latest product updates`;
  if (price) return `${name} official pricing`;
  if (news) return `${name} changelog`;
  return name;
}

export function buildQueries(message: string, intent: Intent, episodes: Episode[]): string[] {
  if (intent === "chitchat" || intent === "recall" || intent === "chat") return [];

  const fromMemory = episodes.flatMap((episode) =>
    episode.entities.length ? episode.entities : guessEntities(`${episode.user}\n${episode.assistant}`)
  );
  const names = unique(fromMemory.length ? fromMemory : guessEntities(message)).slice(0, config.maxSearches);
  if (names.length) return names.map((name) => queryFor(name, message, episodes));
  return [message.replace(/\s+/g, " ").trim().slice(0, 180)];
}

const REUSE_MS = 6 * 60 * 60 * 1000;

function wantsLiveCheck(message: string): boolean {
  return /changed|still (correct|true|accurate|right)|since|latest|update|news|shipped|anymore|right now/.test(
    message.toLowerCase()
  );
}

/** Same fact, already checked in the last few hours: don't pay for search again. */
function reuseEpisodes(message: string, all: Episode[], now: Date): Episode[] {
  const names = guessEntities(message).map((name) => name.toLowerCase());
  if (!names.length) return [];
  const cutoff = now.getTime() - REUSE_MS;
  const hits = all.filter((episode) => {
    if (Date.parse(episode.at) < cutoff || !episode.claims.length) return false;
    const owned = new Set(
      [...episode.entities, ...episode.claims.map((claim) => claim.subject)].map((name) => name.toLowerCase())
    );
    return names.some((name) => owned.has(name));
  });
  const covered = new Set(
    hits.flatMap((episode) =>
      [...episode.entities, ...episode.claims.map((claim) => claim.subject)].map((name) => name.toLowerCase())
    )
  );
  if (!names.every((name) => covered.has(name))) return [];
  return hits.slice(-2);
}

export function planTurn(input: { message: string; time: ResolvedTime; episodes: Episode[]; now?: Date }): Plan {
  const intent = classify(input.message);
  let episodes =
    intent === "chitchat" || intent === "chat" ? [] : selectEpisodes(input.episodes, input.message, input.time);
  const missingMemory =
    episodes.length === 0 &&
    (intent === "recall" || ((input.time.mentioned || input.time.since) && intent === "verify"));
  let queries = missingMemory ? [] : buildQueries(input.message, intent, episodes);
  let reused = false;
  if ((intent === "fresh" || intent === "verify") && queries.length && !wantsLiveCheck(input.message)) {
    const saved = reuseEpisodes(input.message, input.episodes, input.now ?? new Date());
    if (saved.length) {
      episodes = saved;
      queries = [];
      reused = true;
    }
  }
  return { intent, episodes, missingMemory, queries, reused };
}
