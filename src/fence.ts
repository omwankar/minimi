const MARK = /---\s*MEMORY\s*---/;
const HOLD = 16;

export type MemoryDraft = {
  topics: string[];
  entities: string[];
  claims: { subject: string; aspect: string; value: string; source?: string }[];
};

/** Holds back the trailing memory block so it never reaches the chat UI. */
export class StreamFence {
  private full = "";
  private sent = 0;

  push(delta: string): string {
    this.full += delta;
    return this.take(false);
  }

  finish(): string {
    return this.take(true);
  }

  text(): string {
    return this.full;
  }

  private take(finished: boolean): string {
    const at = this.full.search(MARK);
    const end = at >= 0 ? at : finished ? this.full.length : Math.max(this.sent, this.full.length - HOLD);
    const piece = this.full.slice(this.sent, end);
    this.sent = end;
    return piece;
  }
}

export function parseMemory(full: string): MemoryDraft | null {
  const match = MARK.exec(full);
  if (!match) return null;
  const raw = full.slice(match.index + match[0].length);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return clean(JSON.parse(raw.slice(start, end + 1)) as unknown);
  } catch {
    return null;
  }
}

function clean(value: unknown): MemoryDraft {
  const obj = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    topics: strings(obj.topics, 6, 40),
    entities: strings(obj.entities, 8, 60),
    claims: claims(obj.claims),
  };
}

function claims(value: unknown): MemoryDraft["claims"] {
  if (!Array.isArray(value)) return [];
  const out: MemoryDraft["claims"] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const subject = str(row.subject, 80);
    const claimValue = str(row.value, 200);
    if (!subject || !claimValue) continue;
    const source = str(row.source, 300);
    out.push({
      subject,
      aspect: str(row.aspect, 40) || "other",
      value: claimValue,
      ...(source ? { source } : {}),
    });
    if (out.length >= 8) break;
  }
  return out;
}

function strings(value: unknown, max: number, len: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = str(item, len);
    if (!text || out.some((existing) => existing.toLowerCase() === text.toLowerCase())) continue;
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function str(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}
