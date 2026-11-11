import { randomUUID } from "node:crypto";
import type { HistoryQuery } from "../domain/turn.ts";
import type { Span, SpanValue, Trace } from "../domain/trace.ts";
import type { Usage } from "../llm/types.ts";
import { costOf } from "./spend-guard.ts";

/** Records one reply as timed spans. Kept in memory until the reply ends, then saved once. */
export class TraceRecorder {
  private readonly started = performance.now();
  private readonly spans: Span[] = [];
  private firstToken: number | null = null;
  private webSearches = 0;
  private historyCalls = 0;
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
  step<T>(name: string, work: () => T, describe: (result: T) => Record<string, SpanValue> = () => ({})): T {
    const startMs = this.elapsed();
    const result = work();
    this.spans.push({ name, startMs, durationMs: this.elapsed() - startMs, attributes: describe(result) });
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
    this.spans.push({ name: "web_search", startMs: this.elapsed(), durationMs: 0, attributes: { query } });
  }

  history(query: HistoryQuery, result: string, durationMs: number): void {
    this.historyCalls++;
    const attributes: Record<string, SpanValue> = { result: result.split("\n")[0].slice(0, 160) };
    for (const [key, value] of Object.entries(query)) if (value !== undefined) attributes[key] = value;
    this.spans.push({ name: "search_history", startMs: this.elapsed() - durationMs, durationMs, attributes });
  }

  smallModel(usage: Usage): void {
    this.extraCost += costOf(usage);
  }

  finish(status: Trace["status"], model: string, usage?: Usage): Trace {
    return {
      id: randomUUID(),
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
      costUsd: Number(((usage ? costOf(usage) : 0) + this.extraCost).toFixed(5)),
      spans: [...this.spans].sort((a, b) => a.startMs - b.startMs),
    };
  }
}
