import type { Summarizer } from "./summarize.ts";
import type { Titler } from "./title.ts";

/** The small model's only jobs. The answering model does everything else. */
export interface Helpers {
  summarize?: Summarizer;
  title?: Titler;
}
