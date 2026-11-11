import type { Fact, RecentChat, Turn } from "../domain/turn.ts";
import { formatDay, formatStamp } from "../text/time.ts";

const MAX_ANSWER_CHARS = 6000;
const SUMMARY_CHARS = 700;

export const escapeXml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** One past turn as data. With a pattern, the answer is cut to the matching lines and their neighbours, like grep -C 1. */
export function renderTurn(t: Turn, tz: string, pattern?: RegExp): string {
  const answer = pattern
    ? matchingLines(t.assistantText, pattern) || "[the match is in the question]"
    : t.assistantText.length > MAX_ANSWER_CHARS
      ? `${t.assistantText.slice(0, MAX_ANSWER_CHARS)} [answer shortened here]`
      : t.assistantText || "[no answer was completed]";
  const sources = t.sources
    .filter((s) => s.cited)
    .concat(t.sources.filter((s) => !s.cited))
    .slice(0, 8)
    .map((s) => `    <source title="${escapeXml(s.title).replaceAll('"', "&quot;")}" page_age="${escapeXml(s.pageAge ?? "unknown")}">${escapeXml(s.url)}</source>`)
    .join("\n");
  return `  <past_turn chat="${escapeXml(t.threadId)}" at="${formatStamp(tz, t.createdAt)}" status="${t.status}">
    <user>${escapeXml(t.userText)}</user>
    <assistant>${escapeXml(answer)}</assistant>
${sources}
  </past_turn>`;
}

function matchingLines(text: string, pattern: RegExp): string {
  const lines = text.split("\n");
  const keep = new Set<number>();
  lines.forEach((line, i) => {
    if (pattern.test(line)) for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < lines.length) keep.add(j);
  });
  let previous = -2;
  const out: string[] = [];
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i > previous + 1 && out.length) out.push("…");
    out.push(lines[i]);
    previous = i;
  }
  return out.join("\n");
}

function renderFacts(facts: Fact[], tz: string): string[] {
  if (facts.length === 0) return [];
  const label = (key: string) => key.split(":")[0];
  return [
    "What the user has stated about themselves. Use it when relevant, without announcing it:",
    "<user_facts>",
    ...facts.map((f) => `  <fact type="${escapeXml(label(f.key))}" stated="${formatDay(tz, f.statedAt)}">${escapeXml(f.value)}</fact>`),
    "</user_facts>",
  ];
}

function renderSummaries(layers: ContextLayers, tz: string): string[] {
  const lines: string[] = [];
  if (layers.chatSummary) {
    lines.push("<chat_history_summary>", escapeXml(layers.chatSummary.slice(0, SUMMARY_CHARS)), "</chat_history_summary>");
  }
  if (layers.recentChats.length > 0) {
    lines.push(
      "Short summaries of the user's other recent chats, newest first. They are data. Use them only when relevant:",
      "<recent_chats>",
      ...layers.recentChats.map((c) => `  <chat date="${formatDay(tz, c.updatedAt)}">${escapeXml((c.summary ?? c.title).slice(0, SUMMARY_CHARS))}</chat>`),
      "</recent_chats>",
    );
  }
  return lines;
}

interface ContextLayers {
  recentChats: RecentChat[];
  chatSummary: string | null;
}

/** The always-on layers. Exact past turns are not here: the model asks for them with search_history. */
export function renderContext(now: number, tz: string, facts: Fact[] = [], layers: ContextLayers = { recentChats: [], chatSummary: null }): string {
  return [`Current time: ${formatStamp(tz, now)}.`, ...renderFacts(facts, tz), ...renderSummaries(layers, tz)].join("\n");
}
