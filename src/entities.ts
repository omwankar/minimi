const STOP = new Set(
  `i a an the on we you me my our your of for to and or has have had any them then what did ask asked about is still correct today changed change pricing price since this that it with from was were be been not do does can could would should just than into over after before last next past monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec official page pages site web search result results user team person people sales something big shipped ship launch launched update updates news current latest new yes no please thanks thank hello hi hey ok okay pro starter business enterprise free plus premium basic standard professional month user seat team plan plans`
    .split(/\s+/)
);

function isStop(name: string): boolean {
  return name.split(/\s+/).every((word) => STOP.has(word.toLowerCase()));
}

function cleanToken(word: string): string {
  return word.replace(/^[("']+|[),:;"'.?!]+$/g, "").replace(/['’]s$/i, "");
}

/** Product names from a shortlist ("HubSpot, Attio, and Folk") or "Neon vs Supabase". */
export function guessEntities(text: string): string[] {
  const found: string[] = [];

  for (const part of text.split(/\n+/)) {
    const bits = part.split(/,|\band\b/i).map((bit) => bit.trim());
    const names = bits
      .map((bit) => {
        const hits = [...bit.matchAll(/\b([A-Z][A-Za-z0-9.+-]{1,40}(?:\s+[A-Z][A-Za-z0-9.+-]{1,40})?)\b/g)]
          .map((match) => match[1])
          .filter((name) => !isStop(name));
        return hits.at(-1);
      })
      .filter((name): name is string => Boolean(name));
    if (names.length >= 2) found.push(...names);
  }

  for (const match of text.matchAll(
    /\b([A-Z][A-Za-z0-9.+-]{1,40})\s+(?:vs\.?|versus)\s+([A-Z][A-Za-z0-9.+-]{1,40})\b/g
  )) {
    if (!isStop(match[1])) found.push(match[1]);
    if (!isStop(match[2])) found.push(match[2]);
  }

  for (const sentence of text.split(/(?<=[.?!])\s+|\n/)) {
    const words = sentence.trim().split(/\s+/);
    for (let i = 1; i < words.length; i += 1) {
      const raw = cleanToken(words[i] ?? "");
      if (!/^[A-Z][A-Za-z0-9.+-]{2,40}$/.test(raw) || isStop(raw)) continue;
      found.push(raw);
    }
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of found) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= 8) break;
  }
  return out;
}
