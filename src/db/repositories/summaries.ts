import type { DatabaseSync } from "node:sqlite";

export class SummaryRepository {
  constructor(private db: DatabaseSync) {}

  get(threadId: string): { text: string; coveredTurnId: number } | null {
    const row = this.db.prepare(`SELECT text, covered_turn_id FROM chat_summaries WHERE thread_id = ?`).get(threadId) as
      | { text: string; covered_turn_id: number }
      | undefined;
    return row ? { text: row.text, coveredTurnId: row.covered_turn_id } : null;
  }

  /** A summary still being written when its chat is deleted finds no turns here, so it is dropped. */
  save(threadId: string, text: string, coveredTurnId: number, updatedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO chat_summaries (thread_id, text, covered_turn_id, updated_at)
         SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM turns WHERE thread_id = ?)
         ON CONFLICT(thread_id) DO UPDATE SET text = excluded.text, covered_turn_id = excluded.covered_turn_id, updated_at = excluded.updated_at`,
      )
      .run(threadId, text, coveredTurnId, updatedAt, threadId);
  }
}
