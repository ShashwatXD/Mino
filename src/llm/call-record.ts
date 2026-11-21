import type { Usage } from "./types.ts";

/** One request to a model and what came back, recorded for the traces page. Every engine fills the same shape. */
export interface LlmCallRecord {
  purpose: "answer" | "title" | "summary";
  /** Round of the answer loop, starting at 1. Each round is one API request. */
  round?: number;
  provider: string;
  model: string;
  /** performance.now() when the request was sent. */
  startedAt: number;
  durationMs: number;
  request: {
    system: string;
    messages: ReadableMessage[];
    tools: { name: string; description?: string; parameters?: unknown }[];
    settings: Record<string, unknown>;
  };
  response: {
    text: string;
    thoughts: string;
    toolCalls: { name: string; args: unknown }[];
    stopReason: string | null;
    webQueries: string[];
    sources: { url: string; title: string }[];
  };
  usage: Usage & { thinkingTokens?: number; cachedTokens?: number };
  /** The provider's own request and response, as sent and received (signatures shortened). */
  raw: { request: unknown; response: unknown };
  error?: string;
}

export interface ReadableMessage {
  role: string;
  content: string;
}

export type RecordCall = (record: LlmCallRecord) => void;

const LONG_STRING = 60_000;
const OPAQUE_KEYS = new Set(["thoughtSignature", "signature", "encrypted_content", "data"]);

/**
 * A JSON copy taken at the moment of the call, so later rounds cannot change it.
 * Opaque blobs (thought signatures, encrypted reasoning) are shortened; they carry no readable content.
 */
export function snapshot(value: unknown): unknown {
  const seen = new WeakSet<object>();
  return JSON.parse(
    JSON.stringify(value, (key, v) => {
      if (v instanceof AbortSignal) return undefined;
      if (typeof v === "string") {
        if (OPAQUE_KEYS.has(key) && v.length > 40) return `[${key}, ${v.length} chars]`;
        return v.length > LONG_STRING ? `${v.slice(0, LONG_STRING)}… [${v.length - LONG_STRING} more chars]` : v;
      }
      if (v && typeof v === "object") {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      return v;
    }) ?? "null",
  );
}

const json = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

/** One part or block of any engine's message, as readable text. */
function partText(p: any): string {
  if (p == null) return "";
  if (typeof p === "string") return p;
  // Gemini parts
  if (typeof p.text === "string") return p.thought ? `[thinking]\n${p.text}` : p.text;
  if (p.functionCall) return `→ calls ${p.functionCall.name}(${JSON.stringify(p.functionCall.args ?? {})})`;
  if (p.functionResponse) return `← result of ${p.functionResponse.name}:\n${json(p.functionResponse.response?.output ?? p.functionResponse.response)}`;
  if (p.toolCall) return `[built-in ${p.toolCall.toolType ?? "tool"}: ${JSON.stringify(p.toolCall.args ?? {})}]`;
  if (p.toolResponse) return `[built-in tool result]`;
  if (p.thoughtSignature && Object.keys(p).length === 1) return "";
  // Anthropic blocks
  switch (p.type) {
    case "thinking":
      return `[thinking]\n${p.thinking ?? ""}`;
    case "redacted_thinking":
      return "[thinking, redacted by the provider]";
    case "tool_use":
      return `→ calls ${p.name}(${JSON.stringify(p.input ?? {})})`;
    case "server_tool_use":
      return `[built-in ${p.name}: ${JSON.stringify(p.input ?? {})}]`;
    case "tool_result":
      return `← result for ${p.tool_use_id}:\n${Array.isArray(p.content) ? p.content.map(partText).join("\n") : json(p.content)}`;
    case "web_search_tool_result":
      return Array.isArray(p.content)
        ? `[web results]\n${p.content.map((r: any) => `- ${r.title ?? ""} ${r.url ?? ""}`).join("\n")}`
        : "[web search failed]";
    case "output_text":
    case "input_text":
      return p.text ?? "";
  }
  return json(p);
}

/** Any engine's message list (Gemini contents, Anthropic messages, OpenAI input items) as role + text. */
export function readableMessages(items: unknown[]): ReadableMessage[] {
  return items.map((raw: any): ReadableMessage => {
    if (Array.isArray(raw?.parts)) return { role: raw.role ?? "user", content: raw.parts.map(partText).filter(Boolean).join("\n\n") };
    if (raw?.role) {
      const content = typeof raw.content === "string" ? raw.content : Array.isArray(raw.content) ? raw.content.map(partText).filter(Boolean).join("\n\n") : json(raw.content);
      return { role: raw.role, content };
    }
    // OpenAI items that are not messages
    switch (raw?.type) {
      case "function_call":
        return { role: "assistant", content: `→ calls ${raw.name}(${raw.arguments ?? "{}"})` };
      case "function_call_output":
        return { role: "tool", content: `← result for ${raw.call_id}:\n${json(raw.output)}` };
      case "reasoning":
        return { role: "assistant", content: `[thinking]\n${(raw.summary ?? []).map((s: any) => s.text).join("\n") || "(no summary)"}` };
      case "web_search_call":
        return { role: "assistant", content: `[built-in web search: ${JSON.stringify(raw.action ?? {})}]` };
    }
    return { role: raw?.type ?? "item", content: json(raw) };
  });
}

/** Tool declarations of any engine as name, description and schema. Built-in tools keep their provider form. */
export function readableTools(tools: unknown[]): LlmCallRecord["request"]["tools"] {
  return tools.flatMap((t: any) => {
    if (Array.isArray(t?.functionDeclarations)) {
      return t.functionDeclarations.map((d: any) => ({ name: d.name, description: d.description, parameters: d.parametersJsonSchema ?? d.parameters }));
    }
    if (t?.googleSearch) return [{ name: "google_search (built-in)" }];
    if (t?.type && String(t.type).startsWith("web_search")) return [{ name: `web_search (built-in, ${t.type})` }];
    return [{ name: t?.name ?? "tool", description: t?.description, parameters: t?.input_schema ?? t?.parameters }];
  });
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
