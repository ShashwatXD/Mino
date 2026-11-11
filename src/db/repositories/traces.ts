import type { DatabaseSync } from "node:sqlite";
import type { Trace, TraceSummary } from "../../domain/trace.ts";

const KEEP = 500;

export class TraceRepository {
  constructor(private db: DatabaseSync) {}

  /** A reply that ends after its chat was deleted finds no turns, so its trace is dropped. Only the newest are kept. */
  save(trace: Trace): void {
    this.db
      .prepare(`INSERT INTO traces (id, thread_id, started_at, data) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM turns WHERE thread_id = ?)`)
      .run(trace.id, trace.threadId, trace.startedAt, JSON.stringify(trace), trace.threadId);
    this.db.prepare(`DELETE FROM traces WHERE id NOT IN (SELECT id FROM traces ORDER BY started_at DESC LIMIT ?)`).run(KEEP);
  }

  list(limit = 100): TraceSummary[] {
    const rows = this.db.prepare(`SELECT data FROM traces ORDER BY started_at DESC LIMIT ?`).all(limit) as { data: string }[];
    return rows.map((r) => {
      const { spans: _spans, ...summary } = JSON.parse(r.data) as Trace;
      return summary;
    });
  }

  get(id: string): Trace | null {
    const row = this.db.prepare(`SELECT data FROM traces WHERE id = ?`).get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Trace) : null;
  }

  ofThread(threadId: string): Trace[] {
    const rows = this.db.prepare(`SELECT data FROM traces WHERE thread_id = ? ORDER BY started_at ASC`).all(threadId) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Trace);
  }
}
