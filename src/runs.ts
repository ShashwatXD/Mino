export type RunEvent = { type: string; [key: string]: unknown };
export type SequencedEvent = RunEvent & { seq: number };
type Listener = (event: SequencedEvent | null) => void;

/** One reply being generated. It outlives any tab watching it, and replays for late joiners. */
export class Run {
  readonly abort = new AbortController();
  private events: SequencedEvent[] = [];
  private listeners = new Set<Listener>();
  closed = false;

  constructor(readonly threadId: string) {}

  emit(event: RunEvent): void {
    if (this.closed) return;
    const sequenced = { ...event, seq: this.events.length + 1 };
    this.events.push(sequenced);
    for (const listener of this.listeners) listener(sequenced);
  }

  /** Replays everything after `after`, then follows live. A null event means the run ended. */
  subscribe(after: number, listener: Listener): () => void {
    for (const event of this.events.slice(after)) listener(event);
    if (this.closed) {
      listener(null);
      return () => {};
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.listeners) listener(null);
    this.listeners.clear();
  }
}

/** At most one reply per thread, so two tabs or a double send can never interleave. */
export class RunRegistry {
  private runs = new Map<string, Run>();

  get count(): number {
    return this.runs.size;
  }

  get(threadId: string): Run | undefined {
    return this.runs.get(threadId);
  }

  start(threadId: string): Run | null {
    if (this.runs.has(threadId)) return null;
    const run = new Run(threadId);
    this.runs.set(threadId, run);
    return run;
  }

  finish(run: Run): void {
    run.close();
    this.runs.delete(run.threadId);
  }
}
