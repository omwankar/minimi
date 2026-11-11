import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { config, searchBackend } from "./config.js";
import type { SourceLink } from "./types.js";

export type SearchHit = SourceLink & {
  snippet: string;
  extract?: string;
};

export type SearchGroup = {
  query: string;
  hits: SearchHit[];
  cached: boolean;
};

type CacheFile = Record<string, { at: number; hits: SearchHit[] }>;

const TTL_MS = 3 * 60 * 60 * 1000;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const memoryCache = new Map<string, { at: number; hits: SearchHit[] }>();
let cacheLoaded = false;
let cacheChain: Promise<void> = Promise.resolve();

function cachePath(): string {
  mkdirSync(config.dataDir, { recursive: true });
  return path.join(config.dataDir, "search-cache.json");
}

function loadCache() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  const file = cachePath();
  if (!existsSync(file)) return;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as CacheFile;
    for (const [key, value] of Object.entries(parsed)) memoryCache.set(key, value);
  } catch {
    // A bad cache file is ignored. The next search refills it.
  }
}

function remember(query: string, hits: SearchHit[]) {
  loadCache();
  memoryCache.set(`${searchBackend()}:${query.toLowerCase()}`, {
    at: Date.now(),
    hits: hits.map((hit) => ({ ...hit })),
  });
  const snapshot = Object.fromEntries(
    [...memoryCache.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, 200)
  );
  cacheChain = cacheChain
    .then(() => {
      writeFileSync(cachePath(), JSON.stringify(snapshot));
    })
    .catch(() => undefined);
}

export async function searchMany(queries: string[]): Promise<SearchGroup[]> {
  const unique = [...new Set(queries.map((query) => query.trim()).filter(Boolean))];
  const groups = await Promise.all(unique.map((query) => searchOne(query)));
  await attachExtracts(groups);
  for (const group of groups) {
    if (!group.cached && group.hits.length) remember(group.query, group.hits);
  }
  return groups;
}

async function searchOne(query: string): Promise<SearchGroup> {
  loadCache();
  const hit = memoryCache.get(`${searchBackend()}:${query.toLowerCase()}`);
  if (hit && Date.now() - hit.at < TTL_MS && hit.hits.length) {
    return { query, hits: hit.hits.map((item) => ({ ...item })), cached: true };
  }

  try {
    const hits = await dispatch(query);
    return { query, hits, cached: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`search failed for "${query}": ${message}`);
    if (searchBackend() !== "duckduckgo") {
      try {
        const hits = await duckDuckGo(query);
        return { query, hits, cached: false };
      } catch {
        // The answer path reports an empty result as "could not verify".
      }
    }
    return { query, hits: [], cached: false };
  }
}

async function dispatch(query: string): Promise<SearchHit[]> {
  const backend = searchBackend();
  if (backend === "brave") return brave(query);
  if (backend === "tavily") return tavily(query);
  return duckDuckGo(query);
}

async function brave(query: string): Promise<SearchHit[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "5");
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": config.braveKey,
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);
  const body = (await res.json()) as {
    web?: { results?: { title?: string; url?: string; description?: string }[] };
  };
  return (body.web?.results ?? []).slice(0, 4).flatMap((row) => {
    if (!row.url || !row.title) return [];
    return [{ title: row.title, url: row.url, snippet: row.description ?? "" }];
  });
}

async function tavily(query: string): Promise<SearchHit[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: config.tavilyKey,
      query,
      max_results: 4,
      search_depth: "basic",
      include_answer: false,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const body = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  return (body.results ?? []).slice(0, 4).flatMap((row) => {
    if (!row.url || !row.title) return [];
    return [{ title: row.title, url: row.url, snippet: row.content ?? "" }];
  });
}

async function duckDuckGo(query: string): Promise<SearchHit[]> {
  const res = await fetch("https://lite.duckduckgo.com/lite/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA,
      Accept: "text/html",
    },
    body: `q=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  return parseDuck(await res.text()).slice(0, 4);
}

function parseDuck(html: string): SearchHit[] {
  const links = [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const snippets = [...html.matchAll(/class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi)].map((match) =>
    textOf(match[1] ?? "")
  );
  const hits: SearchHit[] = [];
  for (const link of links) {
    const url = unwrap(link[1] ?? "");
    const title = textOf(link[2] ?? "");
    if (!url || !title || hits.some((hit) => hit.url === url)) continue;
    hits.push({ title, url, snippet: snippets[hits.length] ?? "" });
    if (hits.length >= 5) break;
  }
  return hits;
}

function unwrap(href: string): string | null {
  try {
    const absolute = href.startsWith("//") ? `https:${href}` : href;
    const url = new URL(absolute, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    if (uddg) return uddg;
    if ((url.protocol === "http:" || url.protocol === "https:") && !url.hostname.endsWith("duckduckgo.com")) {
      return url.toString();
    }
  } catch {
    return null;
  }
  return null;
}

async function attachExtracts(groups: SearchGroup[]) {
  const picks: { hit: SearchHit }[] = [];
  for (const group of groups) {
    if (picks.length >= 5) break;
    const hit =
      group.hits.find((item) => !item.extract && /pricing|plans|changelog|releases/i.test(item.url)) ??
      group.hits.find((item) => !item.extract);
    if (hit && isPublicHttp(hit.url)) picks.push({ hit });
  }
  await Promise.all(
    picks.map(async ({ hit }) => {
      const extract = await fetchExtract(hit.url);
      if (extract) hit.extract = extract;
    })
  );
}

async function fetchExtract(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("html") && !type.includes("text")) return null;
    const html = await readLimited(res, 400_000);
    return focus(textOf(html), 500);
  } catch {
    return null;
  }
}

async function readLimited(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => undefined);
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function focus(text: string, limit: number): string {
  const lower = text.toLowerCase();
  const keys = ["per month", "/mo", "per user", "pricing", "$", "€", "£"];
  let at = -1;
  for (const key of keys) {
    const index = lower.indexOf(key);
    if (index >= 0 && (at < 0 || index < at)) at = index;
  }
  const start = at < 0 ? 0 : Math.max(0, at - 180);
  return text.slice(start, start + limit).trim();
}

function textOf(html: string): string {
  const main = html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? html;
  return decode(main)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(p|div|li|h1|h2|h3|tr|br|section)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decode(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code: string) => {
      const n = Number(code);
      return n > 0 && n < 65536 ? String.fromCharCode(n) : "";
    });
}

function isPublicHttp(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host === "0.0.0.0" || host === "::1") return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host)) return false;
  return true;
}
