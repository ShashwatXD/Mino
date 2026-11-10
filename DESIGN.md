# Mino

> **Search is the easy half. Time is the hard half.**

"Has pricing changed since last Tuesday?" needs an agent that knows what it said, when it said it, and whether it still holds. Mino keeps every chat as a dated record, finds the right one, and checks it again on the web.

## How it works

```mermaid
flowchart TD
    A([Message]) --> G{"Within spend<br/>and rate limits?"}
    G -- No --> X(["Refused before any model call"])
    G -- Yes --> R["Recall, in code<br/>dates · keywords · typo-tolerant search"]
    R -. "unclear, rarely" .-> S["Small model clarifies<br/>no tools · 1.5 s cap"]
    S -.-> R
    R --> P["Prompt<br/>time · facts · recent chats · this chat · what was found"]
    P --> M["Answering model"]
    M -- "web_search, the only tool" --> W[(Web)]
    W --> M
    M --> E([Answer streams, with sources])
    E -.-> B["In the background<br/>save the turn · update the chat summary"]
```

The model has one tool, `web_search`. Memory is plain code that runs first, so the past is already in the prompt.

**Every prompt carries** the time, stated facts, summaries of the 15 latest chats, and this chat. **When a date or "what changed" comes up**, it also carries the exact past turns, with sources and timestamps.

The always-on layers follow [ChatGPT's memory](https://llmrefs.com/blog/reverse-engineering-chatgpt-memory), summarizing older turns follows [LobeHub](https://github.com/lobehub/lobe-chat), and the clarifying step follows [Vane](https://github.com/ItzCrazyKns/Vane/blob/master/docs/architecture/WORKING.md). Exact-turn recall is Mino's own: a summary says pricing came up, but only the record has the price and the date.

| Ask | Mino |
| --- | --- |
| "Last Tuesday I asked about Postgres hosting. Has pricing changed?" | Loads Tuesday's answer, searches again, and shows old vs new price with both dates |
| "What did I ask yesterday about my Goa trip?" | Quotes the question and the time. With no record, says so and invents nothing |

## Decisions

- **Recall in code, not a tool.** The brief allows one tool, and a date question should never depend on the model choosing to look. *Cost: the model can't dig deeper mid-answer.*
- **One finding per message.** The model is told plainly: found that day, found another day, found by topic, or nothing. *Cost: each new case needs a name.*
- **Exact log plus summaries.** Summaries keep prompts small. The log stays the truth for exact words and prices. *Cost: a summary lags one reply.*
- **Code first, small model rarely.** Dates and typos resolve in milliseconds. The small model runs only for vague references, and the reply goes on if it fails.
- **No vector database.** These lookups are dates and names, and a trigram index with edit distance covers typos. *Cost: the same idea in other words can be missed.*
- **Bounded, cache-friendly prompt.** History is capped at 30k characters and recall at 16k, with stable parts first so providers reuse the cache.
- **The server owns each reply.** Numbered events let any tab resume after a refresh or dropped network.
- **Hard spending limits.** Output, search and time caps on every reply, plus a daily budget checked before any model call.
- **One event stream, three engines.** Gemini, Claude and OpenAI map to the same events, and one test checks they match.

Web results and old chats are escaped and marked as data, so instructions inside them are ignored.

## Fast by design

One model round trip per answer, recall in milliseconds, the small model only when needed, a cached prompt prefix, and tokens streamed as they arrive.

## Models

**Gemini 3.1 Flash-Lite** is the default: fast, cheap, with Google Search built in. A Claude or OpenAI key works too. The matching small model (Flash-Lite, Haiku 5.5, gpt-6-luna) clarifies messages and writes summaries and titles.

## Code

`http` → `services` → `context` → `memory` · `llm` → `db/repositories`. Each layer imports only the ones below it, so moving to Postgres touches only `db`. 156 tests cover recall, streaming, spending and engine parity.

## Scale

One SQLite file, so `npm install` and `npm run dev` are enough. At 100,000 chats a date lookup takes 1 ms and typo search 80–140 ms. Prompt size stays flat as history grows. More users would need user IDs, Postgres and a shared store for live replies.

## Rejected

- **A history tool:** the brief says one tool.
- **Provider-side memory:** differs per provider, and Claude's is a second tool.
- **Vercel AI SDK:** each provider's search and citations differ, and I wanted to map and test them directly.
- **Sending all history:** slow and costly on every message.
- **Own search pipeline:** hosted search already cites its sources.
- **Next.js:** one page and one streaming endpoint don't need it.

## With another week

1. Measure speed and accuracy on real models.
2. Stateful search, so a follow-up continues earlier searches.
3. Snapshot pricing pages, so "unchanged" can be proven.
4. Embeddings for the same idea in different words.
5. A Settings profile, like ChatGPT's custom instructions, with editable saved facts.
