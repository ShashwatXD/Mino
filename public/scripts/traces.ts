interface Message { role: string; content: string }
interface LlmDetail {
  kind: "llm"; purpose: string; round?: number; provider: string; model: string; durationMs: number; costUsd: number; error?: string;
  request: { system: string; messages: Message[]; tools: { name: string; description?: string; parameters?: unknown }[]; settings: Record<string, unknown> };
  response: { text: string; thoughts: string; toolCalls: { name: string; args: unknown }[]; stopReason: string | null; webQueries: string[]; sources: { url: string; title: string }[] };
  usage: { inputTokens: number; outputTokens: number; searches: number; thinkingTokens?: number; cachedTokens?: number };
  raw: { request: unknown; response: unknown };
}
type Detail =
  | LlmDetail
  | { kind: "tool"; server: string; tool: string; arguments: unknown; result: string }
  | { kind: "history"; query: Record<string, unknown>; result: string }
  | { kind: "prompt"; context: string; historyTurns: number }
  | { kind: "web_search"; query: string };
interface SpanView { name: string; startMs: number; durationMs: number; attributes: Record<string, string | number | boolean>; detail?: Detail }
interface TraceView {
  id: string; threadId: string; startedAt: number; question: string; model: string;
  status: "ok" | "interrupted" | "failed" | "timed_out";
  firstTokenMs: number | null; totalMs: number; inputTokens: number; outputTokens: number;
  webSearches: number; historyCalls: number; llmCalls?: number; toolCalls?: number; costUsd: number; spans?: SpanView[];
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const seconds = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`);
const dollars = (usd: number) => `$${usd.toFixed(usd < 0.01 ? 4 : 3)}`;
const when = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

function summary(traces: TraceView[]): void {
  const firsts = traces.flatMap((t) => (t.firstTokenMs === null ? [] : [t.firstTokenMs]));
  const items: [string, string][] = [
    ["Replies", String(traces.length)],
    ["Median first text", seconds(median(firsts))],
    ["Median total", seconds(median(traces.map((t) => t.totalMs)))],
    ["Spent", dollars(traces.reduce((n, t) => n + t.costUsd, 0))],
  ];
  $("summary").replaceChildren(...items.map(([label, value]) => {
    const box = make("div");
    box.append(make("strong", "", value), make("span", "mono", label));
    return box;
  }));
}

function list(traces: TraceView[]): void {
  const table = $<HTMLTableElement>("list");
  const head = make("tr");
  for (const label of ["When", "Question", "Model", "First text", "Total", "LLM calls", "Tools", "History", "Web", "Cost", "Status"]) head.append(make("th", "mono", label));
  table.replaceChildren(head);
  if (!traces.length) {
    const row = make("tr");
    const cell = make("td", "empty", "No traces yet. Ask Mino something and each reply appears here.");
    cell.colSpan = 11;
    row.append(cell);
    table.append(row);
    return;
  }
  for (const t of traces) {
    const row = make("tr");
    row.tabIndex = 0;
    row.append(
      make("td", "num", when.format(t.startedAt)),
      make("td", "question", t.question),
      make("td", "mono", t.model),
      make("td", "num", seconds(t.firstTokenMs)),
      make("td", "num", seconds(t.totalMs)),
      make("td", "num", t.llmCalls === undefined ? "—" : String(t.llmCalls)),
      make("td", "num", t.toolCalls === undefined ? "—" : String(t.toolCalls)),
      make("td", "num", String(t.historyCalls)),
      make("td", "num", String(t.webSearches)),
      make("td", "num", dollars(t.costUsd)),
    );
    const status = make("td");
    status.append(make("span", `chip ${t.status === "ok" ? "good" : "bad"}`, t.status.replace("_", " ")));
    row.append(status);
    const open = () => show(t.id, row);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
    table.append(row);
  }
}

async function show(id: string, row: HTMLElement): Promise<void> {
  document.querySelectorAll("#list tr.open").forEach((r) => r.classList.remove("open"));
  row.classList.add("open");
  const trace: TraceView = await (await fetch(`/api/trace?id=${encodeURIComponent(id)}`)).json();
  const detail = $("detail");
  detail.hidden = false;
  const total = Math.max(trace.totalMs, 1);
  const lines = (trace.spans ?? []).map((span) => {
    const line = make("div", "span-row");
    const bar = make("div", "span-track");
    const fill = make("i", span.durationMs ? "" : "point");
    fill.style.left = `${(span.startMs / total) * 100}%`;
    fill.style.width = span.durationMs ? `${Math.max((span.durationMs / total) * 100, 0.6)}%` : "";
    bar.append(fill);
    const facts = make("div", "span-facts mono", Object.entries(span.attributes).map(([k, v]) => `${k}: ${v}`).join("  ·  "));
    line.append(make("div", "span-name mono", span.name), bar, make("div", "num", span.durationMs ? `${span.durationMs} ms` : "at " + seconds(span.startMs)), facts);
    if (span.detail) {
      const more = make("div", "span-more");
      more.hidden = true;
      const toggle = make("button", "text-button span-toggle", "Show more details");
      toggle.type = "button";
      toggle.setAttribute("aria-expanded", "false");
      toggle.addEventListener("click", () => setOpen(toggle, more, more.hidden));
      line.classList.toggle("is-llm", span.detail.kind === "llm");
      line.append(toggle, more);
      // Built on first open: a long trace holds megabytes of prompts.
      (more as HTMLElement & { build?: () => void }).build = () => more.replaceChildren(...renderDetail(span.detail!));
    }
    return line;
  });
  const first = trace.firstTokenMs === null ? "" : `, first text at ${seconds(trace.firstTokenMs)}`;
  const counts = trace.llmCalls === undefined ? "" : ` ${trace.llmCalls} model ${trace.llmCalls === 1 ? "call" : "calls"}, ${trace.toolCalls ?? 0} connected tool ${trace.toolCalls === 1 ? "call" : "calls"}.`;
  const expand = make("button", "ghost mono", "Expand all");
  expand.type = "button";
  expand.addEventListener("click", () => {
    const opening = expand.textContent === "Expand all";
    detail.querySelectorAll<HTMLButtonElement>(".span-toggle").forEach((b) => setOpen(b, b.nextElementSibling as HTMLElement, opening));
    expand.textContent = opening ? "Collapse all" : "Expand all";
  });
  const head = make("div", "detail-head");
  head.append(make("h2", "", trace.question), expand);
  detail.replaceChildren(
    head,
    make("p", "aside", `${trace.model}, ${trace.inputTokens.toLocaleString()} tokens in and ${trace.outputTokens.toLocaleString()} out, ${dollars(trace.costUsd)}${first}, ${seconds(trace.totalMs)} in total.${counts}`),
    ...lines,
  );
  detail.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "nearest" });
}

function setOpen(toggle: HTMLButtonElement, more: HTMLElement, open: boolean): void {
  const target = more as HTMLElement & { build?: () => void };
  if (open && target.build) {
    target.build();
    target.build = undefined;
  }
  more.hidden = !open;
  toggle.textContent = open ? "Hide details" : "Show more details";
  toggle.setAttribute("aria-expanded", String(open));
}

const pretty = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));

/** A labelled block of preformatted text, collapsed when long. */
function block(label: string, text: string, open = true): HTMLElement {
  const box = make("details", "more-block");
  box.open = open && text.length < 4000;
  const summary = make("summary", "mono", `${label} · ${text.length.toLocaleString()} chars`);
  box.append(summary, make("pre", "", text || "(empty)"));
  return box;
}

function section(title: string, ...children: HTMLElement[]): HTMLElement {
  const box = make("section", "more-section");
  box.append(make("h3", "mono", title), ...children);
  return box;
}

function facts(pairs: [string, string | number | null | undefined][]): HTMLElement {
  const list = make("dl", "more-facts");
  for (const [k, v] of pairs) {
    if (v === undefined || v === null || v === "") continue;
    list.append(make("dt", "mono", k), make("dd", "", String(v)));
  }
  return list;
}

function copyButton(label: string, value: unknown): HTMLElement {
  const button = make("button", "ghost mono", label);
  button.type = "button";
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(pretty(value));
      button.textContent = "Copied";
    } catch {
      button.textContent = "Could not copy";
    }
    setTimeout(() => (button.textContent = label), 1500);
  });
  return button;
}

function renderDetail(d: Detail): HTMLElement[] {
  switch (d.kind) {
    case "llm":
      return renderLlm(d);
    case "tool":
      return [
        facts([["Server", d.server], ["Tool", d.tool]]),
        section("Arguments sent", block("arguments", pretty(d.arguments))),
        section("Result returned to the model", block("result", d.result)),
      ];
    case "history":
      return [section("Query", block("query", pretty(d.query))), section("Result returned to the model", block("result", d.result))];
    case "prompt":
      return [facts([["Past turns replayed", d.historyTurns]]), section("Application context sent with the message", block("context", d.context))];
    case "web_search":
      return [facts([["Query", d.query]]), make("p", "aside", "Run by the provider's built-in search. Results are in the next model call's response and sources.")];
  }
}

function renderLlm(d: LlmDetail): HTMLElement[] {
  const u = d.usage;
  const out: HTMLElement[] = [
    facts([
      ["Purpose", d.purpose === "answer" ? `answer, round ${d.round}` : d.purpose],
      ["Provider", d.provider],
      ["Model", d.model],
      ["Time", `${d.durationMs.toLocaleString()} ms`],
      ["Tokens in", u.inputTokens.toLocaleString()],
      ["Cached in", u.cachedTokens ? u.cachedTokens.toLocaleString() : null],
      ["Tokens out", u.outputTokens.toLocaleString()],
      ["Of which thinking", u.thinkingTokens ? u.thinkingTokens.toLocaleString() : null],
      ["Web searches", u.searches || null],
      ["Cost", dollars(d.costUsd)],
      ["Stop reason", d.response.stopReason],
      ["Error", d.error],
    ]),
  ];

  const messages = d.request.messages.map((m, i) => block(`${i + 1}. ${m.role}`, m.content, i === d.request.messages.length - 1));
  const tools = d.request.tools.map((t) => {
    const box = make("details", "more-block");
    box.append(make("summary", "mono", t.name), make("pre", "", [t.description ?? "", t.parameters ? pretty(t.parameters) : ""].filter(Boolean).join("\n\n") || "(provider tool, no schema)"));
    return box;
  });
  out.push(
    section(
      "Request: what Mino sent",
      block("System prompt", d.request.system, false),
      make("p", "aside", `${d.request.messages.length} messages, oldest first. The last one is new this round.`),
      ...messages,
      make("p", "aside", `${d.request.tools.length} tools offered`),
      ...tools,
      block("Settings", pretty(d.request.settings), false),
    ),
  );

  const response: HTMLElement[] = [];
  if (d.response.thoughts) response.push(block("Thinking (summary from the model)", d.response.thoughts));
  if (d.response.toolCalls.length) response.push(block("Tools it asked to run", d.response.toolCalls.map((c) => `${c.name}(${pretty(c.args)})`).join("\n\n")));
  if (d.response.webQueries.length) response.push(block("Web searches it ran", d.response.webQueries.join("\n")));
  if (d.response.text) response.push(block("Text it wrote", d.response.text));
  if (d.response.sources.length) response.push(block("Sources", d.response.sources.map((s) => `${s.title}\n  ${s.url}`).join("\n")));
  if (!response.length) response.push(make("p", "aside", d.error ? "No response: the call failed." : "The response had no text and no tool calls."));
  out.push(section("Response: what came back", ...response));

  const actions = make("div", "more-actions");
  actions.append(copyButton("Copy request JSON", d.raw.request), copyButton("Copy response JSON", d.raw.response));
  out.push(section("Raw API payloads", block("Request JSON", pretty(d.raw.request), false), block("Response JSON", pretty(d.raw.response), false), actions));
  return out;
}

(async () => {
  try {
    const traces: TraceView[] = await (await fetch("/api/traces")).json();
    summary(traces);
    list(traces);
  } catch {
    $("summary").replaceChildren(make("p", "warn", "Could not reach the server. Is it still running?"));
  }
})();

export {};
