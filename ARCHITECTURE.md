# MaraAI Platform Architecture

> This document describes the architecture **as it actually exists in the
> repository**. It is intentionally factual — if you change the system,
> update this file in the same PR.

## System Overview

MaraAI is a **single-service** full-stack application:

- One **Node.js / Express** process (`server/`) that serves both the JSON API
  (`/api/**`) and the compiled **React SPA** (static files from `dist/public`).
- **SQLite** (via `better-sqlite3` + **Drizzle ORM**) as the database.
- AI provided through a **provider router** that prefers a self-hosted
  **Ollama** model and falls back to **Anthropic Claude**.
- Deployed as a **single Docker container on Railway** (`Dockerfile.nodejs`,
  `railway.json`), with the SQLite file living on a mounted volume at `/data`.

```
                         Browser (React SPA + WebSocket)
                                      │
                                      ▼
              ┌───────────────────────────────────────────────┐
              │   Railway service (Docker, Node 20)            │
              │   node dist/server/index.js                    │
              │                                                │
              │   Express app:                                 │
              │     • /api/**            → API route handlers  │
              │     • everything else    → SPA (dist/public)   │
              │     • WebSocketServer    → chat + P2P signaling │
              └───────────────────────────────────────────────┘
                  │                 │                  │
                  ▼                 ▼                  ▼
          ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐
          │  SQLite      │  │ Provider     │  │ Sessions store   │
          │ /data/*.sqlite│  │ router:      │  │ connect-sqlite3  │
          │ Drizzle ORM  │  │ Ollama →     │  │ (express-session)│
          │ + migrations │  │ Anthropic    │  │                  │
          └──────────────┘  └──────────────┘  └──────────────────┘
```

There is **no** Firebase/Firestore, **no** JWT, **no** Python service, and
**no** separate `functions/` deployment. (Earlier revisions of this document
described such a stack; it was never the shipped architecture.)

---

## Project Structure

```
maraai/
├── frontend/                     # React + TypeScript SPA (Vite)
│   ├── src/                      # pages/, components/, contexts, hooks
│   ├── tailwind.config.js
│   ├── postcss.config.js
│   └── vite.config.ts            # builds to ../dist/public
│
├── server/                       # Express backend (TypeScript, ESM)
│   ├── index.ts                  # thin bootstrap/orchestration entrypoint
│   ├── routes.ts                 # route registration + admin dashboard
│   ├── bootstrap/                # migrations, seeders, background jobs, logging
│   ├── websocket/                # WS setup + chat/P2P/compute handlers
│   ├── db.ts                     # SQLite handle + Drizzle + bootstrap DDL
│   ├── auth.ts                   # express-session + connect-sqlite3, bcrypt
│   ├── ai.ts / llm.ts            # thin wrappers over lib/provider-router
│   ├── static.ts                 # serves dist/public in production
│   ├── vite.ts                   # dev-only Vite middleware
│   ├── lib/                      # provider-router, email, sanitize, observability…
│   ├── modules/                  # feature handlers (see below)
│   ├── mara-core/                # executive / objective / cognitive-state
│   ├── mara-brain/               # autonomous agent + agents/
│   ├── missions/                 # gamified missions + program engine
│   ├── billing/ notifications/ push/ security/ services/ middleware/
│   └── ...
│
├── shared/                       # Drizzle schema + Zod types (server+frontend)
├── migrations/                   # Drizzle SQL migrations (source of truth)
├── scripts/                      # build-server.mjs, smoke tests, CLIs
├── dist/                         # [build output] dist/server, dist/public, dist/shared
├── Dockerfile.nodejs             # multi-stage build (builder → runtime)
├── railway.json                  # builder=DOCKERFILE, startCommand=npm run start
└── .env.example                  # environment template
```

### `server/modules/`
Each file owns a feature's HTTP handlers, e.g. `chat.ts`, `reels.ts`,
`video.ts`, `writers.ts`, `creators.ts`, `payments.ts`, `orders.ts`,
`profile.ts`, `search.ts`, `tts.ts`, `stt.ts`, `notifications.ts`, `push.ts`,
`oauth-google.ts`, `oauth-facebook.ts`, `admin.ts`, `launch-countdown.ts`.

---

## Authentication & Sessions

- **Session-based**, not token-based. `express-session` stores sessions in
  SQLite via `connect-sqlite3`; the browser holds an opaque session cookie.
- Passwords hashed with **bcrypt**. OAuth via Google and Facebook
  (`server/modules/oauth-*.ts`).
- **CSRF**: clients fetch a token from `/api/auth/csrf`; mutating requests must
  echo it. (PayPal flows rely on the global CSRF wrapper — see Faza 0.)
- `AUTH_MODE=local` enables a local login path used by dev and the CI smokes.
- Admin endpoints are gated by `requireAdmin`.

---

## Data Layer

- **SQLite** opened in `server/db.ts` with WAL, `busy_timeout=5000`,
  `synchronous=NORMAL`.
- Path resolution: `DATABASE_URL`/`DATABASE_PATH` if set, else `/data/maraai.sqlite`
  when the `/data` volume exists (Railway), else `./maraai.sqlite` (local).
- **Schema ownership (single home per table):**
  1. **`migrations/*.sql`** (Drizzle) own the core relational tables that have
     a typed model in `shared/schema.ts`.
  2. The idempotent `CREATE TABLE IF NOT EXISTS` bootstrap in `server/db.ts`
     owns the auxiliary runtime tables (Mara Brain, Missions, Programs, P2P,
     referrals) that are not part of the Drizzle schema.
  3. An additive **self-heal guard** in `server/index.ts` backfills columns on
     production DBs whose migration journal was historically corrupted. It is
     gated on `PRAGMA table_info()` and `IF NOT EXISTS`, so it never mutates a
     healthy DB.

---

## AI / Mara

- `server/lib/provider-router.ts` routes LLM calls: **Ollama** (primary,
  self-hosted, free) with **Anthropic Claude** as paid fallback.
  Env: `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `OLLAMA_TIMEOUT_MS`, `ANTHROPIC_API_KEY`.
- `server/mara-core/` holds the executive reasoning, objective function, and
  cognitive-state model. `server/mara-brain/` runs the autonomous agent cycle
  (proposes work for admin approval — it is a scheduler around the LLM, not a
  vector-DB RAG system).

---

## Realtime

A `WebSocketServer` (`ws`) attached to the HTTP server handles live chat and
P2P (WebRTC) signaling for the hybrid video/compute features.

- `server/websocket/index.ts` enforces a **1 MB max payload** and a
  **distributed per-user 100 messages/minute** limiter before any WS business
  logic runs.
- `server/websocket/p2p-signaling.ts` re-checks **P2P consent**, kill-switch
  state, and relationship eligibility before relaying any offer/answer/candidate.
- Browser compute registration lives in `server/websocket/compute-handler.ts`;
  chat handling lives in `server/websocket/chat-handler.ts`.

---

## Build & Deploy

- **Build** (`npm run build`): `build:frontend` (Vite → `dist/public`) then
  `build:server` (esbuild compiles `server/` + `shared/` → `dist/`, preserving
  the tree; non-bundle mode).
- **Start** (`npm run start`): `node dist/server/index.js`. Production no longer
  runs `tsx` at runtime (see Faza 2).
- **Container**: `Dockerfile.nodejs` builder stage runs `npm ci` + `npm run
  build`; runtime stage runs the compiled output. `railway.json` selects the
  Dockerfile and sets `startCommand: npm run start`, `healthcheckPath:
  /api/health`.
- Migrations run at boot inside `server/index.ts` before the server listens.
- Boot is split into bounded modules:
  - `server/bootstrap/migrations.ts`
  - `server/bootstrap/seed.ts`
  - `server/bootstrap/jobs.ts`
  - `server/bootstrap/request-logging.ts`
  - `server/bootstrap/process-safety.ts`

### Local development
```bash
npm install            # root deps
cd frontend && npm install && cd ..
npm run dev            # tsx server/index.ts (Vite middleware in dev)
```
See `LOCAL_SETUP.md` for environment variables.

---

## Observability

- **Sentry** is wired in both backend (`server/lib/observability.ts`) and
  frontend (`frontend/src/observability.ts`). It is **optional**: with no
  `SENTRY_DSN` / `VITE_SENTRY_DSN` it is a no-op (see Faza 0).
- Operational visibility otherwise comes from server logs (Railway dashboard)
  and the admin dashboard (`/api/admin/dashboard`).

---

## Testing

CI (`.github/workflows/ci.yml`) runs: `npm run typecheck`, `npm run build`, and
a suite of **smoke tests** (`scripts/smoke-*.mjs`) against a freshly-booted
server (runtime, credits, growth, auth, admin-chat, mara-cli, code-explorer,
audit-p2). There is currently **no** unit/component/E2E layer and frontend lint
is not yet enforced in CI — see the repair roadmap.

Security automation also runs in `.github/workflows/security.yml`:
- `npm audit --audit-level=moderate`
- GitHub CodeQL for JavaScript/TypeScript
- Trivy filesystem SCA scan
- Dependabot weekly updates for npm + GitHub Actions (`.github/dependabot.yml`)

---

## Security Practices

- **Outbound URL fetches** must go through `server/lib/ssrf-guard.ts`, which
  enforces HTTPS-only access, a domain allowlist, DNS resolution checks, blocks
  private/link-local/loopback addresses, disables redirects, and caps requests
  at 5 seconds.
- **P2P/browser-compute tasks** are claimed atomically and completed only by the
  owning user/node pair; the task state machine is `pending → running → completed`.
- **Backups** use SQLite `VACUUM INTO`, run an integrity check on every snapshot,
  keep 7 daily + 4 weekly copies, optionally upload to S3-compatible storage,
  and run a monthly restore drill marker.

---

## Known Constraints

- Single SQLite instance ⇒ single-writer; suitable for the current scale, not
  for high write concurrency.
- `server/routes.ts` and `server/index.ts` are large and slated for
  decomposition.
- The migration journal has historical corruption that the boot-time self-heal
  compensates for; consolidating all DDL into versioned migrations is a planned
  follow-up that requires a production backup + restore test.
