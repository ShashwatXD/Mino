const NAME = String.raw`[\p{L}][\p{L}.'-]*(?:\s+[\p{L}][\p{L}.'-]*){0,2}`;
const ROLES = "engineer|developer|designer|manager|founder|student|doctor|teacher|analyst|lawyer|consultant|marketer";

const FACT_PATTERNS: { key: string; pattern: RegExp }[] = [
  { key: "name", pattern: new RegExp(String.raw`\b(?:my name is|call me)\s+(${NAME})`, "iu") },
  { key: "location", pattern: /\bI(?:'m| am)? (?:live|living|based|located) in ([^.,!?\n]{2,40})/iu },
  { key: "workplace", pattern: /\bI work (?:at|for) ([^.,!?\n]{2,50})/iu },
  { key: "role", pattern: new RegExp(String.raw`\bI(?:'m| am) an? ([\p{L} -]{0,30}?(?:${ROLES}))\b`, "iu") },
  { key: "diet", pattern: /\bI(?:'m| am)(?: a)? (vegetarian|vegan|pescatarian)\b/iu },
  { key: "allergy", pattern: /\bI(?:'m| am) allergic to ([^.,!?\n]{2,40})/iu },
];

const OPEN_ENDED: { prefix: string; pattern: RegExp }[] = [
  { prefix: "preference", pattern: /\bI (?:always )?prefer ([^.!?\n]{3,120})/iu },
  { prefix: "note", pattern: /(?:^\s*|\bplease\s+)remember(?:\s+that)?\s+([^\n]{3,200})/iu },
];

/** Catches things people state outright, using rules, so no extra model call is needed. */
export function extractFacts(text: string): { key: string; value: string }[] {
  const facts = new Map<string, string>();
  for (const sentence of text.split(/(?<=[.!?\n])\s+/)) {
    if (/\?\s*$/.test(sentence)) continue;
    for (const { key, pattern } of FACT_PATTERNS) {
      const value = sentence.match(pattern)?.[1]?.split(/\s+(?:and|but|from)\b/i)[0].trim();
      if (value && !/^not\b/i.test(value)) facts.set(key, value);
    }
    for (const { prefix, pattern } of OPEN_ENDED) {
      const match = sentence.match(pattern);
      const value = match?.[1]?.trim().replace(/[.!]+$/, "");
      if (value) facts.set(`${prefix}:${value.toLowerCase().slice(0, 40)}`, value);
    }
  }
  return [...facts].map(([key, value]) => ({ key, value }));
}
