import type { Effort } from "../config/config.ts";
import type { HistoryQuery, Source, Turn } from "../domain/turn.ts";
import type { RecordCall } from "./call-record.ts";

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

/** A tool from an MCP server, described to the model like search_history. */
export interface ExternalTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface TurnOptions {
  history: Turn[];
  userText: string;
  context: string;
  tz: string;
  emit: (event: AgentEvent) => void;
  signal?: AbortSignal;
  maxSearches?: number;
  /** Overrides the configured thinking effort for this one reply. */
  effort?: Effort;
  /** The history tool's implementation. Engines only describe it to the model and pass calls through. */
  searchHistory?: (query: HistoryQuery) => string;
  /** Tools from connected MCP servers, and how to run them. Engines pass calls through. */
  tools?: ExternalTool[];
  callTool?: (name: string, args: unknown) => Promise<string>;
  /** Called once per API request with everything sent and received, for the traces page. */
  onLlmCall?: RecordCall;
}

export interface Engine {
  provider: string;
  model: string;
  run: (options: TurnOptions) => Promise<TurnResult>;
}
