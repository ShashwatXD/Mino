import { randomUUID } from "node:crypto";
import type { HistoryQuery } from "../domain/turn.ts";
import type { Span, SpanDetail, SpanValue, Trace } from "../domain/trace.ts";
import type { LlmCallRecord } from "../llm/call-record.ts";
import type { Usage } from "../llm/types.ts";
import { costOf } from "./spend-guard.ts";

/** Records one reply as timed spans. Kept in memory until the reply ends, then saved once. */
export class TraceRecorder {
  /** Fixed at the start, so the trace can be saved again when late steps finish. */
  readonly id = randomUUID();
  private readonly started = performance.now();
  private readonly spans: Span[] = [];
  private firstToken: number | null = null;
  private webSearches = 0;
  private historyCalls = 0;
  private toolCalls = 0;
  private llmCalls = 0;
  private extraCost = 0;

  constructor(
    private readonly threadId: string,
    private readonly question: string,
    private readonly startedAt: number,
  ) {}

  private elapsed(): number {
    return Math.round(performance.now() - this.started);
  }

  /** Times synchronous work and records what it reports about itself. */
  step<T>(name: string, work: () => T, describe: (result: T) => Record<string, SpanValue> = () => ({}), detail?: (result: T) => SpanDetail): T {
    const startMs = this.elapsed();
    const result = work();
    this.spans.push({ name, startMs, durationMs: this.elapsed() - startMs, attributes: describe(result), ...(detail ? { detail: detail(result) } : {}) });
    return result;
  }

  /** Times async work. A failure is recorded and then rethrown. */
  async stepAsync<T>(name: string, work: () => Promise<T>, describe: (result: T) => Record<string, SpanValue> = () => ({})): Promise<T> {
    const startMs = this.elapsed();
    try {
      const result = await work();
      this.spans.push({ name, startMs, durationMs: this.elapsed() - startMs, attributes: describe(result) });
      return result;
    } catch (err) {
      this.spans.push({ name, startMs, durationMs: this.elapsed() - startMs, attributes: { error: err instanceof Error ? err.message : String(err) } });
      throw err;
    }
  }

  firstText(): void {
    this.firstToken ??= this.elapsed();
  }

  webSearch(query: string): void {
    this.webSearches++;
    this.spans.push({ name: "web_search", startMs: this.elapsed(), durationMs: 0, attributes: { query }, detail: { kind: "web_search", query } });
  }

  history(query: HistoryQuery, result: string, durationMs: number): void {
    this.historyCalls++;
    const attributes: Record<string, SpanValue> = { result: result.split("\n")[0].slice(0, 160) };
    const asked: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      attributes[key] = value;
      asked[key] = value;
    }
    this.spans.push({ name: "search_history", startMs: this.elapsed() - durationMs, durationMs, attributes, detail: { kind: "history", query: asked, result } });
  }

  /** One call to a connected (MCP) tool: what was asked and the first line of what came back. */
  tool(name: string, args: unknown, result: string, durationMs: number): void {
    const attributes: Record<string, SpanValue> = { result: result.split("\n")[0].slice(0, 160) };
    if (args && typeof args === "object") {
      for (const [key, value] of Object.entries(args)) {
        if (value !== undefined && value !== null) attributes[key] = typeof value === "object" ? JSON.stringify(value).slice(0, 160) : (value as SpanValue);
      }
    }
    this.toolCalls++;
    const [server, ...rest] = name.split("__");
    this.spans.push({ name, startMs: this.elapsed() - durationMs, durationMs, attributes, detail: { kind: "tool", server, tool: rest.join("__"), arguments: args ?? {}, result } });
  }

  /** One API request to a model, with everything sent and received. */
  llmCall(record: LlmCallRecord): void {
    this.llmCalls++;
    this.spans.push(this.llmSpan(record));
  }

  private llmSpan(record: LlmCallRecord): Span {
    const { startedAt, ...rest } = record;
    const asked = record.response.toolCalls.map((c) => c.name).join(", ");
    const attributes: Record<string, SpanValue> = {
      model: record.model,
      in: record.usage.inputTokens,
      out: record.usage.outputTokens,
    };
    if (record.usage.thinkingTokens) attributes.thinking = record.usage.thinkingTokens;
    if (asked) attributes.asked_for = asked;
    else if (record.response.text) attributes.wrote = `${record.response.text.length} chars`;
    if (record.response.webQueries.length) attributes.web = record.response.webQueries.join(" | ");
    if (record.response.stopReason) attributes.stop = record.response.stopReason;
    if (record.error) attributes.error = record.error.slice(0, 160);
    const name = record.purpose === "answer" ? `llm · round ${record.round ?? "?"}` : `llm · ${record.purpose}`;
    return {
      name,
      startMs: Math.max(0, Math.round(startedAt - this.started)),
      durationMs: record.durationMs,
      attributes,
      detail: { kind: "llm", costUsd: Number(costOf(record.usage).toFixed(6)), ...rest },
    };
  }

  /** A model call that finished after the trace was saved (the chat summary), added to the saved trace. */
  late(trace: Trace, record: LlmCallRecord): Trace {
    const cost = costOf(record.usage);
    return {
      ...trace,
      llmCalls: (trace.llmCalls ?? 0) + 1,
      costUsd: Number((trace.costUsd + cost).toFixed(5)),
      spans: [...trace.spans, this.llmSpan(record)].sort((a, b) => a.startMs - b.startMs),
    };
  }

  smallModel(usage: Usage): void {
    this.extraCost += costOf(usage);
  }

  finish(status: Trace["status"], model: string, usage?: Usage): Trace {
    return {
      id: this.id,
      threadId: this.threadId,
      startedAt: this.startedAt,
      question: this.question.slice(0, 500),
      model,
      status,
      firstTokenMs: this.firstToken,
      totalMs: this.elapsed(),
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      webSearches: this.webSearches,
      historyCalls: this.historyCalls,
      llmCalls: this.llmCalls,
      toolCalls: this.toolCalls,
      costUsd: Number(((usage ? costOf(usage) : 0) + this.extraCost).toFixed(5)),
      spans: [...this.spans].sort((a, b) => a.startMs - b.startMs),
    };
  }
}
