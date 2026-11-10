# Mino

A chat agent with web search that remembers what it told you and when, then checks whether it is still true.

**[Read the design](DESIGN.md)**

## Run

Requires Node 22.13 or newer.

```bash
cp .env.example .env   # add a Gemini, Claude or OpenAI key
npm install
npm run dev
```

Open http://localhost:3000.

## Test

```bash
npm test
```
