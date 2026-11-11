import assert from "node:assert/strict";
import { test } from "node:test";
import { StreamFence, parseMemory } from "./fence.js";

test("a short reply is released when the stream ends", () => {
  const fence = new StreamFence();
  assert.equal(fence.push("Hel"), "");
  assert.equal(fence.push("lo"), "");
  assert.equal(fence.finish(), "Hello");
});

test("the memory block is stripped even when the marker is split", () => {
  const fence = new StreamFence();
  const full = 'Changed.\nNeon is now $15/mo.\n---MEMORY---\n{"topics":["postgres"],"entities":["Neon"],"claims":[{"subject":"Neon","aspect":"pricing","value":"$15/mo","source":"https://neon.tech"}]}';
  let shown = "";
  shown += fence.push(full.slice(0, 28));
  shown += fence.push(full.slice(28));
  shown += fence.finish();
  assert.equal(shown.includes("MEMORY"), false);
  assert.match(shown, /Changed/);
  const memory = parseMemory(fence.text());
  assert.equal(memory?.entities[0], "Neon");
  assert.equal(memory?.claims[0]?.value, "$15/mo");
});
