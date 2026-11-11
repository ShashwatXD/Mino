import type { TurnRepository } from "../db/repositories/turns.ts";
import type { Turn } from "../domain/turn.ts";
import { allowedTypos, withinTypos } from "../text/typos.ts";

/** Share of the keywords a turn must cover: weak to appear at all, strong to stand in for another date. */
export const STRONG_COVERAGE = 0.6;
const WEAK_COVERAGE = 0.34;

const STOPWORDS = new Set(
  `a about after again all also am an and any are as ask asked asking at be been before big but by can changed
  correct could did do does for from get got had has have how i if in into is it its last me my of on one or our
  shipped since so some something still tell than that the their them then there these they those this to today told
  us was we were what when which who why will with would you your them monday tuesday wednesday thursday friday
  saturday sunday january february march april may june july august september october november december
  yesterday week month year ago answer earlier previous previously said time conversation chat talk`.split(/\s+/),
);

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
export function rankByTopic(turns: TurnRepository, keywords: string[]): Scored[] {
  if (keywords.length === 0) return [];
  const toWords = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}+#-]*/gu) ?? []);
  const scored = turns.fuzzyCandidates(keywords).map((turn) => {
    const asked = toWords(turn.userText);
    const answered = toWords(turn.assistantText);
    // Long answers contain many common words, so a keyword found only there counts for half.
    let covered = 0;
    let score = 0;
    for (const keyword of keywords) {
      if (wordMatch(keyword, asked)) {
        covered += 1;
        score += 1;
      } else if (wordMatch(keyword, answered)) {
        covered += 0.5;
        score += 0.6;
      }
    }
    return { turn, coverage: covered / keywords.length, score };
  });
  return scored
    .filter((s) => s.coverage >= WEAK_COVERAGE)
    .sort((a, b) => b.score - a.score || b.turn.createdAt - a.turn.createdAt);
}
