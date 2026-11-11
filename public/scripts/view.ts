interface Source { url: string; title: string; cited: boolean; pageAge?: string }
interface SavedTurn { id: number; threadId: string; createdAt: number; userText: string; assistantText: string; sources: Source[]; status: "ok" | "streaming" | "interrupted" | "failed" }
interface AnswerView { wrap: HTMLElement; status: HTMLElement; answer: HTMLElement; sources: HTMLElement }

/** Every id it is called with exists in the page markup, so the element is never missing. */
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const messages = $("messages"), log = $("log"), input = $<HTMLTextAreaElement>("input"), send = $<HTMLButtonElement>("send");
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const SETUP_COMMAND = 'echo "GEMINI_API_KEY=your_key_here" > .env && npm run dev';

const readThread = () => { try { return localStorage.getItem("threadId"); } catch { return null; } };
const writeThread = (id: string | null) => { try { id ? localStorage.setItem("threadId", id) : localStorage.removeItem("threadId"); } catch {} };

let threadId: string | null = readThread();
// A temporary chat is kept out of the sidebar, the address bar, storage and Mino's memory.
let temporary = false;
// Asks the model to think harder on the messages sent while it is on.
let thinkMore = false;
let configured = true;
let lastDay: string | null = null;

const format = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: timezone, ...options });
const dayFormat = format({ weekday: "short", day: "numeric", month: "short", year: "numeric" });
const timeFormat = format({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const clockFormat = format({ weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function dayLabel(at: number): string {
  const day = dayFormat.format(at), now = Date.now();
  if (day === dayFormat.format(now)) return "Today";
  if (day === dayFormat.format(now - 86400000)) return "Yesterday";
  return day;
}

function tickClock() { $("clock").textContent = clockFormat.format(Date.now()) + " · " + timezone; }

const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 120;
const toBottom = () => { log.scrollTop = log.scrollHeight; };
const html = (text: string) => DOMPurify.sanitize(marked.parse(text));

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function addDayIfNew(at: number): void {
  const key = dayFormat.format(at);
  if (key === lastDay) return;
  lastDay = key;
  messages.append(el("div", "day mono", dayLabel(at)));
}

function addUser(text: string, at: number): void {
  document.body.classList.remove("is-empty");
  addDayIfNew(at);
  const wrap = el("div", "msg mine");
  wrap.append(el("div", "bubble", text), el("div", "stamp mono", timeFormat.format(at)));
  messages.append(wrap);
}

function addAnswer(): AnswerView {
  const wrap = el("div", "msg");
  const status = el("div", "status mono");
  const answer = el("div", "answer"), sources = el("div", "sources");
  wrap.append(status, answer, sources);
  messages.append(wrap);
  return { wrap, status, answer, sources };
}

function renderSources(node: HTMLElement, list: Source[]): void {
  node.replaceChildren();
  const cited = list.filter((s) => s.cited);
  (cited.length ? cited : list).slice(0, 8).forEach((s, i) => {
    let url;
    try { url = new URL(s.url); } catch { return; }
    if (!/^https?:$/.test(url.protocol)) return;
    const a = el("a", "mono");
    a.href = url.href; a.target = "_blank"; a.rel = "noopener noreferrer"; a.title = s.title || url.href;
    const name = url.hostname.includes("vertexaisearch") ? (s.title || "source") : url.hostname.replace(/^www\./, "");
    a.textContent = String(i + 1).padStart(2, "0") + " " + name;
    node.append(a);
  });
}
