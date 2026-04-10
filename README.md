# cf_ai_study_buddy

An AI-powered study assistant built on Cloudflare's platform. Study Buddy helps you learn any topic through conversational AI, automatically generates flashcards from study sessions, and uses spaced repetition (SM-2 algorithm) to optimize review scheduling.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    React Frontend                         │
│  Chat UI  │  Flashcard Browser  │  Spaced Repetition UI  │
└──────────────┬───────────────────────────┬────────────────┘
               │ WebSocket (state sync)    │ RPC (@callable)
               ▼                           ▼
┌──────────────────────────────────────────────────────────┐
│              StudyBuddyAgent (Durable Object)            │
│  ┌─────────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │  AIChatAgent     │  │  SM-2 Algo   │  │  SQL Store │  │
│  │  (conversation)  │  │  (scheduling)│  │  (persist) │  │
│  └────────┬─────────┘  └──────────────┘  └────────────┘  │
│           │                                               │
│           ▼                                               │
│  ┌─────────────────┐                                     │
│  │  Workers AI      │                                     │
│  │  Llama 3.3 70B   │                                     │
│  └─────────────────┘                                     │
└──────────────────────────────────────────────────────────┘
```

## Components

| Requirement | Implementation |
|---|---|
| **LLM** | Llama 3.3 70B (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) via Workers AI |
| **Workflow / Coordination** | Durable Objects via Cloudflare Agents SDK — manages chat state, flashcard lifecycle, and review scheduling |
| **User Input** | Real-time chat interface over WebSockets with streaming responses |
| **Memory / State** | SQLite (embedded in Durable Object) for flashcards + study history; reactive state sync for UI |

## Features

- **Conversational Learning** — Ask about any topic; the AI explains concepts and automatically generates flashcards
- **Flashcard Management** — Browse, filter by topic, and delete cards from a dedicated view
- **Spaced Repetition** — SM-2 algorithm schedules reviews at optimal intervals based on recall difficulty
- **Persistent Memory** — Conversation history, flashcards, and study progress survive restarts and deploys
- **Real-time State Sync** — Stats (total cards, due count, studied today) update live across all views

## Prerequisites

- Node.js >= 18
- A Cloudflare account (free tier works)
- Wrangler CLI (`npm i -g wrangler` or use npx)

## Running Locally

```bash
# Clone the repo
git clone https://github.com/zhyiz/cf_ai_study_buddy.git
cd cf_ai_study_buddy

# Install dependencies
npm install

# Start local dev server (uses Cloudflare's local runtime)
npm run dev
```

Open `http://localhost:8787` in your browser.

> **Note:** Workers AI requires a Cloudflare account. Run `npx wrangler login` before `npm run dev` to authenticate. The local dev server proxies AI requests to Cloudflare's edge.

## Deploying to Cloudflare

```bash
# Authenticate with Cloudflare (if not already)
npx wrangler login

# Deploy
npm run deploy
```

The deploy command outputs a URL like `https://cf-ai-study-buddy.<your-subdomain>.workers.dev`.

## Usage

1. **Chat** — Type "Teach me about [topic]" to start learning. The AI explains concepts and creates flashcards automatically.
2. **Flashcards** — Switch to the Flashcards tab to browse all generated cards, filter by topic, or delete unwanted ones.
3. **Review** — When cards are due, the Review tab shows them one at a time. Rate your recall (Again / Hard / Good / Easy) to adjust the next review interval.

## Tech Stack

- **Runtime**: Cloudflare Workers + Durable Objects
- **AI**: Workers AI (Llama 3.3 70B Instruct)
- **Agent SDK**: `agents` (Cloudflare Agents SDK)
- **AI SDK**: Vercel AI SDK (`ai` + `workers-ai-provider`)
- **Frontend**: React 19, Vite
- **State**: SQLite (per Durable Object), reactive state sync via WebSocket
- **Algorithm**: SM-2 spaced repetition

## Project Structure

```
cf_ai_study_buddy/
├── src/
│   ├── server.ts       # StudyBuddyAgent — chat, flashcards, SM-2, SQL
│   ├── client.tsx      # React UI — chat, card browser, review mode
│   ├── main.tsx        # React entry point
│   └── styles.css      # Dark theme UI styles
├── public/
│   └── index.html      # HTML shell
├── wrangler.jsonc      # Cloudflare config (DO bindings, AI, migrations)
├── vite.config.ts      # Vite + Cloudflare plugin
├── package.json
├── tsconfig.json
├── PROMPTS.md          # AI prompts used during development
└── README.md
```
