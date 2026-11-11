declare const marked: { parse(markdown: string): string };
declare const DOMPurify: { sanitize(html: string): string };

// Speech recognition is missing from TypeScript's DOM library, so only the parts the page uses are described.
interface SpeechRecognitionSession {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
interface Window {
  SpeechRecognition?: new () => SpeechRecognitionSession;
  webkitSpeechRecognition?: new () => SpeechRecognitionSession;
}

// What /api/settings returns, shared by the chat page and the settings page.
interface ProviderInfo {
  id: string;
  label: string;
  keyUrl: string;
  configured: boolean;
  source: "app" | "env" | null;
  inEnv: boolean;
  hint: string | null;
  models: string[];
}
interface SettingsSnapshot {
  configured: boolean;
  provider: string | null;
  model: string | null;
  warnings: string[];
  providers: ProviderInfo[];
  usage?: { spentUsd: number; limitUsd: number; messages: number; maxMessages: number };
  verified?: boolean;
}
