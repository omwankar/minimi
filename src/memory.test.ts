import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MemoryStore } from "./memory.js";

test("a note survives a new store on the same file", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "minimi-"));
  const file = path.join(dir, "store.json");
  const first = new MemoryStore(file);
  const thread = await first.createThread("thread-1234");
  await first.appendExchange({
    threadId: thread.id,
    user: "Compare Neon and Supabase.",
    assistant: "Neon Launch is $19/mo.",
    at: new Date("2026-11-03T10:00:00.000Z"),
    day: "2026-11-03",
    topics: ["postgres"],
    entities: ["Neon", "Supabase"],
    claims: [{ subject: "Neon", aspect: "pricing", value: "Launch $19/mo" }],
    sources: [{ title: "Neon", url: "https://neon.tech/pricing" }],
    recalled: [],
  });

  const second = new MemoryStore(file);
  const episodes = await second.allEpisodes();
  const loaded = await second.getThread(thread.id);
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0]?.day, "2026-11-03");
  assert.equal(loaded?.messages.length, 2);
  assert.equal(loaded?.title, "Compare Neon and Supabase.");
  const listed = await second.listThreads();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.title, "Compare Neon and Supabase.");
});
