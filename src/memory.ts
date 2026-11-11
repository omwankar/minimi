import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, renameSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Episode, StoredMessage, Thread } from "./types.js";

type StoreData = {
  threads: Record<string, Thread>;
  episodes: Episode[];
};

function empty(): StoreData {
  return { threads: {}, episodes: [] };
}

export class MemoryStore {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    if (!existsSync(file)) this.write(empty());
  }

  private run<T>(fn: () => T): Promise<T> {
    const next = this.chain.then(() => fn());
    this.chain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private read(): StoreData {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as StoreData;
      if (!parsed.threads || !Array.isArray(parsed.episodes)) return empty();
      return parsed;
    } catch {
      return empty();
    }
  }

  private write(data: StoreData) {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    if (existsSync(this.file)) unlinkSync(this.file);
    renameSync(tmp, this.file);
  }

  createThread(id?: string): Promise<Thread> {
    return this.run(() => {
      const data = this.read();
      const threadId = id && id.trim() ? id : randomUUID();
      const existing = data.threads[threadId];
      if (existing) return existing;
      const thread: Thread = {
        id: threadId,
        title: "New chat",
        createdAt: new Date().toISOString(),
        messages: [],
      };
      data.threads[threadId] = thread;
      this.write(data);
      return thread;
    });
  }

  getThread(id: string): Promise<Thread | null> {
    return this.run(() => this.read().threads[id] ?? null);
  }

  listThreads(): Promise<{ id: string; title: string; updatedAt: string }[]> {
    return this.run(() =>
      Object.values(this.read().threads)
        .filter((thread) => thread.messages.length > 0)
        .map((thread) => ({
          id: thread.id,
          title: thread.title,
          updatedAt: thread.messages.at(-1)?.at ?? thread.createdAt,
        }))
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    );
  }

  allEpisodes(): Promise<Episode[]> {
    return this.run(() => this.read().episodes);
  }

  appendExchange(input: {
    threadId: string;
    user: string;
    assistant: string;
    at: Date;
    day: string;
    topics: string[];
    entities: string[];
    claims: Episode["claims"];
    sources: { title: string; url: string }[];
    recalled: string[];
  }): Promise<void> {
    return this.run(() => {
      const data = this.read();
      const thread =
        data.threads[input.threadId] ??
        ({
          id: input.threadId,
          title: "New chat",
          createdAt: input.at.toISOString(),
          messages: [],
        } satisfies Thread);

      if (thread.messages.length === 0) {
        thread.title = input.user.replace(/\s+/g, " ").trim().slice(0, 72) || "New chat";
      }

      const userMessage: StoredMessage = {
        role: "user",
        content: input.user,
        at: input.at.toISOString(),
      };
      const assistantMessage: StoredMessage = {
        role: "assistant",
        content: input.assistant,
        at: input.at.toISOString(),
        sources: input.sources,
        recalled: input.recalled,
      };
      thread.messages.push(userMessage, assistantMessage);
      data.threads[thread.id] = thread;

      const episode: Episode = {
        id: randomUUID(),
        at: input.at.toISOString(),
        day: input.day,
        threadId: thread.id,
        user: input.user,
        assistant: input.assistant,
        topics: input.topics,
        entities: input.entities,
        claims: input.claims,
        sources: input.sources.map((source) => source.url),
      };
      data.episodes.push(episode);
      if (data.episodes.length > 400) data.episodes.splice(0, data.episodes.length - 400);
      this.write(data);
    });
  }
}
