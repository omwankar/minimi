import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTime } from "./dates.js";
import { planTurn } from "./plan.js";
import type { Episode } from "./types.js";

const now = new Date("2026-11-11T12:00:00.000Z");
const tz = "UTC";

const mondayQ =
  "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?";
const novemberQ = "What did I ask you on 3 November? Is your answer still correct today?";
const tuesdayQ = "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?";

function episode(partial: Partial<Episode> & Pick<Episode, "day" | "user">): Episode {
  return {
    id: partial.id ?? partial.day,
    at: partial.at ?? `${partial.day}T10:00:00.000Z`,
    day: partial.day,
    threadId: "t",
    user: partial.user,
    assistant: partial.assistant ?? "Noted.",
    topics: partial.topics ?? [],
    entities: partial.entities ?? [],
    claims: partial.claims ?? [],
    sources: partial.sources ?? [],
  };
}

test("Monday shortlist searches each remembered product once", () => {
  const time = resolveTime(mondayQ, now, tz);
  const plan = planTurn({
    message: mondayQ,
    time,
    episodes: [
      episode({
        day: "2026-11-09",
        user: "Shortlist HubSpot, Attio, Close, Pipedrive, and Folk.",
        entities: ["HubSpot", "Attio", "Close", "Pipedrive", "Folk"],
        topics: ["crm"],
      }),
    ],
  });
  assert.equal(plan.missingMemory, false);
  assert.equal(plan.intent, "verify");
  assert.deepEqual(
    plan.queries,
    [
      "HubSpot pricing and latest product updates",
      "Attio pricing and latest product updates",
      "Close pricing and latest product updates",
      "Pipedrive pricing and latest product updates",
      "Folk pricing and latest product updates",
    ]
  );
});

test("a named day with no note does not invent a search", () => {
  const time = resolveTime(mondayQ, now, tz);
  const plan = planTurn({ message: mondayQ, time, episodes: [] });
  assert.equal(plan.missingMemory, true);
  assert.deepEqual(plan.queries, []);
});

test("3 November recalls that day's answer and rechecks its prices", () => {
  const time = resolveTime(novemberQ, now, tz);
  const plan = planTurn({
    message: novemberQ,
    time,
    episodes: [
      episode({
        day: "2026-11-03",
        user: "Compare Neon and Supabase for Postgres hosting.",
        assistant: "Neon Launch is $19/mo. Supabase Pro is $25/mo.",
        entities: ["Neon", "Supabase"],
        claims: [
          { subject: "Neon", aspect: "pricing", value: "Launch $19/mo" },
          { subject: "Supabase", aspect: "pricing", value: "Pro $25/mo" },
        ],
      }),
      episode({
        day: "2026-11-11",
        user: "Unrelated note from today.",
        entities: ["Notion"],
      }),
    ],
  });
  assert.equal(plan.episodes.length, 1);
  assert.match(plan.episodes[0]?.user ?? "", /Neon/);
  assert.deepEqual(plan.queries, ["Neon official pricing", "Supabase official pricing"]);
});

test("last Tuesday prefers the Postgres note over the other Tuesday", () => {
  const time = resolveTime(tuesdayQ, now, tz);
  const plan = planTurn({
    message: tuesdayQ,
    time,
    episodes: [
      episode({
        day: time.days[0] ?? "",
        user: "Postgres hosting on Neon vs Supabase.",
        entities: ["Neon", "Supabase"],
        topics: ["postgres", "hosting"],
        claims: [{ subject: "Neon", aspect: "pricing", value: "Launch $19/mo" }],
      }),
      episode({
        day: time.days[1] ?? "",
        user: "CRM shortlist HubSpot and Attio.",
        entities: ["HubSpot", "Attio"],
        topics: ["crm"],
      }),
    ],
  });
  assert.deepEqual(
    plan.episodes.map((item) => item.entities[0]),
    ["Neon"]
  );
  assert.deepEqual(plan.queries, ["Neon official pricing", "Supabase official pricing"]);
});

test("a repeat price question reuses a recent saved claim and does not search", () => {
  const asked = "What is Neon's starting price?";
  const time = resolveTime(asked, now, tz);
  const plan = planTurn({
    message: asked,
    time,
    now: new Date("2026-11-11T10:00:00.000Z"),
    episodes: [
      episode({
        day: "2026-11-11",
        at: "2026-11-11T08:00:00.000Z",
        user: "What is Neon's current starting price?",
        entities: ["Neon"],
        claims: [{ subject: "Neon", aspect: "pricing", value: "Free $0/month" }],
      }),
    ],
  });
  assert.equal(plan.reused, true);
  assert.deepEqual(plan.queries, []);
  assert.match(plan.episodes[0]?.claims[0]?.value ?? "", /\$0/);
});

test("what I asked earlier recalls the last real question and does not search", () => {
  const time = resolveTime("what I asked earlier", now, tz);
  const plan = planTurn({
    message: "what I asked earlier",
    time,
    episodes: [
      episode({
        day: "2026-11-11",
        at: "2026-11-11T08:00:00.000Z",
        user: "What is Neon's current starting price?",
        entities: ["Neon"],
        claims: [{ subject: "Neon", aspect: "pricing", value: "Free $0/month" }],
      }),
      episode({
        day: "2026-11-11",
        at: "2026-11-11T08:05:00.000Z",
        user: "what I asked earlier",
        assistant: "Not in memory.",
      }),
    ],
  });
  assert.equal(plan.intent, "recall");
  assert.deepEqual(plan.queries, []);
  assert.equal(plan.missingMemory, false);
  assert.match(plan.episodes[0]?.user ?? "", /Neon/);
});

test("a shortlist written in prose still becomes one query per product", () => {
  const time = resolveTime(mondayQ, now, tz);
  const plan = planTurn({
    message: mondayQ,
    time,
    episodes: [
      episode({
        day: "2026-11-09",
        user: "We shortlisted HubSpot, Attio, Close, Pipedrive, and Folk.",
        entities: [],
        topics: ["crm", "tools"],
      }),
    ],
  });
  assert.equal(plan.queries.length, 5);
  assert.match(plan.queries[0] ?? "", /^HubSpot /);
});
