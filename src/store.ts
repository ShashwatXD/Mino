import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface Source {
  url: string;
  title: string;
  pageAge?: string;
  cited: boolean;
}

export type TurnStatus = "ok" | "interrupted" | "failed";

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
    return id;
  }

  thread(threadId: string, limit = 200): Turn[] {
    const rows = this.db
      .prepare(`SELECT * FROM turns WHERE thread_id = ? ORDER BY id DESC LIMIT ?`)
      .all(threadId, limit) as Row[];
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

  close(): void {
    this.db.close();
  }
}
