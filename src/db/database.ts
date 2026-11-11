import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
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
  CREATE VIRTUAL TABLE IF NOT EXISTS turns_tri USING fts5(user_text, assistant_text, tokenize='trigram');
  CREATE TABLE IF NOT EXISTS chat_summaries (thread_id TEXT PRIMARY KEY, text TEXT NOT NULL, covered_turn_id INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS chat_titles (thread_id TEXT PRIMARY KEY, title TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS pinned_threads (thread_id TEXT PRIMARY KEY, pinned_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS facts (key TEXT PRIMARY KEY, value TEXT NOT NULL, stated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS traces (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, started_at INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS traces_started ON traces(started_at);
  CREATE TABLE IF NOT EXISTS usage_daily (day TEXT PRIMARY KEY, cost_usd REAL NOT NULL, messages INTEGER NOT NULL);
`;

const compiled = new Map<string, RegExp>();

/** Case-insensitive regex for SQL, so a grep runs over every stored turn instead of a recent slice. */
function regexp(source: unknown, text: unknown): number {
  if (typeof source !== "string" || typeof text !== "string") return 0;
  let pattern = compiled.get(source);
  if (!pattern) {
    if (compiled.size > 100) compiled.clear();
    pattern = new RegExp(source, "i");
    compiled.set(source, pattern);
  }
  return pattern.test(text) ? 1 : 0;
}

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  db.function("regexp", { deterministic: true }, regexp);
  return db;
}
