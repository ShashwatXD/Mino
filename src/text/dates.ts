import { allowedTypos, withinTypos } from "./typos.ts";

// March, April, May, June and July are left out: "match" and "marsh" sit one letter from "march".
const DATE_WORDS = [
  "january", "february", "august", "september", "october", "november", "december",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "yesterday",
];

const HINGLISH_ALWAYS: Record<string, string> = {
  pichhle: "last", pichle: "last", pichhla: "last", pichla: "last", pichhli: "last", pichli: "last",
  hafte: "week", hafta: "week", mahine: "month", mahina: "month",
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
  return text
    .split(/(\s+)/)
    .map((word) => {
      const lower = word.toLowerCase().replace(/[^\p{L}]/gu, "");
      if (!lower) return word;
      if (HINGLISH_ALWAYS[lower]) return HINGLISH_ALWAYS[lower];
      if (HINGLISH_PAST_DAYS[lower] && past) return HINGLISH_PAST_DAYS[lower];
      return word.replace(/[\p{L}]+/u, fixDateTypo);
    })
    .join("");
}
