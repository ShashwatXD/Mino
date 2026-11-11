interface ChatListItem { threadId: string; title: string; updatedAt: number; pinned: boolean }

function setChatsOpen(open: boolean): void {
  document.body.classList.toggle("chats-open", open);
  try { localStorage.setItem("chatsOpen", open ? "1" : "0"); } catch {}
}

function markActiveChat() {
  for (const row of $("chat-list").querySelectorAll<HTMLElement>(".chat-row")) {
    row.classList.toggle("active", row.dataset.id === threadId);
  }
}

async function togglePin(chat: ChatListItem): Promise<void> {
  try { await api("PATCH", "/api/thread", { threadId: chat.threadId, pinned: !chat.pinned }); } catch {}
  channel?.postMessage({ chats: true });
  await refreshChats();
  $("chat-list").querySelector<HTMLElement>(`[data-id="${CSS.escape(chat.threadId)}"] .pin`)?.focus();
}

function leaveDeletedChat() {
  history.replaceState(null, "", location.pathname);
  goHome();
}

async function deleteChat(id: string): Promise<void> {
  await api("DELETE", "/api/thread", { threadId: id });
  channel?.postMessage({ threadId: id, deleted: true });
  if (id === threadId) {
    leaveDeletedChat();
    if (configured) input.focus();
  }
  refreshChats();
}

// Deleting is permanent, so the row asks first. Only one row can be asking at a time.
let closeConfirm: (() => void) | null = null;
function askDelete(chat: ChatListItem, row: HTMLElement, trigger: HTMLElement): void {
  closeConfirm?.();
  const original = [...row.children];
  const box = el("div", "chat-confirm");
  const text = el("span", "", "Delete?");
  const cancel = el("button", "ghost mono", "Cancel");
  const confirm = el("button", "ghost mono delete", "Delete");
  cancel.type = confirm.type = "button";
  confirm.title = "Permanently deletes this chat and removes it from Mino's memory";
  const close = () => { closeConfirm = null; row.replaceChildren(...original); };
  closeConfirm = close;
  cancel.addEventListener("click", () => { close(); trigger.focus(); });
  confirm.addEventListener("click", async () => {
    confirm.disabled = cancel.disabled = true;
    try { await deleteChat(chat.threadId); }
    catch {
      text.textContent = "Failed";
      text.classList.add("failed");
      confirm.disabled = cancel.disabled = false;
    }
  });
  box.addEventListener("keydown", (e) => { if (e.key === "Escape") cancel.click(); });
  box.append(text, cancel, confirm);
  row.replaceChildren(box);
  cancel.focus();
}

function chatRow(chat: ChatListItem): HTMLElement {
  const row = el("div", "chat-row");
  row.dataset.id = chat.threadId;
  const item = el("button", "chat-item", chat.title);
  item.type = "button";
  item.title = chat.title;
  item.addEventListener("click", () => {
    if (window.innerWidth < 900) setChatsOpen(false);
    if (chat.threadId === threadId) return;
    history.pushState(null, "", "#" + chat.threadId);
    loadThread(chat.threadId);
  });
  const pin = toolButton(ICONS.pin, chat.pinned ? "Unpin chat" : "Pin chat");
  pin.classList.add("pin");
  pin.classList.toggle("on", chat.pinned);
  pin.addEventListener("click", () => togglePin(chat));
  const remove = toolButton(ICONS.trash, "Delete chat");
  remove.addEventListener("click", () => askDelete(chat, row, remove));
  const actions = el("div", "chat-actions");
  actions.append(pin, remove);
  row.append(item, actions);
  return row;
}

let chatsGen = 0;
async function refreshChats() {
  const gen = ++chatsGen;
  let chats: ChatListItem[] = [];
  try { chats = await (await fetch("/api/threads")).json(); } catch { return; }
  // A slower, older response must not bring back a chat that was just deleted.
  if (gen !== chatsGen) return;
  closeConfirm = null;
  const list = $("chat-list");
  list.replaceChildren();
  if (!chats.length) { list.append(el("div", "chats-empty", "Your chats will appear here")); return; }
  let section: string | null = null;
  for (const chat of chats) {
    const label = chat.pinned ? "Pinned" : dayLabel(chat.updatedAt);
    if (label !== section) { section = label; list.append(el("div", "mono chats-day", label)); }
    list.append(chatRow(chat));
  }
  markActiveChat();
}

function goHome() {
  detach();
  threadId = null;
  writeThread(null);
  markActiveChat();
  showEmpty();
}
