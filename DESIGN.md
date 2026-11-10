# Mino: design

**Searching the web is the easy half of this challenge. The hard half is time.** Questions like "Has any pricing changed since last Tuesday?" need the agent to know what it said on a given date, and then check that against today. So Mino treats every conversation as a dated record it can look up and re-verify.

## How it works

```mermaid
flowchart TD
    A([User message]) --> B["Resolve dates in code<br/>'last Tuesday' becomes 3 Nov"]
    B --> C{Refers to the past?}
    C -- No --> E[Model + web search]
    C -- Yes --> D[("Conversation log<br/>SQLite")]
    D -- "Past turns, or 'no record'" --> E
    E -- Streams --> F([Answer with sources])
    F --> G["Save question, answer,<br/>sources and timestamp"]
    G -.-> D
```

Here is what happens on questions from the brief:

| Question | What Mino does |
| --- | --- |
| "What did I ask you on 3 November?" | Code turns the date into a day window in the user's time zone and reads that day's turns. If there are none, it says so instead of guessing. |
| "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?" | Finds that turn with its old prices and sources, searches each provider again, and reports what changed, with both dates. |
| "On Monday we shortlisted 5 CRM tools. Has any of them changed pricing or shipped something big since?" | Same flow, item by item. Anything it cannot confirm is reported as unverified, never as unchanged. |

The agent has one tool, web search, as the brief asks. Memory is ordinary code that runs before the model.

## Why I built it this way

- **Memory runs in code, not as a tool.** A date question should never depend on the model deciding to look something up. This also saves a model round trip.
- **Turns are stored word for word.** "What did I ask?" needs the exact words, and "has it changed?" needs the old numbers and sources. A summary can lose either for good.
- **"No record" is a fact the model is given.** This stops it from inventing a past conversation. If the user gets a date wrong, Mino still finds the topic and gives the real date.
- **Speed comes from doing less.** Ordinary questions skip memory completely, recall is a local query, text streams as it is generated, and the UI shows each search.
- **Retrieved text is treated as data.** Web results and old turns can contain instructions, so they are marked as data and stored text is escaped.
- **Any provider's key works.** Gemini, Claude and OpenAI each map their stream onto the same events. The key in `.env` picks the engine, and Gemini Flash is the default for speed. Zod validates settings and requests, so a bad key only disables its own engine.

## What I considered and rejected

| Option | Why not |
| --- | --- |
| Temporal knowledge graph ([Graphiti](https://github.com/getzep/graphiti)) | I kept its core idea, that facts have dates. A graph database and LLM extraction on every write are too heavy for one user's chats, and extraction can get the record wrong. |
| Extracted memories ([Mem0](https://github.com/mem0ai/mem0)) | Good for preferences, but it keeps a summary rather than the exact words these questions need. |
| A `search_memory` tool | Adds a round trip, and the model can skip it. |
| Vector search over history | These lookups are dates and product names, where date filters and keywords are exact. |
| Own search and scrape pipeline ([Vane](https://github.com/ItzCrazyKns/Vane)) | More control, but much more to run. Hosted search gives results and citations through one key. |
| Next.js | A chat UI needs one page and one streaming endpoint. |

## What I'd do with another week

1. Run an eval on the question set and tune model and search count on measured speed and accuracy. I have not measured either yet.
2. Keep real snapshots of official pricing pages, so "unchanged" can be proven rather than only "no evidence of change".
3. Store prices as dated structured facts next to the raw turns, for exact diffs.
4. Add accounts, since memory is one local user today.
5. Add embeddings if paraphrased recall turns out to be a real miss.
