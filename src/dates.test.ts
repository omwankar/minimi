import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTime, weekdayOfYmd, zonedYmd } from "./dates.js";

const now = new Date("2026-11-11T12:00:00.000Z");
const tz = "UTC";

test("11 November 2026 is a Wednesday", () => {
  assert.equal(weekdayOfYmd(zonedYmd(now, tz)), "wednesday");
});

test("on Monday is the Monday just past", () => {
  const time = resolveTime(
    "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    now,
    tz
  );
  assert.deepEqual(time.days, ["2026-11-09"]);
  assert.equal(time.since, true);
});

test("3 November does not also include today", () => {
  const time = resolveTime("What did I ask you on 3 November? Is your answer still correct today?", now, tz);
  assert.deepEqual(time.days, ["2026-11-03"]);
});

test("last Tuesday keeps the latest Tuesday and the one before it", () => {
  const time = resolveTime(
    "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
    now,
    tz
  );
  assert.deepEqual(time.days, ["2026-11-10", "2026-11-03"]);
});

test("a future day-of-month rolls to last year", () => {
  const time = resolveTime("What did we decide on 20 November?", now, tz);
  assert.deepEqual(time.days, ["2025-11-20"]);
});

test("an explicit year is kept", () => {
  const time = resolveTime("Check November 3, 2025", now, tz);
  assert.deepEqual(time.days, ["2025-11-03"]);
});
