$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (active) { stop(); return; }
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  sizeInput();
  ask(text);
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $<HTMLFormElement>("form").requestSubmit(); }
});
input.addEventListener("input", () => { sizeInput(); setBusy(Boolean(active)); updateComposer(); });
$("new").addEventListener("click", () => {
  temporary = false;
  history.pushState(null, "", location.pathname);
  goHome();
  input.focus();
});
// Only an empty chat can switch, so a saved and a temporary chat never mix.
$("think").addEventListener("click", () => {
  thinkMore = !thinkMore;
  $("think").setAttribute("aria-pressed", String(thinkMore));
  input.focus();
});
$("temporary").addEventListener("click", () => {
  if (active || !document.body.classList.contains("is-empty")) return;
  temporary = !temporary;
  showEmpty();
  input.focus();
});
window.addEventListener("popstate", () => {
  const id = location.hash.slice(1);
  if (id) loadThread(id); else goHome();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && active) { if (active.frame) cancelAnimationFrame(active.frame); paint(active); }
});
if (channel) channel.onmessage = (e) => {
  refreshChats();
  if (!threadId || e.data.threadId !== threadId) return;
  if (e.data.deleted) leaveDeletedChat();
  else if (!active) loadThread(threadId);
};
$("chats-toggle").addEventListener("click", () => setChatsOpen(!document.body.classList.contains("chats-open")));
$("chats-backdrop").addEventListener("click", () => setChatsOpen(false));

async function stillAnswering(id: string): Promise<boolean> {
  try {
    const turns: SavedTurn[] = await (await fetch("/api/thread?id=" + encodeURIComponent(id))).json();
    return turns[turns.length - 1]?.status === "streaming";
  } catch {
    return false;
  }
}

(async () => {
  tickClock();
  setInterval(tickClock, 15000);
  let savedOpen = null;
  try { savedOpen = localStorage.getItem("chatsOpen"); } catch {}
  document.body.classList.toggle("chats-open", window.innerWidth >= 900 && savedOpen !== "0");
  refreshChats();
  try { applySettings(await api("GET", "/api/settings")); refreshModels(); }
  catch { configured = false; }

  // Like other chat apps: a link to a chat opens it, otherwise a new chat opens, unless the last chat is still answering.
  const linked = location.hash.slice(1);
  const resume = !linked && threadId && (await stillAnswering(threadId)) ? threadId : null;
  const open = linked || resume;
  if (open) {
    history.replaceState(null, "", "#" + open);
    await loadThread(open);
  } else {
    threadId = null;
    writeThread(null);
    showEmpty();
  }
  setBusy(Boolean(active));
  if (configured) input.focus();
  updateComposer();
})();
