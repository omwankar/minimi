const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

export type ResolvedTime = {
  mentioned: boolean;
  since: boolean;
  label: string;
  days: string[];
};

export function zonedYmd(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function addDays(ymd: string, days: number): string {
  const [year, month, day] = ymd.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days, 12)).toISOString().slice(0, 10);
}

export function weekdayOfYmd(ymd: string): string {
  const [year, month, day] = ymd.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, day, 12)))
    .toLowerCase();
}

export function formatYmd(ymd: string): string {
  const [year, month, day] = ymd.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day, 12)));
}

function mostRecentOnOrBefore(today: string, weekday: string): string {
  const delta = (WEEKDAYS.indexOf(weekdayOfYmd(today)) - WEEKDAYS.indexOf(weekday) + 7) % 7;
  return addDays(today, -delta);
}

function mondayOnOrBefore(today: string): string {
  const sinceMonday = (WEEKDAYS.indexOf(weekdayOfYmd(today)) + 6) % 7;
  return addDays(today, -sinceMonday);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** A bare "3 November" means the most recent past occurrence, not a future one. */
function clampPast(year: number, month: number, day: number, today: string): string {
  const ymd = `${year}-${pad(month)}-${pad(day)}`;
  return ymd > today ? `${year - 1}-${pad(month)}-${pad(day)}` : ymd;
}

/**
 * "last Tuesday" is ambiguous (latest Tuesday, or the Tuesday the week before).
 * Both days are returned. Recall keeps the one that matches the topic.
 * "still correct today" is a check against now, not a request for today's notes.
 */
export function resolveTime(text: string, now: Date, timeZone: string): ResolvedTime {
  const today = zonedYmd(now, timeZone);
  const days: string[] = [];
  const monthAlt = Object.keys(MONTHS)
    .sort((a, b) => b.length - a.length)
    .join("|");

  for (const match of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    days.push(`${match[1]}-${match[2]}-${match[3]}`);
  }

  const dmy = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+(${monthAlt})\\b(?:,?\\s*(\\d{4}))?`,
    "gi"
  );
  for (const match of text.matchAll(dmy)) {
    const month = MONTHS[match[2].toLowerCase()];
    const day = Number(match[1]);
    days.push(
      match[3]
        ? `${match[3]}-${pad(month)}-${pad(day)}`
        : clampPast(Number(today.slice(0, 4)), month, day, today)
    );
  }

  const mdy = new RegExp(`\\b(${monthAlt})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s*(\\d{4}))?`, "gi");
  for (const match of text.matchAll(mdy)) {
    const month = MONTHS[match[1].toLowerCase()];
    const day = Number(match[2]);
    const year = match[3] ? Number(match[3]) : Number(today.slice(0, 4));
    days.push(match[3] ? `${year}-${pad(month)}-${pad(day)}` : clampPast(year, month, day, today));
  }

  const relative = text.replace(/\bstill (correct|true|accurate|right) today\b/gi, "still $1");
  if (/\btoday\b/i.test(relative)) days.push(today);
  if (/\byesterday\b/i.test(relative)) days.push(addDays(today, -1));
  if (/\btomorrow\b/i.test(text)) days.push(addDays(today, 1));

  if (/\blast week\b/i.test(text)) {
    const start = addDays(mondayOnOrBefore(today), -7);
    for (let i = 0; i < 7; i += 1) days.push(addDays(start, i));
  }

  const weekdayRe =
    /\b(?:(last|past|this|on)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi;
  for (const match of text.matchAll(weekdayRe)) {
    const qualifier = match[1]?.toLowerCase();
    const name = match[2].toLowerCase();
    if (qualifier === "last" || qualifier === "past") {
      const recent = mostRecentOnOrBefore(today, name);
      const primary = recent === today ? addDays(today, -7) : recent;
      days.push(primary, addDays(primary, -7));
      continue;
    }
    if (qualifier === "this") {
      const offset = name === "sunday" ? 6 : WEEKDAYS.indexOf(name) - 1;
      days.push(addDays(mondayOnOrBefore(today), offset));
      continue;
    }
    days.push(mostRecentOnOrBefore(today, name));
  }

  const unique: string[] = [];
  for (const day of days) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && !unique.includes(day)) unique.push(day);
  }

  const since = /\b(since|still correct|still true|still accurate|still right|changed|any change)\b/i.test(
    text
  );

  return {
    mentioned: unique.length > 0,
    since,
    label: unique.map(formatYmd).join("; "),
    days: unique,
  };
}
