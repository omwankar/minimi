import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(rootDir, ".env") });

function num(name: string, fallback: number, max: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

export { rootDir };

export const config = {
  deepseekApiKey: process.env.DEEPSEEK_API_KEY?.trim() ?? "",
  deepseekBaseUrl: (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/$/, ""),
  model: process.env.LLM_MODEL?.trim() || "deepseek-flash",
  braveKey: process.env.BRAVE_SEARCH_API_KEY?.trim() ?? "",
  tavilyKey: process.env.TAVILY_API_KEY?.trim() ?? "",
  searchProvider: (process.env.SEARCH_PROVIDER?.trim() || "auto").toLowerCase(),
  timezone: process.env.USER_TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  port: num("PORT", 8787, 65535),
  maxSearches: num("MAX_SEARCHES", 5, 5),
  dataDir: path.join(rootDir, ".data"),
};

export function searchBackend(): "brave" | "tavily" | "duckduckgo" {
  const pick = config.searchProvider;
  if (pick === "brave" && config.braveKey) return "brave";
  if (pick === "tavily" && config.tavilyKey) return "tavily";
  if (pick === "duckduckgo") return "duckduckgo";
  if (config.braveKey) return "brave";
  if (config.tavilyKey) return "tavily";
  return "duckduckgo";
}
