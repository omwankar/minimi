import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleMessage } from "./agent.js";
import { config, searchBackend } from "./config.js";
import { MemoryStore } from "./memory.js";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const store = new MemoryStore(path.join(config.dataDir, "store.json"));

function onRequest(req: IncomingMessage, res: ServerResponse) {
  void route(req, res).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: message });
      return;
    }
    res.end();
  });
}

// Browsers on Windows often send localhost to ::1. An IPv4-only socket
// accepts the page, then the chat POST fails with "Failed to fetch".
function listen(host: string) {
  const instance = createServer(onRequest);
  instance.on("error", (err: NodeJS.ErrnoException) => {
    if (host === "::") {
      console.log("IPv6 not bound; IPv4 is still up.");
      return;
    }
    console.error(err);
    process.exit(1);
  });
  instance.listen(config.port, host, () => {
    console.log(`Minimi  http://localhost:${config.port}  (${host})`);
  });
}

listen("0.0.0.0");
listen("::");
console.log(`model=${config.model}  search=${searchBackend()}  tz=${config.timezone}  key=${config.deepseekApiKey ? "set" : "missing"}`);

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const page = readFileSync(path.join(publicDir, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(page);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      model: config.model,
      search: searchBackend(),
      timezone: config.timezone,
      hasKey: Boolean(config.deepseekApiKey),
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/threads") {
    sendJson(res, 200, await store.listThreads());
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/thread") {
    const thread = await store.createThread();
    sendJson(res, 200, { id: thread.id, title: thread.title, messages: thread.messages });
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/thread/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/thread/".length));
    if (!validId(id)) {
      sendJson(res, 400, { error: "Bad thread id" });
      return;
    }
    const thread = await store.getThread(id);
    sendJson(
      res,
      200,
      thread ?? { id, title: "New chat", createdAt: new Date().toISOString(), messages: [] }
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/chat") {
    await chat(req, res);
    return;
  }
  sendJson(res, 404, { error: "Not found" });
}

async function chat(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  let payload: { threadId?: string; message?: string };
  try {
    payload = JSON.parse(body) as { threadId?: string; message?: string };
  } catch {
    sendJson(res, 400, { error: "Expected JSON" });
    return;
  }
  const message = payload.message?.trim() ?? "";
  if (!message || message.length > 4000) {
    sendJson(res, 400, { error: "Message is empty or too long" });
    return;
  }
  const threadId = payload.threadId && validId(payload.threadId) ? payload.threadId : randomUUID();
  await store.createThread(threadId);

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const aborted = new AbortController();
  // `req` closes when the body is read, which is before the reply is done.
  res.on("close", () => {
    if (!res.writableEnded) aborted.abort();
  });

  const send = (event: string, data: unknown) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await handleMessage({
      store,
      threadId,
      message,
      signal: aborted.signal,
      emit: (event) => {
        if (event.type === "status") send("status", { text: event.text });
        if (event.type === "token") send("token", { text: event.text });
        if (event.type === "meta") send("meta", { recalled: event.recalled, sources: event.sources });
      },
    });
    send("done", { threadId });
  } catch (err) {
    if (aborted.signal.aborted) return;
    const text = err instanceof Error ? err.message : String(err);
    send("error", { text });
  } finally {
    res.end();
  }
}

function validId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{8,80}$/.test(id);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 64_000) throw new Error("Request is too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}
