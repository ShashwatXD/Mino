import { allowedTypos, withinTypos } from "./typos.ts";

// March, April, May, June and July are left out: "match" and "marsh" sit one letter from "march".
const DATE_WORDS = [
  "january", "february", "august", "september", "october", "november", "december",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "yesterday",
];

function fixDateTypo(word: string): string {
  const lower = word.toLowerCase();
  if (word.length < 6 || DATE_WORDS.includes(lower)) return word;
  for (const target of DATE_WORDS) {
    if (lower[0] === target[0] && withinTypos(lower, target, allowedTypos(target))) return target;
  }
  return word;
}

/** Fixes misspelled date words so the date parser understands them. */
export function normalizeDates(text: string): string {
  return text
    .split(/(\s+)/)
    .map((word) => {
      const lower = word.toLowerCase().replace(/[^\p{L}]/gu, "");
      if (!lower) return word;
      return word.replace(/[\p{L}]+/u, fixDateTypo);
    })
    .join("");
}
