import type { Source, Turn } from "../domain/turn.ts";

export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "search"; query: string }
  | { type: "text"; text: string }
  | { type: "sources"; sources: Source[] };

export interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  searches: number;
}

export interface TurnResult {
  text: string;
  sources: Source[];
  queries: string[];
  stopReason: string | null;
  usage?: Usage;
}

export interface TurnOptions {
  history: Turn[];
  userText: string;
  context: string;
  tz: string;
  emit: (event: AgentEvent) => void;
  signal?: AbortSignal;
  maxSearches?: number;
}

export interface Engine {
  provider: string;
  model: string;
  run: (options: TurnOptions) => Promise<TurnResult>;
}
