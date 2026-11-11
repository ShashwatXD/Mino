export interface Source {
  url: string;
  title: string;
  pageAge?: string;
  cited: boolean;
}

export interface Fact {
  key: string;
  value: string;
  statedAt: number;
}

export interface RecentChat {
  threadId: string;
  title: string;
  summary: string | null;
  updatedAt: number;
}

export interface ChatListItem {
  threadId: string;
  title: string;
  updatedAt: number;
  pinned: boolean;
}

export type TurnStatus = "ok" | "streaming" | "interrupted" | "failed";

export interface Turn {
  id: number;
  threadId: string;
  createdAt: number;
  userText: string;
  assistantText: string;
  sources: Source[];
  queries: string[];
  status: TurnStatus;
}

export interface HistoryQuery {
  query?: string;
  pattern?: string;
  from?: string;
  to?: string;
  chatId?: string;
}
