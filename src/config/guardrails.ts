/**
 * Every limit Mino enforces, in one place, each with the reason it exists.
 *
 * Each one can be changed from .env without touching code: GUARD_ plus the name in capitals,
 * e.g. GUARD_MAX_ROUNDS=3 or GUARD_HISTORY_CHARS=2000. Shrinking them is the easy way to test
 * what happens at a limit. The three spending limits keep the names they have always had in .env.
 *
 * Code reads the live values from GUARD at the moment it needs them, so main.ts applies .env
 * once at startup and tests can set any value with setGuardrails().
 */

interface Spec {
  default: number;
  min: number;
  max: number;
  /** Whole numbers only. Money is the only fractional limit. */
  integer: boolean;
  reason: string;
  /** Set only where an older .env name must keep working. */
  env?: string;
}

/** A whole-number limit: a count, a size in characters or tokens, or a time in milliseconds. */
const limit = (value: number, min: number, max: number, reason: string): Spec => ({ default: value, min, max, integer: true, reason });

const SPECS = {
  // ---- One reply ---------------------------------------------------------
  maxRounds: limit(6, 1, 20, "API requests in one reply, so a model that keeps asking for tools still has to answer."),
  maxHistoryCalls: limit(4, 0, 20, "search_history lookups in one reply, since every result is resent in each later round."),
  maxToolCalls: limit(6, 0, 30, "Calls to connected (MCP) tools in one reply; they take time and may cost money on the server's side."),
  maxWebSearches: limit(4, 0, 20, "Web searches in one reply, about $0.014 each. Claude and OpenAI enforce it; Gemini takes no limit yet."),
  maxWebSearchesRecheck: limit(8, 0, 20, "Web searches when the user asks whether something changed, because each item needs its own check."),
  maxOutputTokens: limit(8000, 256, 64000, "Output tokens per API request, thinking included, so one reply cannot write a large bill."),
  maxServerPauses: limit(2, 0, 10, "Times Claude may pause a long server-side search and resume within one reply."),
  replyTimeoutMs: limit(180_000, 5_000, 900_000, "A reply is stopped after this long, so a hung provider cannot hold it, or its cost, open."),

  // ---- Connected (MCP) tools ---------------------------------------------
  maxToolResultChars: limit(12_000, 500, 200_000, "Characters kept from one tool result, so a single call cannot flood the prompt."),
  mcpConnectTimeoutMs: limit(20_000, 1_000, 120_000, "Time an MCP server gets to start; a slow one is skipped so Mino still starts."),
  mcpCallTimeoutMs: limit(30_000, 1_000, 300_000, "Time one MCP tool call gets before the model is told it failed."),

  // ---- History search (search_history) -----------------------------------
  historyResultChars: limit(12_000, 500, 200_000, "Characters in one search_history result, the same cap as other tool results."),
  historyPageSize: limit(8, 1, 50, "Past turns per result page; the model asks for the next page when it needs more."),
  pastAnswerChars: limit(6_000, 200, 100_000, "Longest past answer shown in a search result before it is shortened."),

  // ---- What every prompt carries -----------------------------------------
  historyTurns: limit(20, 1, 200, "Newest turns of this chat read from the database before fitting them to the budget."),
  historyChars: limit(30_000, 500, 500_000, "Characters of this chat sent word for word; older turns live on in the summary and in search."),
  recentChats: limit(15, 0, 100, "Other chats listed in the prompt, so the model knows what exists before searching."),
  summaryChars: limit(700, 50, 10_000, "Characters per chat summary in the prompt."),
  maxFacts: limit(30, 0, 500, "Saved facts about the user (name, city, work) sent with every message."),

  // ---- Small model (titles and summaries) --------------------------------
  smallModelMaxTokens: limit(1024, 64, 8000, "Output tokens for a title or summary; both are a few words."),
  titleTimeoutMs: limit(3_000, 500, 60_000, "A chat title that takes longer is dropped and the first question stays as the name."),
  summaryTimeoutMs: limit(15_000, 1_000, 120_000, "A summary that takes longer is retried after the next reply."),
  summaryTurns: limit(6, 1, 50, "Turns folded into the running chat summary per update."),
  summarizedAnswerChars: limit(2_000, 200, 50_000, "Characters of each answer the summarizer reads."),

  // ---- Spending and pace (checked before any model is called) -------------
  dailyBudgetUsd: { default: 1, min: 0, max: 1000, integer: false, env: "DAILY_BUDGET_USD", reason: "New messages are refused once today's spending reaches this." },
  maxPerMinute: { ...limit(10, 1, 1000, "Messages per minute, so a stuck script or a held-down key cannot run up a bill."), env: "MAX_MESSAGES_PER_MINUTE" },
  maxPerDay: { ...limit(200, 1, 100_000, "Messages per day, a second edge beside the money budget."), env: "MAX_MESSAGES_PER_DAY" },
  maxConcurrent: limit(2, 1, 10, "Replies running at once."),
} satisfies Record<string, Spec>;

export type GuardrailName = keyof typeof SPECS;
export type Guardrails = Record<GuardrailName, number>;

const NAMES = Object.keys(SPECS) as GuardrailName[];

/** maxRounds → GUARD_MAX_ROUNDS, unless the limit keeps an older name. */
export function envName(name: GuardrailName): string {
  const spec: Spec = SPECS[name];
  return spec.env ?? `GUARD_${name.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
}

export const DEFAULT_GUARDRAILS: Readonly<Guardrails> = Object.freeze(Object.fromEntries(NAMES.map((n) => [n, SPECS[n].default])) as Guardrails);

/** The live values. Read them when needed (GUARD.maxRounds), never copy them into a module-level constant. */
export const GUARD: Guardrails = { ...DEFAULT_GUARDRAILS };

/** Values from the environment, with defaults for anything unset. Each problem names its variable. */
export function readGuardrails(env: Record<string, string | undefined>): { values: Guardrails; problems: string[] } {
  const values = { ...DEFAULT_GUARDRAILS };
  const problems: string[] = [];
  for (const name of NAMES) {
    const key = envName(name);
    const raw = env[key]?.trim();
    if (!raw) continue;
    const spec: Spec = SPECS[name];
    const value = Number(raw);
    if (!Number.isFinite(value)) problems.push(`${key}: "${raw}" is not a number`);
    else if (spec.integer && !Number.isInteger(value)) problems.push(`${key}: must be a whole number`);
    else if (value < spec.min || value > spec.max) problems.push(`${key}: must be between ${spec.min} and ${spec.max}`);
    else values[name] = value;
  }
  return { values, problems };
}

/** Replaces the live values: all of them from a full set, or only the ones given. Returns the previous values. */
export function setGuardrails(values: Partial<Guardrails>): Guardrails {
  const previous = { ...GUARD };
  Object.assign(GUARD, values);
  return previous;
}

/** Limits that differ from their defaults, as lines for the startup log. */
export function changedGuardrails(values: Guardrails = GUARD): string[] {
  return NAMES.filter((n) => values[n] !== DEFAULT_GUARDRAILS[n]).map((n) => `${envName(n)}=${values[n]} (default ${DEFAULT_GUARDRAILS[n]})`);
}

/** Every limit with its value and reason, for docs and debugging. */
export function describeGuardrails(values: Guardrails = GUARD): { name: GuardrailName; env: string; value: number; default: number; reason: string }[] {
  return NAMES.map((n) => ({ name: n, env: envName(n), value: values[n], default: DEFAULT_GUARDRAILS[n], reason: SPECS[n].reason }));
}
