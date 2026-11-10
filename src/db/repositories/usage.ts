import type { DatabaseSync } from "node:sqlite";

export class UsageRepository {
  constructor(private db: DatabaseSync) {}

  add(day: string, costUsd: number, messages: number): void {
    this.db
      .prepare(
        `INSERT INTO usage_daily (day, cost_usd, messages) VALUES (?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd, messages = messages + excluded.messages`,
      )
      .run(day, costUsd, messages);
  }

  get(day: string): { costUsd: number; messages: number } {
    const row = this.db.prepare(`SELECT cost_usd, messages FROM usage_daily WHERE day = ?`).get(day) as { cost_usd: number; messages: number } | undefined;
    return { costUsd: row?.cost_usd ?? 0, messages: row?.messages ?? 0 };
  }
}
