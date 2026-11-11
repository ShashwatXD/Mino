import type { DatabaseSync } from "node:sqlite";
import type { ChatListItem, RecentChat } from "../../domain/turn.ts";

const FIRST_AND_LAST = `SELECT thread_id, MIN(id) AS first_id, MAX(created_at) AS last_at FROM turns`;

/** A chat is the set of turns sharing a thread id, plus its title and pin. */
export class ThreadRepository {
  constructor(private db: DatabaseSync) {}

  /** Named by its title or else its opening question: latest pins first, then newest activity. */
  list(limit = 100): ChatListItem[] {
    const rows = this.db
      .prepare(
        `SELECT t.thread_id, COALESCE(c.title, t.user_text) AS title, m.last_at, p.pinned_at FROM turns t
         JOIN (${FIRST_AND_LAST} GROUP BY thread_id) m ON t.id = m.first_id
         LEFT JOIN chat_titles c ON c.thread_id = t.thread_id
         LEFT JOIN pinned_threads p ON p.thread_id = t.thread_id
         ORDER BY p.pinned_at IS NULL, p.pinned_at DESC, m.last_at DESC LIMIT ?`,
      )
      .all(limit) as { thread_id: string; title: string; last_at: number; pinned_at: number | null }[];
    return rows.map((r) => ({ threadId: r.thread_id, title: r.title, updatedAt: r.last_at, pinned: r.pinned_at !== null }));
  }

  /** Other chats, newest first, each with its summary once one is written. */
  recent(limit: number, excludeThreadId: string): RecentChat[] {
    const rows = this.db
      .prepare(
        `SELECT t.thread_id, COALESCE(c.title, t.user_text) AS title, m.last_at, s.text AS summary FROM turns t
         JOIN (${FIRST_AND_LAST} WHERE status IN ('ok', 'interrupted') GROUP BY thread_id) m ON t.id = m.first_id
         LEFT JOIN chat_titles c ON c.thread_id = t.thread_id
         LEFT JOIN chat_summaries s ON s.thread_id = t.thread_id
         WHERE t.thread_id != ? ORDER BY m.last_at DESC LIMIT ?`,
      )
      .all(excludeThreadId, limit) as { thread_id: string; title: string; last_at: number; summary: string | null }[];
    return rows.map((r) => ({ threadId: r.thread_id, title: r.title, summary: r.summary, updatedAt: r.last_at }));
  }

  /** Pinning a chat that has no turns does nothing, so a stale tab cannot leave an orphan pin. */
  setPinned(threadId: string, pinned: boolean, at: number): void {
    if (!pinned) {
      this.db.prepare(`DELETE FROM pinned_threads WHERE thread_id = ?`).run(threadId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO pinned_threads (thread_id, pinned_at)
         SELECT ?, ? WHERE EXISTS (SELECT 1 FROM turns WHERE thread_id = ?)
         ON CONFLICT(thread_id) DO NOTHING`,
      )
      .run(threadId, at, threadId);
  }

  /** A title still being written when its chat is deleted finds no turns here, so it is dropped. */
  saveTitle(threadId: string, title: string): void {
    this.db
      .prepare(
        `INSERT INTO chat_titles (thread_id, title) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM turns WHERE thread_id = ?)
         ON CONFLICT(thread_id) DO NOTHING`,
      )
      .run(threadId, title, threadId);
  }

  /** Removes a chat for good, including its search index, title, summary and traces, so nothing of it remains. */
  delete(threadId: string): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`DELETE FROM turns_tri WHERE rowid IN (SELECT id FROM turns WHERE thread_id = ?)`).run(threadId);
      for (const table of ["turns", "chat_summaries", "chat_titles", "pinned_threads", "traces"]) {
        this.db.prepare(`DELETE FROM ${table} WHERE thread_id = ?`).run(threadId);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
