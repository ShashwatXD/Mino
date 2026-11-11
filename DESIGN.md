# Mino

> **Search is the easy half. Time is the hard half.**

"Has any pricing changed since last Tuesday?" asks an agent to know what it said, know when it said it, and check that against today. Mino treats every conversation as a dated record it can find and re-verify.

## How it works

```mermaid
flowchart TD
    A([Message]) --> G{"Within spend<br/>and rate limits?"}
    G -- No --> X(["Refused before any model call"])
    G -- Yes --> B["Build the prompt<br/>time, facts, chat summaries"]
    B --> M["Answering model, thinking on"]
    M -- web_search --> W[(Live web)]
    W --> M
    M -- "search_history, up to 4 times<br/>dates, topic, grep, whole chat" --> H[(Past chats)]
    H --> M
    M --> E([Streamed answer, with sources])
    E -.-> Z["Small model, in the background<br/>chat summary and title"]
```

Recall has one path: the model's `search_history` tool. Every prompt carries a light overview of the past, and the model fetches exact turns when it needs them, like `rg` over the chat log. Filters combine: a date range, topic words that survive typos, a grep pattern or regex, or one whole chat by id.

**What the model sees**

| Layer | Sent |
| --- | --- |
| Time and time zone | Always |
| Facts the user stated | Always |
| Summaries of 15 recent chats | Always |
| This chat: recent turns, older ones summarized | Always |
| Exact past turns, with sources and dates | When the model calls `search_history` |

The always-on layers follow [ChatGPT's reported design](https://llmrefs.com/blog/reverse-engineering-chatgpt-memory), and summarizing older turns follows [LobeHub](https://github.com/lobehub/lobe-chat). Exact, dated recall is Mino's own, because a summary cannot quote what you asked on some date.

**The brief's examples**

| Question | Mino finds the chat | Mino finds nothing |
| --- | --- | --- |
| "On Monday we shortlisted 5 CRM tools..." | Searches each product, shows then and now | Says so, checks recent CRM news, asks which five |
| "What did I ask you on 3 November?" | Quotes it, re-checks what can change | Says so, invents nothing |
| "Last Tuesday I asked about Postgres hosting..." | Searches each provider, gives both dates | Says so, searches current pricing anyway |

## Why this design

- **One source of truth for the past.** An earlier version also recalled in code before the model ran. The two could disagree, and a wrong match stayed in the prompt. Now only the tool answers, so there is one result to trust.
- **The tool says what it found.** That day, nothing that day but strong matches on other dates, or nothing at all. The model gets that sentence, not a guess.
- **A strong match or nothing.** A chat from another day is offered only when its topic clearly matches, never on one shared word like "pricing".
- **Summaries for breadth, exact words for truth.** Summaries keep prompts small. The log remains the source of truth for what was said and what it cost then.
- **Honest about change.** Unless a source shows a value on both dates, Mino says "no evidence of change", never "unchanged".
- **Big model answers, small model writes.** Gemini 3.8 Flash, Claude Sonnet 5.5 or GPT-6.1 Terra does the thinking, searching and answering. Flash-Lite, Haiku or GPT-6 Luna only writes summaries and titles, after the reply.
- **A reply belongs to the server, not the tab.** Refresh, switch tabs or lose the network, and the answer resumes without repeating a word.
- **Spending has hard edges.** Every reply has output, web search, history lookup and time caps. A daily budget stops requests before any model is called.

The code is layered: `http` → `services` → `context` → `memory` · `llm` → `db/repositories`. Each layer imports only those below it. 137 tests cover history search, the tool loop on all three engines, streaming and spending.

## How it scales

History search is local, and both the prompt and each search result are capped however long the history grows.

| Chats stored | Date lookup | Typo-tolerant search |
| --- | --- | --- |
| 1,000 | 1ms | 2ms |
| 10,000 | 1ms | 8ms |
| 100,000 | 1ms | 80–140ms |

Mino is one user on one process, by design. More users would need a user ID on each row, Postgres, and a shared stream store. Recall and prompt building would not change.

## What I rejected

| Option | Why not |
| --- | --- |
| Recall in code before the model | It disagreed with the model's own searches and could leave a wrong match in the prompt |
| Vector database | These lookups are dates and names |
| Sending all history | Slow and costly on every message |
| Own search pipeline | Hosted search already gives results and citations |
| Vercel AI SDK | Each provider's search and citations differ, and I wanted to map and test them directly |
| Next.js | A chat needs one page and one streaming endpoint |

## With another week

1. Build an eval set and cut latency. On Gemini 3.8 Flash, a re-check like the brief's Postgres question (one history lookup, three web searches) takes 11–15 s to first token.
2. Make web search stateful, so a follow-up continues earlier searches.
3. Snapshot pricing pages, so "unchanged" can be proven.
4. Add embeddings for the same idea in different words.
5. Add a Settings profile, like ChatGPT's custom instructions, with editable saved facts.
