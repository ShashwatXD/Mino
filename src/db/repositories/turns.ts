import type { DatabaseSync } from "node:sqlite";
import type { Source, Turn, TurnStatus } from "../../domain/turn.ts";

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

const toTurn = (r: Row): Turn => ({
  id: r.id,
  threadId: r.thread_id,
  createdAt: r.created_at,
  userText: r.user_text,
  assistantText: r.assistant_text,
  sources: JSON.parse(r.sources),
  queries: JSON.parse(r.queries),
  status: r.status as TurnStatus,
});

/** Log of what was asked, answered and read, each stamped with when. Turns only leave it when the user deletes their chat. */
export class TurnRepository {
  constructor(private db: DatabaseSync) {}

  save(turn: Omit<Turn, "id">): number {
    const result = this.db
      .prepare(
        `INSERT INTO turns (thread_id, created_at, user_text, assistant_text, sources, queries, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(turn.threadId, turn.createdAt, turn.userText, turn.assistantText, JSON.stringify(turn.sources), JSON.stringify(turn.queries), turn.status);
    const id = Number(result.lastInsertRowid);
    this.db.prepare(`INSERT INTO turns_tri (rowid, user_text, assistant_text) VALUES (?, ?, ?)`).run(id, turn.userText, turn.assistantText);
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
    const rows = this.db.prepare(`SELECT id, assistant_text FROM turns WHERE status = 'streaming'`).all() as { id: number; assistant_text: string }[];
    for (const row of rows) {
      this.db.prepare(`UPDATE turns SET status = 'interrupted' WHERE id = ?`).run(row.id);
      this.indexAnswer(row.id, row.assistant_text);
    }
    return rows.length;
  }

  ofThread(threadId: string, limit = 200): Turn[] {
    const rows = this.db.prepare(`SELECT * FROM turns WHERE thread_id = ? ORDER BY id DESC LIMIT ?`).all(threadId, limit) as Row[];
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

  after(threadId: string, afterId: number, limit: number): Turn[] {
    const rows = this.db
      .prepare(`SELECT * FROM turns WHERE thread_id = ? AND id > ? AND status IN ('ok', 'interrupted') ORDER BY id ASC LIMIT ?`)
      .all(threadId, afterId, limit) as Row[];
    return rows.map(toTurn);
  }

  count(threadId: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM turns WHERE thread_id = ? AND status IN ('ok', 'interrupted')`).get(threadId) as { n: number };
    return row.n;
  }
}
