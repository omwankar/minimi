import { config } from "./config.js";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type Usage = {
  promptTokens: number;
  completionTokens: number;
};

type DeltaChunk = {
  choices?: { delta?: { content?: string; reasoning_content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export async function streamAnswer(
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  signal?: AbortSignal
): Promise<{ text: string; usage?: Usage }> {
  if (!config.deepseekApiKey) {
    throw new Error("Missing DEEPSEEK_API_KEY. Add it to .env and restart.");
  }
  const timeout = AbortSignal.timeout(50_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  return request(messages, onDelta, combined, true);
}

async function request(
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  signal: AbortSignal,
  disableThinking: boolean
): Promise<{ text: string; usage?: Usage }> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: 0.2,
    max_tokens: 640,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (disableThinking) body.thinking = { type: "disabled" };

  const res = await fetch(`${config.deepseekBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.deepseekApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    if (disableThinking && res.status === 400 && /thinking/i.test(errText)) {
      return request(messages, onDelta, signal, false);
    }
    throw new Error(shortError(res.status, errText));
  }

  if (!res.body) throw new Error("DeepSeek returned an empty body.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage: Usage | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let json: DeltaChunk;
      try {
        json = JSON.parse(data) as DeltaChunk;
      } catch {
        continue;
      }
      const delta = json.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) {
        text += delta;
        onDelta(delta);
      }
      if (json.usage) {
        usage = {
          promptTokens: json.usage.prompt_tokens ?? 0,
          completionTokens: json.usage.completion_tokens ?? 0,
        };
      }
    }
  }

  if (!text.trim()) throw new Error("DeepSeek returned an empty reply.");
  return { text, usage };
}

function shortError(status: number, body: string): string {
  if (status === 401 || status === 403) return "DeepSeek rejected the API key.";
  if (status === 402) return "The DeepSeek account has no balance.";
  if (status === 429) return "DeepSeek rate limit. Wait a moment and try again.";
  const clipped = body.replace(/\s+/g, " ").slice(0, 280);
  return `DeepSeek error ${status}: ${clipped}`;
}
