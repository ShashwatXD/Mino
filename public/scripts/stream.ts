/** One reply being shown: where it paints, how far its events got, and how to reconnect. */
interface Stream {
  gen: number;
  threadId: string;
  view: AnswerView;
  text: string;
  temporary: boolean;
  seq: number;
  full: string;
  /** How much of `full` is on screen. Text arrives in bursts and is revealed a little each frame. */
  shown: number;
  frame: number;
  /** Set when the reply ended while text was still being revealed; runs once the reveal catches up. */
  settle?: () => void;
  retries: number;
  lastByte: number;
  local: AbortController;
  watch?: ReturnType<typeof setInterval>;
}

/** The server's events, numbered so a replay after reconnecting is harmless. */
type ReplyEvent = { seq: number } & (
  | { type: "text"; text: string }
  | { type: "search"; query: string }
  | { type: "status"; text: string }
  | { type: "sources"; sources: Source[] }
  | { type: "done" | "stopped" }
  | { type: "error"; text: string }
);

let active: Stream | null = null;
let viewGen = 0;
const channel = (() => { try { return new BroadcastChannel("mino"); } catch { return null; } })();
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const streamUrl = (id: string, after: number) => `/api/stream?threadId=${encodeURIComponent(id)}&after=${after}`;

// Bumping the generation orphans any open stream, so its late events cannot land on the next view.
function detach() {
  viewGen++;
  stopSpeaking();
  if (active) {
    clearInterval(active.watch);
    if (active.frame) cancelAnimationFrame(active.frame);
    active.local.abort();
    active = null;
  }
  setBusy(false);
}

function beginStream(view: AnswerView, id: string, text: string): Stream {
  const s: Stream = { gen: viewGen, threadId: id, view, text, temporary, seq: 0, full: "", shown: 0, frame: 0, retries: 0, lastByte: Date.now(), local: new AbortController() };
  // A silent connection (sleep, network change) is dropped and resumed from the last event seen.
  s.watch = setInterval(() => { if (Date.now() - s.lastByte > 40000) s.local.abort(); }, 10000);
  view.answer.classList.add("streaming");
  active = s;
  setBusy(true);
  return s;
}

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

function render(s: Stream): void {
  const stick = nearBottom();
  s.view.answer.innerHTML = html(s.full.slice(0, s.shown));
  if (stick) toBottom();
}

/** Shows everything received at once: on finishing, and when a hidden tab comes back. */
function paint(s: Stream): void {
  s.frame = 0;
  s.shown = s.full.length;
  render(s);
}

/**
 * Reveals buffered text one frame at a time, faster the further behind it is, so a burst
 * shows within about 200 ms and a slow stream still moves at 2 characters a frame.
 */
function revealFrame(s: Stream): void {
  s.frame = 0;
  const behind = s.full.length - s.shown;
  if (behind > 0) {
    s.shown += reducedMotion.matches ? behind : Math.max(2, Math.ceil(behind / 12));
    render(s);
  }
  if (s.shown < s.full.length) schedulePaint(s);
  else s.settle?.();
}

// Hidden tabs do not run animation frames, so painting waits for visibilitychange.
function schedulePaint(s: Stream): void {
  if (document.hidden || s.frame) return;
  s.frame = requestAnimationFrame(() => revealFrame(s));
}

function addNote(view: AnswerView, text: string, failed?: boolean): void {
  view.wrap.append(el("div", "stamp mono note" + (failed ? " failed" : ""), text));
}

function finish(s: Stream, outcome: "ok" | "stopped" | "failed", message?: string): void {
  if (s !== active) return;
  // A finished reply lets its last words flow in before the tools appear under it.
  if (outcome === "ok" && s.shown < s.full.length && !document.hidden) {
    s.settle = () => {
      s.settle = undefined;
      finish(s, outcome, message);
    };
    schedulePaint(s);
    return;
  }
  clearInterval(s.watch);
  if (s.frame) cancelAnimationFrame(s.frame);
  s.frame = 0;
  active = null;
  s.view.status.textContent = "";
  s.view.answer.classList.remove("streaming");
  paint(s);
  if (outcome !== "failed" && s.full) addAnswerTools(s.view, s.full);
  if (outcome === "stopped") addNote(s.view, s.full ? "Stopped" : "Stopped before answering");
  if (outcome === "failed") {
    const p = el("p", "failed", message);
    const parent = s.view.wrap;
    parent.append(p);
    if (s.text) {
      const retry = el("button", "ghost mono retry", "Try again");
      retry.type = "button";
      retry.addEventListener("click", () => { parent.previousElementSibling?.remove(); parent.remove(); ask(s.text); });
      parent.append(retry);
    }
  }
  setBusy(false);
  if (!s.temporary) {
    channel?.postMessage({ threadId: s.threadId });
    refreshChats();
  }
  if (!document.hidden && configured) input.focus();
}

/** Applies one event. Sequence numbers make a replay after reconnecting harmless. */
function apply(s: Stream, e: ReplyEvent): boolean {
  if (e.seq <= s.seq) return false;
  s.seq = e.seq;
  s.retries = 0;
  switch (e.type) {
    case "text": s.full += e.text; s.view.status.textContent = ""; schedulePaint(s); break;
    case "search": s.view.status.textContent = "Searching: " + e.query; break;
    case "status": s.view.status.textContent = e.text; break;
    case "sources": renderSources(s.view.sources, e.sources); break;
    case "done": finish(s, "ok"); return true;
    case "stopped": finish(s, "stopped"); return true;
    case "error": finish(s, "failed", e.text); return true;
  }
  return false;
}

async function pump(s: Stream, res: Response): Promise<boolean> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done || s.gen !== viewGen) return false;
    s.lastByte = Date.now();
    buffer += value;
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      if (!chunk.startsWith("data: ")) continue;
      if (apply(s, JSON.parse(chunk.slice(6)))) return true;
    }
  }
}

async function follow(s: Stream, first: Response | null): Promise<void> {
  let res: Response | null = first;
  for (;;) {
    if (res) {
      let ended = false;
      try { ended = await pump(s, res); } catch {}
      if (ended || s !== active || s.gen !== viewGen) return;
    }
    if (++s.retries > 6) { finish(s, "failed", "Lost connection to the server."); return; }
    s.view.status.textContent = "Reconnecting";
    await sleep(400 * s.retries);
    if (s !== active || s.gen !== viewGen) return;
    s.local = new AbortController();
    s.lastByte = Date.now();
    try {
      res = await fetch(streamUrl(s.threadId, s.seq), { signal: s.local.signal });
    } catch { res = null; continue; }
    if (s !== active || s.gen !== viewGen) return;
    // 204 means the reply ended while disconnected, so the saved turn is the truth.
    if (res.status === 204) {
      if (s.temporary) finish(s, "failed", "The connection dropped, and temporary replies are not saved to reload.");
      else loadThread(s.threadId);
      return;
    }
    if (!res.ok) res = null;
  }
}

async function ask(text: string): Promise<void> {
  if (active || !configured) return;
  messages.querySelector(".hero")?.remove();
  if (!threadId) {
    threadId = newId();
    if (!temporary) {
      history.pushState(null, "", "#" + threadId);
      writeThread(threadId);
    }
  }
  const id = threadId;
  addUser(text, Date.now());
  const view = addAnswer();
  view.status.textContent = "Thinking";
  toBottom();
  const s = beginStream(view, id, text);

  let res: Response;
  try {
    res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: id, message: text, timezone, incognito: temporary, thinkMore }),
      signal: s.local.signal,
    });
  } catch {
    if (s === active) finish(s, "failed", "Could not reach the server. Is it still running?");
    return;
  }
  if (s !== active) return;
  if (res.status === 409) {
    // Another tab is answering in this chat: keep what was typed and show its reply.
    input.value = text;
    sizeInput();
    loadThread(id);
    return;
  }
  if (!res.ok || !res.body) {
    finish(s, "failed", (await res.text().catch(() => "")) || "The request failed.");
    return;
  }
  if (!temporary) {
    channel?.postMessage({ threadId: id });
    refreshChats();
  }
  follow(s, res);
}

function stop() {
  if (!active) return;
  send.disabled = true;
  fetch("/api/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadId: active.threadId }),
  }).catch(() => { send.disabled = false; });
}

function renderSaved(t: SavedTurn): void {
  addUser(t.userText, t.createdAt);
  const view = addAnswer();
  view.answer.innerHTML = html(t.assistantText || "");
  renderSources(view.sources, t.sources);
  if (t.status === "interrupted") addNote(view, t.assistantText ? "Stopped" : "Stopped before answering");
  if (t.status === "failed") addNote(view, "This reply failed", true);
  if (t.assistantText) addAnswerTools(view, t.assistantText);
}

async function loadThread(id: string, attempt = 0): Promise<void> {
  detach();
  const gen = viewGen;
  threadId = id;
  temporary = false;
  syncTemporary();
  writeThread(id);
  markActiveChat();
  lastDay = null;
  let turns: SavedTurn[] = [];
  try { turns = await (await fetch("/api/thread?id=" + encodeURIComponent(id))).json(); } catch {}
  if (gen !== viewGen) return;
  messages.replaceChildren();
  if (!turns.length) { showEmpty(); return; }

  const last = turns[turns.length - 1];
  const live = last.status === "streaming" ? last : null;
  for (const t of turns) if (t !== live) renderSaved(t);

  if (live) {
    let res: Response | null = null;
    try { res = await fetch(streamUrl(id, 0)); } catch {}
    if (gen !== viewGen) { res?.body?.cancel(); return; }
    if (res?.status === 204 && attempt < 2) { loadThread(id, attempt + 1); return; }
    addUser(live.userText, live.createdAt);
    const view = addAnswer();
    view.status.textContent = "Resuming";
    const s = beginStream(view, id, live.userText);
    follow(s, res && res.ok && res.status !== 204 ? res : null);
  }
  toBottom();
}
