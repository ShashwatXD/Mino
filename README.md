# Mino

A chat agent with web search that remembers what it told you and when, then checks whether it is still true.

**[Read the design](DESIGN.md)**

## Run

Requires Node 22.13 or newer.

```bash
cp .env.example .env   # add one API key
npm install
npm run dev
```

Open http://localhost:3000. You can also add or change keys in the app at `/settings`.

## Engines

Add one key. Gemini is used first when there are several, and the model can be changed in the app.

| Engine | Key | Default model |
| --- | --- | --- |
| Gemini | `GEMINI_API_KEY` | `gemini-3.1-flash-lite` |
| Claude | `ANTHROPIC_API_KEY` | `claude-sonnet-5-5` |
| OpenAI | `OPENAI_API_KEY` | `gpt-6-luna` |

## Test

```bash
npm test
```

The tests use fake model clients, so they need no API key.
