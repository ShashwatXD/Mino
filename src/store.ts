import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface Source {
  url: string;
  title: string;
  pageAge?: string;
  cited: boolean;
}

export interface Fact {
  key: string;
  value: string;
  statedAt: number;
}

export interface RecentChat {
  threadId: string;
  title: string;
  summary: string | null;
  updatedAt: number;
}

export type TurnStatus = "ok" | "streaming" | "interrupted" | "failed";

export interface Turn {
  id: number;
  threadId: string;
  createdAt: number;
  userText: string;
  assistantText: string;
  sources: Source[];
  queries: string[];
  status: TurnStatus;
}

type Row = {
  id: number;
  thread_id: string;
  created_at: number;
  user_text: string;
  assistant_text: string;
  sources: string;
  queries: string;
  status: string;
};

function toTurn(r: Row): Turn {
  return {
    id: r.id,
    threadId: r.thread_id,
    createdAt: r.created_at,
    userText: r.user_text,
    assistantText: r.assistant_text,
    sources: JSON.parse(r.sources),
    queries: JSON.parse(r.queries),
    status: r.status as TurnStatus,
  };
}

/** Log of what was asked, answered and read, each stamped with when. Turns only leave it when the user deletes their chat. */
export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        user_text TEXT NOT NULL,
        assistant_text TEXT NOT NULL,
        sources TEXT NOT NULL,
        queries TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS turns_created ON turns(created_at);
      CREATE INDEX IF NOT EXISTS turns_thread ON turns(thread_id, id);
      DROP TABLE IF EXISTS turns_fts;
      CREATE VIRTUAL TABLE IF NOT EXISTS turns_tri USING fts5(user_text, assistant_text, tokenize='trigram');
      DROP TABLE IF EXISTS embeddings;
      CREATE TABLE IF NOT EXISTS chat_summaries (thread_id TEXT PRIMARY KEY, text TEXT NOT NULL, covered_turn_id INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_daily (day TEXT PRIMARY KEY, cost_usd REAL NOT NULL, messages INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS facts (key TEXT PRIMARY KEY, value TEXT NOT NULL, stated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pinned_threads (thread_id TEXT PRIMARY KEY, pinned_at INTEGER NOT NULL);
    `);
    this.db.exec(`
      INSERT INTO turns_tri (rowid, user_text, assistant_text)
      SELECT id, user_text, assistant_text FROM turns WHERE id NOT IN (SELECT rowid FROM turns_tri);
    `);
  }

  save(turn: Omit<Turn, "id">): number {
    const result = this.db
      .prepare(
        `INSERT INTO turns (thread_id, created_at, user_text, assistant_text, sources, queries, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        turn.threadId,
        turn.createdAt,
        turn.userText,
        turn.assistantText,
        JSON.stringify(turn.sources),
        JSON.stringify(turn.queries),
        turn.status,
      );
    const id = Number(result.lastInsertRowid);
    this.db
      .prepare(`INSERT INTO turns_tri (rowid, user_text, assistant_text) VALUES (?, ?, ?)`)
      .run(id, turn.userText, turn.assistantText);
    return id;
  }

  /** Records the question before the model runs, so a crash cannot lose it. */
  begin(threadId: string, createdAt: number, userText: string): number {
    return this.save({ threadId, createdAt, userText, assistantText: "", sources: [], queries: [], status: "streaming" });
  }

  updateDraft(id: number, assistantText: string): void {
    this.db.prepare(`UPDATE turns SET assistant_text = ? WHERE id = ? AND status = 'streaming'`).run(assistantText, id);
  }

  finish(id: number, result: { assistantText: string; sources: Source[]; queries: string[]; status: TurnStatus }): void {
    this.db
      .prepare(`UPDATE turns SET assistant_text = ?, sources = ?, queries = ?, status = ? WHERE id = ?`)
      .run(result.assistantText, JSON.stringify(result.sources), JSON.stringify(result.queries), result.status, id);
    this.indexAnswer(id, result.assistantText);
  }

  private indexAnswer(id: number, text: string): void {
    this.db.prepare(`UPDATE turns_tri SET assistant_text = ? WHERE rowid = ?`).run(text, id);
  }

  /** A row still streaming at startup belonged to a process that died mid-reply. */
  recoverInterrupted(): number {
    const rows = this.db.prepare(`SELECT id, assistant_text FROM turns WHERE status = 'streaming'`).all() as {
      id: number;
      assistant_text: string;
    }[];
    for (const row of rows) {
      this.db.prepare(`UPDATE turns SET status = 'interrupted' WHERE id = ?`).run(row.id);
      this.indexAnswer(row.id, row.assistant_text);
    }
    return rows.length;
  }

  thread(threadId: string, limit = 200): Turn[] {
    const rows = this.db
      .prepare(`SELECT * FROM turns WHERE thread_id = ? ORDER BY id DESC LIMIT ?`)
      .all(threadId, limit) as Row[];
    return rows.reverse().map(toTurn);
  }

  recent(limit: number): Turn[] {
    const rows = this.db.prepare(`SELECT * FROM turns ORDER BY created_at DESC LIMIT ?`).all(limit) as Row[];
    return rows.reverse().map(toTurn);
  }

  inWindow(start: number, end: number, limit = 20): Turn[] {
    const rows = this.db
      .prepare(`SELECT * FROM turns WHERE created_at >= ? AND created_at < ? ORDER BY created_at ASC LIMIT ?`)
      .all(start, end, limit) as Row[];
    return rows.map(toTurn);
  }

  /** One row per chat, titled by its opening question: latest pins first, then newest activity. */
  threads(limit = 100): { threadId: string; title: string; updatedAt: number; pinned: boolean }[] {
    const rows = this.db
      .prepare(
        `SELECT t.thread_id, t.user_text, m.last_at, p.pinned_at FROM turns t
         JOIN (SELECT thread_id, MIN(id) AS first_id, MAX(created_at) AS last_at FROM turns GROUP BY thread_id) m ON t.id = m.first_id
         LEFT JOIN pinned_threads p ON p.thread_id = t.thread_id
         ORDER BY p.pinned_at IS NULL, p.pinned_at DESC, m.last_at DESC LIMIT ?`,
      )
      .all(limit) as { thread_id: string; user_text: string; last_at: number; pinned_at: number | null }[];
    return rows.map((r) => ({ threadId: r.thread_id, title: r.user_text, updatedAt: r.last_at, pinned: r.pinned_at !== null }));
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

  /** Removes a chat for good, including its search index and summary, so recall cannot surface it again. */
  deleteThread(threadId: string): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`DELETE FROM turns_tri WHERE rowid IN (SELECT id FROM turns WHERE thread_id = ?)`).run(threadId);
      this.db.prepare(`DELETE FROM turns WHERE thread_id = ?`).run(threadId);
      this.db.prepare(`DELETE FROM chat_summaries WHERE thread_id = ?`).run(threadId);
      this.db.prepare(`DELETE FROM pinned_threads WHERE thread_id = ?`).run(threadId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Candidates that share letter sequences with any keyword, so misspellings still surface. */
  fuzzyCandidates(keywords: string[], limit = 80): Turn[] {
    const grams = new Set<string>();
    for (const word of keywords) {
      for (let i = 0; i + 3 <= word.length; i++) grams.add(word.slice(i, i + 3));
    }
    if (grams.size === 0) return [];
    const match = [...grams].map((g) => `"${g.replaceAll('"', '""')}"`).join(" OR ");
    const rows = this.db
      .prepare(
        `SELECT t.* FROM turns_tri f JOIN turns t ON t.id = f.rowid
         WHERE turns_tri MATCH ? ORDER BY bm25(turns_tri) LIMIT ?`,
      )
      .all(match, limit) as Row[];
    return rows.map(toTurn);
  }

  /** A summary still being written when its chat is deleted finds no turns here, so it is dropped. */
  saveSummary(threadId: string, text: string, coveredTurnId: number, updatedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO chat_summaries (thread_id, text, covered_turn_id, updated_at)
         SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM turns WHERE thread_id = ?)
         ON CONFLICT(thread_id) DO UPDATE SET text = excluded.text, covered_turn_id = excluded.covered_turn_id, updated_at = excluded.updated_at`,
      )
      .run(threadId, text, coveredTurnId, updatedAt, threadId);
  }

  summary(threadId: string): { text: string; coveredTurnId: number } | null {
    const row = this.db.prepare(`SELECT text, covered_turn_id FROM chat_summaries WHERE thread_id = ?`).get(threadId) as
      | { text: string; covered_turn_id: number }
      | undefined;
    return row ? { text: row.text, coveredTurnId: row.covered_turn_id } : null;
  }

  turnsAfter(threadId: string, afterId: number, limit: number): Turn[] {
    const rows = this.db
      .prepare(`SELECT * FROM turns WHERE thread_id = ? AND id > ? AND status IN ('ok', 'interrupted') ORDER BY id ASC LIMIT ?`)
      .all(threadId, afterId, limit) as Row[];
    return rows.map(toTurn);
  }

  turnCount(threadId: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM turns WHERE thread_id = ? AND status IN ('ok', 'interrupted')`).get(threadId) as { n: number };
    return row.n;
  }

  /** Other chats, newest first, each with its summary or its opening question if none exists yet. */
  recentChats(limit: number, excludeThreadId: string): RecentChat[] {
    const rows = this.db
      .prepare(
        `SELECT t.thread_id, t.user_text, m.last_at, s.text AS summary FROM turns t
         JOIN (SELECT thread_id, MIN(id) AS first_id, MAX(created_at) AS last_at FROM turns WHERE status IN ('ok', 'interrupted') GROUP BY thread_id) m ON t.id = m.first_id
         LEFT JOIN chat_summaries s ON s.thread_id = t.thread_id
         WHERE t.thread_id != ? ORDER BY m.last_at DESC LIMIT ?`,
      )
      .all(excludeThreadId, limit) as { thread_id: string; user_text: string; last_at: number; summary: string | null }[];
    return rows.map((r) => ({ threadId: r.thread_id, title: r.user_text, summary: r.summary, updatedAt: r.last_at }));
  }

  addUsage(day: string, costUsd: number, messages: number): void {
    this.db
      .prepare(
        `INSERT INTO usage_daily (day, cost_usd, messages) VALUES (?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd, messages = messages + excluded.messages`,
      )
      .run(day, costUsd, messages);
  }

  usage(day: string): { costUsd: number; messages: number } {
    const row = this.db.prepare(`SELECT cost_usd, messages FROM usage_daily WHERE day = ?`).get(day) as
      | { cost_usd: number; messages: number }
      | undefined;
    return { costUsd: row?.cost_usd ?? 0, messages: row?.messages ?? 0 };
  }

  saveFact(key: string, value: string, statedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO facts (key, value, stated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, stated_at = excluded.stated_at`,
      )
      .run(key, value, statedAt);
  }

  facts(limit = 30): Fact[] {
    const rows = this.db.prepare(`SELECT key, value, stated_at FROM facts ORDER BY stated_at DESC LIMIT ?`).all(limit) as {
      key: string;
      value: string;
      stated_at: number;
    }[];
    return rows.map((r) => ({ key: r.key, value: r.value, statedAt: r.stated_at }));
  }

  close(): void {
    this.db.close();
  }
}
