import type { Limits } from "../config/config.ts";
import type { Usage } from "../llm/types.ts";
import type { UsageRepository } from "../db/repositories/usage.ts";

// US dollars per million input and output tokens. Listed prefixes are checked in order.
const PRICES: [string, number, number][] = [
  ["gemini-3.1-flash-lite", 0.25, 1.5],
  ["gemini-3.5-flash-lite", 0.25, 1.5],
  ["gemini-3.8-flash", 1.5, 7.5],
  ["gemini-3.6-flash", 1.5, 7.5],
  ["gemini-3.5-flash", 1.5, 7.5],
  ["claude-haiku-5-5", 0.1, 0.5],
  ["gpt-6-luna", 0.1, 0.5],
  ["gpt-6.1-terra", 1, 5],
  ["gpt-6.1-sol", 2, 10],
  ["gpt-6-astra", 10, 50],
  ["claude-sonnet-5-5", 2, 10],
  ["claude-opus-5-5", 4, 20],
  ["claude-opus", 5, 25],
  ["claude-fable-5-2", 8, 40],
];
// A model missing from the table is priced high, so the limit errs towards stopping early.
const UNKNOWN_PRICE: [number, number] = [10, 50];
const COST_PER_SEARCH = 0.014;

export function costOf(usage: Usage): number {
  const known = PRICES.find(([prefix]) => usage.model.replace(/^models\//, "").startsWith(prefix));
  const [input, output] = known ? [known[1], known[2]] : UNKNOWN_PRICE;
  return (usage.inputTokens * input + usage.outputTokens * output) / 1_000_000 + usage.searches * COST_PER_SEARCH;
}

/** Rough token count for replies that ended before the provider reported usage. */
export const estimateTokens = (chars: number) => Math.ceil(chars / 4);

export class SpendGuard {
  private recent: number[] = [];

  constructor(
    private usage: UsageRepository,
    private limits: Limits,
    private now: () => number = Date.now,
  ) {}

  private day(): string {
    return new Date(this.now()).toLocaleDateString("en-CA");
  }

  /** Returns the reason to refuse this message, or null and counts it. */
  admit(otherRunning: number): string | null {
    const now = this.now();
    if (otherRunning >= this.limits.maxConcurrent) return "Another reply is still running. Please wait for it to finish.";

    this.recent = this.recent.filter((at) => now - at < 60_000);
    if (this.recent.length >= this.limits.maxPerMinute) return "That's a lot of messages at once. Please wait a minute and try again.";

    const today = this.usage.get(this.day());
    const budget = this.limits.dailyBudgetUsd.toFixed(2);
    if (today.costUsd >= this.limits.dailyBudgetUsd) {
      return `Today's $${budget} spending limit is used up. It resets tomorrow, or raise DAILY_BUDGET_USD in .env.`;
    }
    if (today.messages >= this.limits.maxPerDay) {
      return `Today's limit of ${this.limits.maxPerDay} messages is used up. It resets tomorrow, or raise MAX_MESSAGES_PER_DAY in .env.`;
    }

    this.recent.push(now);
    this.usage.add(this.day(), 0, 1);
    return null;
  }

  /** Background work checks this, since nobody is waiting on it and it can simply skip. */
  overBudget(): boolean {
    return this.usage.get(this.day()).costUsd >= this.limits.dailyBudgetUsd;
  }

  record(usage: Usage): void {
    this.usage.add(this.day(), costOf(usage), 0);
  }

  status() {
    const today = this.usage.get(this.day());
    return {
      spentUsd: today.costUsd,
      limitUsd: this.limits.dailyBudgetUsd,
      messages: today.messages,
      maxMessages: this.limits.maxPerDay,
    };
  }
}
