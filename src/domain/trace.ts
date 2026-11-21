export type SpanValue = string | number | boolean;

/** One timed step inside a reply, measured from the moment the reply started. */
export interface Span {
  name: string;
  startMs: number;
  durationMs: number;
  attributes: Record<string, SpanValue>;
  /** Everything about the step, shown under "Show more details": a model call's full request and response, or a tool's full input and output. */
  detail?: SpanDetail;
}

export type SpanDetail =
  | ({ kind: "llm"; costUsd: number } & Omit<import("../llm/call-record.ts").LlmCallRecord, "startedAt">)
  | { kind: "tool"; server: string; tool: string; arguments: unknown; result: string }
  | { kind: "history"; query: Record<string, unknown>; result: string }
  | { kind: "prompt"; context: string; historyTurns: number }
  | { kind: "web_search"; query: string };

/** Everything one reply did, for the traces page and the eval report. */
export interface Trace {
  id: string;
  threadId: string;
  startedAt: number;
  question: string;
  model: string;
  status: "ok" | "interrupted" | "failed" | "timed_out";
  firstTokenMs: number | null;
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
  webSearches: number;
  historyCalls: number;
  /** API requests to a model: each answer round, plus title and summary. Older traces lack it. */
  llmCalls?: number;
  /** Calls to connected (MCP) tools. */
  toolCalls?: number;
  costUsd: number;
  spans: Span[];
}

export type TraceSummary = Omit<Trace, "spans">;
