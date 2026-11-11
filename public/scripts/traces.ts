interface SpanView { name: string; startMs: number; durationMs: number; attributes: Record<string, string | number | boolean> }
interface TraceView {
  id: string; threadId: string; startedAt: number; question: string; model: string;
  status: "ok" | "interrupted" | "failed" | "timed_out";
  firstTokenMs: number | null; totalMs: number; inputTokens: number; outputTokens: number;
  webSearches: number; historyCalls: number; costUsd: number; spans?: SpanView[];
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
  for (const label of ["When", "Question", "Model", "First text", "Total", "History", "Web", "Cost", "Status"]) head.append(make("th", "mono", label));
  table.replaceChildren(head);
  if (!traces.length) {
    const row = make("tr");
    const cell = make("td", "empty", "No traces yet. Ask Mino something and each reply appears here.");
    cell.colSpan = 9;
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
    return line;
  });
  const first = trace.firstTokenMs === null ? "" : `, first text at ${seconds(trace.firstTokenMs)}`;
  detail.replaceChildren(
    make("h2", "", trace.question),
    make("p", "aside", `${trace.model}, ${trace.inputTokens.toLocaleString()} tokens in and ${trace.outputTokens.toLocaleString()} out, ${dollars(trace.costUsd)}${first}, ${seconds(trace.totalMs)} in total.`),
    ...lines,
  );
  detail.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "nearest" });
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
