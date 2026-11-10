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
