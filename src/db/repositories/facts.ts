import type { DatabaseSync } from "node:sqlite";
import type { Fact } from "../../domain/turn.ts";

export class FactRepository {
  constructor(private db: DatabaseSync) {}

  /** One value per key, so a newer statement replaces the older one. */
  save(key: string, value: string, statedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO facts (key, value, stated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, stated_at = excluded.stated_at`,
      )
      .run(key, value, statedAt);
  }

  list(limit = 30): Fact[] {
    const rows = this.db.prepare(`SELECT key, value, stated_at FROM facts ORDER BY stated_at DESC LIMIT ?`).all(limit) as {
      key: string;
      value: string;
      stated_at: number;
    }[];
    return rows.map((r) => ({ key: r.key, value: r.value, statedAt: r.stated_at }));
  }
}
