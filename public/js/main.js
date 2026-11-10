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
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("form").requestSubmit(); }
});
input.addEventListener("input", () => { sizeInput(); setBusy(Boolean(active)); updateComposer(); });
$("new").addEventListener("click", () => {
  history.pushState(null, "", location.pathname);
  goHome();
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
  if (e.data.threadId !== threadId) return;
  if (e.data.deleted) leaveDeletedChat();
  else if (!active) loadThread(threadId);
};
$("chats-toggle").addEventListener("click", () => setChatsOpen(!document.body.classList.contains("chats-open")));
$("chats-backdrop").addEventListener("click", () => setChatsOpen(false));

(async () => {
  tickClock();
  setInterval(tickClock, 15000);
  let savedOpen = null;
  try { savedOpen = localStorage.getItem("chatsOpen"); } catch {}
  document.body.classList.toggle("chats-open", window.innerWidth >= 900 && savedOpen !== "0");
  refreshChats();
  try { applySettings(await api("GET", "/api/settings")); refreshModels(); }
  catch { configured = false; }

  const id = location.hash.slice(1) || threadId;
  if (id) {
    history.replaceState(null, "", "#" + id);
    await loadThread(id);
  } else {
    showEmpty();
  }
  setBusy(Boolean(active));
  if (configured) input.focus();
  updateComposer();
})();
