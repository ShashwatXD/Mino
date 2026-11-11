export type SpanValue = string | number | boolean;

/** One timed step inside a reply, measured from the moment the reply started. */
export interface Span {
  name: string;
  startMs: number;
  durationMs: number;
  attributes: Record<string, SpanValue>;
}

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
  costUsd: number;
  spans: Span[];
}

export type TraceSummary = Omit<Trace, "spans">;
