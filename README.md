# Mino

A chat agent with web search that remembers what it told you and when, then checks whether it is still true.

**[Read the design](DESIGN.md)** · **[Read the eval report](evals/REPORT.md)**

## Demo

[Watch the one-minute demo](docs/demo.mp4)

## Run

Requires Node 22.13 or newer.

```bash
cp .env.example .env   # add a Gemini, Claude or OpenAI key
npm install
npm run dev
```

Open http://localhost:3000. Every reply is traced step by step at http://localhost:3000/traces.

## Tested

| What | How | Latest |
| --- | --- | --- |
| Unit and integration tests | `npm test`, with fake model clients and in-memory SQLite | 151 passing |
| Live evals | `npm run eval`: the real app on a fresh SQLite database with seeded past chats, a real model and live web search | 10 / 10 on Gemini 3.8 Flash, median 7.5 s to first text, $0.23 a run |
| Types | `npm run typecheck`, strict on the server and the page scripts | Clean |

The eval needs an API key in `.env` and spends real money, so it runs on demand. Its [report](evals/REPORT.md) shows each case's history lookups, web searches, timings, cost and full answer.
