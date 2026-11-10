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

/** Append-only log of what was asked, answered and read, each stamped with when. */
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
      CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(user_text, assistant_text);
      CREATE VIRTUAL TABLE IF NOT EXISTS turns_tri USING fts5(user_text, assistant_text, tokenize='trigram');
      CREATE TABLE IF NOT EXISTS usage_daily (day TEXT PRIMARY KEY, cost_usd REAL NOT NULL, messages INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS facts (key TEXT PRIMARY KEY, value TEXT NOT NULL, stated_at INTEGER NOT NULL);
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
      .prepare(`INSERT INTO turns_fts (rowid, user_text, assistant_text) VALUES (?, ?, ?)`)
      .run(id, turn.userText, turn.assistantText);
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
    this.db.prepare(`UPDATE turns_fts SET assistant_text = ? WHERE rowid = ?`).run(text, id);
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

  search(keywords: string[], limit = 10): Turn[] {
    if (keywords.length === 0) return [];
    const match = keywords.map((k) => `"${k.replaceAll('"', '""')}"`).join(" OR ");
    const rows = this.db
      .prepare(
        `SELECT t.* FROM turns_fts f JOIN turns t ON t.id = f.rowid
         WHERE turns_fts MATCH ? ORDER BY bm25(turns_fts) LIMIT ?`,
      )
      .all(match, limit) as Row[];
    return rows.map(toTurn);
  }

  /** One row per chat, newest activity first, titled by its opening question. */
  threads(limit = 100): { threadId: string; title: string; updatedAt: number }[] {
    const rows = this.db
      .prepare(
        `SELECT t.thread_id, t.user_text, m.last_at FROM turns t
         JOIN (SELECT thread_id, MIN(id) AS first_id, MAX(created_at) AS last_at FROM turns GROUP BY thread_id) m ON t.id = m.first_id
         ORDER BY m.last_at DESC LIMIT ?`,
      )
      .all(limit) as { thread_id: string; user_text: string; last_at: number }[];
    return rows.map((r) => ({ threadId: r.thread_id, title: r.user_text, updatedAt: r.last_at }));
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
