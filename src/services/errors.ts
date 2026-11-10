export class NoEngineError extends Error {}

const NO_KEY_MESSAGE = "No API key added yet. Open Settings to add one.";

/** All three SDKs expose an HTTP status, so one mapping covers every engine. */
export function friendlyError(err: unknown): string {
  if (err instanceof NoEngineError) return NO_KEY_MESSAGE;
  const status = (err as { status?: unknown })?.status;
  const message = err instanceof Error ? err.message : "";
  if (status === 401 || /API[ _]KEY[ _](NOT[ _]VALID|INVALID)/i.test(message)) return "The API key was rejected. Check it in Settings.";
  if (status === 402) return "This API key has no credits left. Add credits in your provider's billing page, or switch provider in Settings.";
  if (status === 403) return "This API key cannot use the configured model or web search.";
  if (status === 404) return "This model was not found. Choose another one in Settings.";
  if (status === 429) return "The model is rate limited right now. Please try again shortly.";
  if (typeof status === "number") return `The model request failed (${status}). Please try again.`;
  if (/fetch failed|connection|network|ENOTFOUND|ECONN/i.test(message)) return "Could not reach the model. Check the network connection.";
  return "Something went wrong while answering. Please try again.";
}
