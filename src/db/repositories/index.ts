import { openDatabase } from "../database.ts";
import { FactRepository } from "./facts.ts";
import { SummaryRepository } from "./summaries.ts";
import { ThreadRepository } from "./threads.ts";
import { TraceRepository } from "./traces.ts";
import { TurnRepository } from "./turns.ts";
import { UsageRepository } from "./usage.ts";

export interface Repositories {
  turns: TurnRepository;
  threads: ThreadRepository;
  summaries: SummaryRepository;
  facts: FactRepository;
  usage: UsageRepository;
  traces: TraceRepository;
  close(): void;
}

/** One connection shared by every repository, so a swap to another database touches only this layer. */
export function createRepositories(path: string): Repositories {
  const db = openDatabase(path);
  return {
    turns: new TurnRepository(db),
    threads: new ThreadRepository(db),
    summaries: new SummaryRepository(db),
    facts: new FactRepository(db),
    usage: new UsageRepository(db),
    traces: new TraceRepository(db),
    close: () => db.close(),
  };
}
