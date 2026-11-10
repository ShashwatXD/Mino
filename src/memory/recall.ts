import type { TurnRepository } from "../db/repositories/turns.ts";
import type { Turn } from "../domain/turn.ts";
import { normalizeDates } from "../text/dates.ts";
import { resolveTimeRefs, rangeRef, type TimeRef } from "../text/time.ts";
import { allowedTypos, withinTypos } from "../text/typos.ts";

const MAX_RECALLED = 6;
const MAX_RELATED = 3;
const STRONG_COVERAGE = 0.6;
const WEAK_COVERAGE = 0.34;

const STOPWORDS = new Set(
  `a about after again all also am an and any are as ask asked asking at be been before big but by can changed
  correct could did do does for from get got had has have how i if in into is it its last me my of on one or our
  shipped since so some something still tell than that the their them then there these they this to today told
  us was we were what when which who why will with would you your them monday tuesday wednesday thursday friday
  saturday sunday january february march april may june july august september october november december
  yesterday week month year ago answer earlier previous previously said time conversation chat talk
  kya kaise kab kaun kis woh wo yeh ye wala wali wale hai hain tha thi ko ka ki ke se mein par aur ya toh bhi nahi
  hua hui kar karo mera meri mere mujhe tum tumne aap poocha pucha puchha bola bataya baar`.split(/\s+/),
);

// A date alone says nothing about our chats: "what happened on 3 November?" is a news question.
const PAST_REFERENCE =
  /\b(i|we)\s+(asked|said|talked|discussed|compared|shortlisted|looked|searched|told|mentioned|chatted)\b|\bdid (i|we|you)\b|\byou (said|told|recommended|suggested|answered)\b|\b(our|last)\s+(\w+\s+){0,2}(chat|conversation|discussion)\b|\b(earlier|previous(ly)?|last time|since then|that answer|your answer|any of them)\b|\bstill (correct|true|valid|accurate)\b|\b(poocha|pucha|puchha|bola|bataya|baat|kya tha|pichli baar|pehle)\b/i;

export function keywordsOf(text: string): string[] {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}+#-]*/gu) ?? [];
  return [...new Set(tokens)].filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

function wordMatch(keyword: string, words: Set<string>): boolean {
  if (words.has(keyword)) return true;
  const allowed = allowedTypos(keyword);
  for (const word of words) {
    if (keyword.length >= 4 && word.length >= 4 && (word.startsWith(keyword) || keyword.startsWith(word))) return true;
    if (allowed > 0 && withinTypos(keyword, word, allowed)) return true;
  }
  return false;
}

interface Scored {
  turn: Turn;
  coverage: number;
  score: number;
}

/** The index finds candidates, then each is checked word by word so a shared fragment is not enough. */
function rankByTopic(turns: TurnRepository, keywords: string[]): Scored[] {
  if (keywords.length === 0) return [];
  const toWords = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}+#-]*/gu) ?? []);
  const scored = turns.fuzzyCandidates(keywords).map((turn) => {
    const asked = toWords(turn.userText);
    const answered = toWords(turn.assistantText);
    let matched = 0;
    let score = 0;
    for (const keyword of keywords) {
      if (wordMatch(keyword, asked)) {
        matched++;
        score += 1;
      } else if (wordMatch(keyword, answered)) {
        matched++;
        score += 0.6;
      }
    }
    return { turn, coverage: matched / keywords.length, score };
  });
  return scored
    .filter((s) => s.coverage >= WEAK_COVERAGE)
    .sort((a, b) => b.score - a.score || b.turn.createdAt - a.turn.createdAt);
}

export interface RequestedDate {
  phrase: string;
  label: string;
  matches: number;
}

export interface Hint {
  intent: "chat" | "new_question" | "recall" | "recheck";
  keywords: string[];
  timeRange: { from: string; to: string } | null;
}

/** Exactly one of these is true of any message, so nothing downstream has to combine flags. */
export type RecallKind =
  | "none" // not about our past chats
  | "related" // not about the past, but an older chat is clearly on topic
  | "on_date" // the requested date has chats
  | "other_date" // nothing that day, but the topic was discussed on another date
  | "topic" // about the past, found by topic
  | "latest" // about the past, names no topic or date
  | "no_record"; // about the past, and nothing was found

export interface Recall {
  kind: RecallKind;
  requested: RequestedDate | null;
  turns: Turn[];
}

const nothing = (kind: RecallKind, requested: RequestedDate | null = null): Recall => ({ kind, requested, turns: [] });

/** A message can also name "today" as when to check, so the earliest date is the one it asks about. */
function requestedWindow(normalized: string, now: number, tz: string, hint?: Hint): TimeRef | null {
  const [earliest] = resolveTimeRefs(normalized, now, tz).sort((a, b) => a.start - b.start);
  if (earliest) return earliest;
  return hint?.timeRange ? rangeRef(hint.timeRange.from, hint.timeRange.to, tz) : null;
}

/** Retrieval is deterministic code, so remembering cannot depend on the model choosing to look. */
export function recall(turns: TurnRepository, text: string, now: number, tz: string, inPrompt: Set<number>, options: { hint?: Hint } = {}): Recall {
  const { hint } = options;
  const normalized = normalizeDates(text);
  const keywords = [...new Set([...keywordsOf(normalized), ...keywordsOf((hint?.keywords ?? []).join(" "))])];
  // A turn still being written is this message, not a record of the past.
  const ranked = rankByTopic(turns, keywords).filter((s) => s.turn.status !== "streaming");

  if (!PAST_REFERENCE.test(normalized) && hint?.intent !== "recall" && hint?.intent !== "recheck") {
    const turns = ranked.filter((s) => s.coverage >= STRONG_COVERAGE && !inPrompt.has(s.turn.id)).map((s) => s.turn).slice(0, MAX_RELATED);
    return turns.length ? { kind: "related", requested: null, turns } : nothing("none");
  }

  const topical = ranked.map((s) => s.turn).slice(0, MAX_RECALLED);
  const window = requestedWindow(normalized, now, tz, hint);
  if (window) {
    const rank = new Map(ranked.map((s, i) => [s.turn.id, i]));
    const onDate = turns
      .inWindow(window.start, window.end)
      .filter((t) => t.status !== "streaming")
      .sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999) || a.createdAt - b.createdAt);
    const requested = { phrase: window.phrase, label: window.label, matches: onDate.length };
    if (onDate.length) return { kind: "on_date", requested, turns: onDate.slice(0, MAX_RECALLED) };
    return topical.length ? { kind: "other_date", requested, turns: topical } : nothing("no_record", requested);
  }

  if (topical.length) return { kind: "topic", requested: null, turns: topical };
  if (keywords.length) return nothing("no_record");
  const latest = turns.recent(MAX_RECALLED + 1).filter((t) => t.status !== "streaming").slice(-MAX_RECALLED);
  return latest.length ? { kind: "latest", requested: null, turns: latest } : nothing("no_record");
}
