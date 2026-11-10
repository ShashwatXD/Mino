import { distance } from "fastest-levenshtein";

/** The length check skips the distance work for words that cannot be close. */
export function withinTypos(a: string, b: string, max: number): boolean {
  return Math.abs(a.length - b.length) <= max && distance(a, b) <= max;
}

/** Longer words can absorb more typos. Short ones must match exactly, or everything would. */
export function allowedTypos(word: string): number {
  if (word.length <= 4) return 0;
  return word.length <= 7 ? 1 : 2;
}

// March, April, May, June and July are left out: "match" and "marsh" sit one letter from "march".
const DATE_WORDS = [
  "january", "february", "august", "september", "october", "november", "december",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "yesterday",
];

const HINGLISH_ALWAYS: Record<string, string> = {
  pichhle: "last", pichle: "last", pichhla: "last", pichla: "last", pichhli: "last", pichli: "last",
  hafte: "week", hafta: "week", mahine: "month", mahina: "month",
  somvar: "monday", somwar: "monday", somvaar: "monday", mangalvar: "tuesday", mangalwar: "tuesday",
  budhvar: "wednesday", budhwar: "wednesday", guruvar: "thursday", guruwar: "thursday",
  shukravar: "friday", shukrawar: "friday", shanivar: "saturday", shaniwar: "saturday",
  ravivar: "sunday", raviwar: "sunday", itwar: "sunday",
};

// These are also everyday names, so they only count right after "last" or right before "ko".
const HINGLISH_DAY_NAMES: Record<string, string> = {
  som: "monday", mangal: "tuesday", budh: "wednesday", guru: "thursday",
  shukra: "friday", shani: "saturday", ravi: "sunday",
};

// "kal" means both yesterday and tomorrow, so it needs a past-tense word nearby.
const HINGLISH_PAST_DAYS: Record<string, string> = { kal: "yesterday", aaj: "today", parso: "2 days ago", parson: "2 days ago" };
const PAST_TENSE = /\b(poocha|pucha|puchha|puchi|bola|bataya|kaha|baat|tha|thi|asked|said|told)\b/i;

function fixDateTypo(word: string): string {
  const lower = word.toLowerCase();
  if (word.length < 6 || DATE_WORDS.includes(lower)) return word;
  for (const target of DATE_WORDS) {
    if (lower[0] === target[0] && withinTypos(lower, target, allowedTypos(target))) return target;
  }
  return word;
}

/** Rewrites misspelled and Hinglish date words into English a date parser understands. */
export function normalizeDates(text: string): string {
  const past = PAST_TENSE.test(text);
  const words = text.split(/(\s+)/);
  return words
    .map((word, i) => {
      const lower = word.toLowerCase().replace(/[^\p{L}]/gu, "");
      if (!lower) return word;
      const before = (words[i - 2] ?? "").toLowerCase();
      const after = (words[i + 2] ?? "").toLowerCase().replace(/[^\p{L}]/gu, "");
      if (HINGLISH_ALWAYS[lower]) return HINGLISH_ALWAYS[lower];
      if (HINGLISH_DAY_NAMES[lower] && (after === "ko" || before === "last" || before in HINGLISH_ALWAYS)) return HINGLISH_DAY_NAMES[lower];
      if (HINGLISH_PAST_DAYS[lower] && past) return HINGLISH_PAST_DAYS[lower];
      return word.replace(/[\p{L}]+/u, fixDateTypo);
    })
    .join("");
}
