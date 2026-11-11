# Mino

> **Search is the easy half. Time is the hard half.**

"Has any pricing changed since last Tuesday?" asks an agent to know what it said, know when it said it, and check that against today. Mino treats every conversation as a dated record it can find and re-verify.

## How it works

```mermaid
flowchart LR
    Q([Message]) --> G{Within budget<br/>and rate limits?}
    G -- no --> X([Refused, no model call])
    G -- yes --> C[Context layer]
    C --> M[Answering model<br/>thinking on]
    M <--> T[Two tools<br/>web_search · search_history]
    M --> A([Streamed answer<br/>with sources])
    A -.-> S[Small model, afterwards<br/>chat summary and title]
```

### The context layer

Memory has two halves. A small overview rides along with every message, and exact past turns are fetched only when the model asks for them.

```mermaid
flowchart TB
    subgraph always[Every prompt]
        direction LR
        A1[Time] ~~~ A2[Facts] ~~~ A3[Recent chats] ~~~ A4[This chat]
    end
    always --> M[Answering model]
    M <-->|search_history| demand
    subgraph demand[On demand]
        direction LR
        D1[Date range] ~~~ D2[Topic] ~~~ D3[Grep] ~~~ D4[One chat]
    end
```

| Layer | What it holds | Limit |
| --- | --- | --- |
| Time | Current time and the user's time zone | — |
| Facts | What the user stated: name, city, work, diet | 30 facts |
| Recent chats | One summary per chat, or its title | 15 chats, 700 chars each |
| This chat | Newest turns in full, older ones as a summary | 30,000 chars |
| `search_history` | Exact past turns by date, topic with typos, grep or regex, or inside one chat, with dates and sources | 4 lookups a reply, 8 turns or 12,000 chars per result |

The overview tells the model what exists. The tool returns what was actually said, with its date, like `rg` (ripgrep) over the chat log. Filters combine, and every result says how many turns matched, so the model can widen the search, narrow it, or read the next page. The always-on layers follow [ChatGPT's reported design](https://llmrefs.com/blog/reverse-engineering-chatgpt-memory) and summarizing older turns follows [LobeHub](https://github.com/lobehub/lobe-chat). Exact, dated recall is Mino's own, because a summary cannot quote what you asked on a given day.

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
- **Low thinking by default.** Measured on the brief's questions, medium thinking took 13–34 s to first text and low took 6–9 s with the same lookups. `EFFORT` raises it.
- **Temporary chats stay out of memory.** They are kept only in the server process, get no history tool, see no facts or summaries, and get no title or summary.
- **A reply belongs to the server, not the tab.** Refresh, switch tabs or lose the network, and the answer resumes without repeating a word.
- **Spending has hard edges.** Every reply has output, web search, history lookup and time caps. A daily budget stops requests before any model is called.

The code is layered: `http` → `services` → `context` → `memory` · `llm` → `db/repositories`. Each layer imports only those below it. The page's scripts are strict TypeScript too; Node strips their types on request, so there is still no build step. 151 tests cover history search, the tool loop on all three engines, temporary chats, traces, streaming and spending. Every reply is traced at `/traces`, and `npm run eval` writes the [eval report](evals/REPORT.md).

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

1. Cut latency further. On Gemini 3.8 Flash, re-checking old prices (one history lookup, then web searches) takes 7–9 s to first text, and a plain history question about 4 s.
2. Make web search stateful, so a follow-up continues earlier searches.
3. Snapshot pricing pages, so "unchanged" can be proven.
4. Add embeddings for the same idea in different words.
5. Add a Settings profile, like ChatGPT's custom instructions, with editable saved facts.
