import type { Turn } from "../domain/turn.ts";

const MAX_CHATS = 50;
const MAX_TURNS = 40;
const IDLE_MS = 60 * 60_000;

export class TemporaryChats {
  private chats = new Map<string, { turns: Turn[]; touched: number }>();
  private nextId = -1;

  turns(threadId: string, now = Date.now()): Turn[] {
    for (const [id, chat] of this.chats) if (now - chat.touched > IDLE_MS) this.chats.delete(id);
    return this.chats.get(threadId)?.turns ?? [];
  }

  add(threadId: string, turn: Omit<Turn, "id" | "threadId">, now = Date.now()): void {
    const chat = this.chats.get(threadId) ?? { turns: [], touched: now };
    chat.turns = [...chat.turns, { ...turn, id: this.nextId--, threadId }].slice(-MAX_TURNS);
    chat.touched = now;
    this.chats.delete(threadId);
    this.chats.set(threadId, chat);
    if (this.chats.size > MAX_CHATS) this.chats.delete(this.chats.keys().next().value!);
  }
}
