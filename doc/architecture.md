# System Architecture — Stock-Up: Guess the Growth

---

## 1. High-Level Architecture Overview

Stock-Up is structured as a **monolithic, zero-dependency Node.js application** serving both static frontend assets and a lightweight JSON REST API. 

The system is deliberately designed to operate in two execution environments:
1. **Local LAN Mode (Primary / Intended for Event Day):** An always-on single Node.js process serving clients over a local Wi-Fi router. State is held in-memory and synchronized atomically to disk.
2. **Serverless Cloud Mode (Current Vercel Deployment):** Running via Vercel Serverless Functions (`api/index.js`), using `/tmp` storage and seeded state.

```mermaid
graph TD
    subgraph Client Layer (Browsers)
        D[Projector Display<br/>/display.html]
        E[Coordinator Laptop<br/>/entry.html]
        A[Admin Laptop<br/>/admin.html]
    end

    subgraph Transport & Security
        H[HTTP REST API<br/>x-pin header auth]
        RL[IP Sliding-Window Rate Limiter<br/>15 bad PINs / min]
    end

    subgraph Application Core (Node.js)
        SRV[server.js<br/>HTTP Router & MIME Dispatcher]
        APP[app.js<br/>Timeline State Machine & Rules]
        ENG[engine.js<br/>BigInt Exact Scaling Engine]
        STR[store.js<br/>State Cache & Atomic File I/O]
    end

    subgraph Persistence Layer
        SJ[(state.json<br/>Single Source of Truth)]
        BK[(/backups<br/>Pre-action Snapshots)]
        AL[(audit.log<br/>Append-only Event Log)]
    end

    D -- "Polls GET /api/state (Every 2s)" --> H
    E -- "POST /api/entry (x-pin: coordinator)" --> H
    A -- "POST /api/step (x-pin: admin)" --> H

    H --> RL
    RL --> SRV
    SRV --> APP
    APP --> ENG
    APP --> STR
    STR --> SJ
    STR --> BK
    STR --> AL
```

---

## 2. Technology Stack

| Layer | Technology | Rationale |
|---|---|---|
| **Runtime** | Node.js $\ge 20$ (ES Modules) | Native support for modern JS features, native `--test` runner, and built-in crypto. |
| **HTTP Server** | Built-in `node:http` | Eliminates Express/Fastify dependencies; zero npm install step on venue laptops. |
| **Persistence** | Filesystem JSON (`node:fs`) | Human-readable, zero-setup, portable, inspectable in any text editor. |
| **Financial Engine** | JavaScript `BigInt` (Fixed-point scaled $10^6$) | Prevents floating-point rounding bugs (`0.1 + 0.2 = 0.30000000000000004`). |
| **Frontend UI** | Vanilla HTML5, CSS3, ES6 JavaScript | Zero build step (no Webpack, Vite, or Babel), instant browser reloads, minimal footprint. |
| **Deployment** | Vercel Serverless (`vercel.json`) & Local Node | Deploys on edge for previews; runs standalone on bare-metal for events. |

---

## 3. Core Modules & Responsibilities

### 3.1 Mathematical Engine ([`src/engine.js`](file:///Users/devesh/Downloads/guess-the-growth/src/engine.js))
- **Scale Factor:** `SCALE = 1_000_000n` ($10^6$).
- `toUnits(input)`: Parses float/string values into exact integer scaled `BigInt`.
- `fromUnits(bigint)`: Formats scaled integers back to readable decimal strings without trailing zeroes.
- `parseGrowth(token)`: Standardizes inputs like `"0.18"`, `"-6%"`, `"-100%"` into scaled integers. Clamps negative growth at `-SCALE` ($-100\%$).
- `computeTeam(team, roundsReturns, startingCapital)`: Performs exact multi-round compounding across all 12 company positions and uninvested cash reserves.
- `rankItems(items, keyFn)`: Produces deterministic sorted leaderboard rankings.

### 3.2 State Store & Persistence ([`src/store.js`](file:///Users/devesh/Downloads/guess-the-growth/src/store.js))
- **In-Memory Cache:** `this.state` holds the master state object for sub-millisecond read access during polling.
- **Atomic Writes:** Saves are performed by writing to `state.json.tmp` and executing an atomic `fs.renameSync` over `state.json` to prevent file corruption during sudden crashes.
- **Snapshot Backups:** Automatically invokes `backup(label)` creating timestamped snapshots in `data/backups/state-<timestamp>-<action>.json` before any destructive mutation.
- **Audit Logging:** Appends structured JSON lines to `data/audit.log` tracking `{ at, who, action, detail }`.

### 3.3 Domain Logic & State Machine ([`src/app.js`](file:///Users/devesh/Downloads/guess-the-growth/src/app.js))
- **Timeline Generator:** `steps(rounds)` creates an array of 25 step descriptors:
  - Steps 0–23: Rounds 1 to 6 through `['news', 'investing', 'entry', 'revealed']`.
  - Step 24: `'final'` reveal step.
- **Phase Transition Safeguards:**
  - `step(st)`: Advances forward; enforces un-entered team defaults (all cash carried forward) and records audit markers.
  - `back(st)`: Steps backward to rectify organizer mistakes.
- **Allocations & Chit Validation:**
  - Validates that team investments do not exceed current uninvested cash.
  - Enforces 2-decimal limit.
  - Rejects allocations after round phase has passed.

### 3.4 HTTP Server & Authorization ([`src/server.js`](file:///Users/devesh/Downloads/guess-the-growth/src/server.js))
- Serves static assets from `public/` directory with correct MIME types.
- **Role-Based Auth:** Inspects `x-pin` HTTP request header against `state.settings.pins.admin` and `state.settings.pins.coordinator`.
- **Brute-Force Rate Limiting:** Sliding 60-second window tracking client IPs. Rejects clients exceeding 15 bad PIN submissions with `HTTP 429 Too Many Requests`.

### 3.5 Vercel Serverless Adapter ([`api/index.js`](file:///Users/devesh/Downloads/guess-the-growth/api/index.js))
- Adapts the native Node HTTP handler into Vercel’s serverless function interface.
- Points `DATA_DIR` to `os.tmpdir()/guess-the-growth-data` and seeds initial state from `data/state.json`.

---

## 4. State Schema Specification

The master state object stored in `state.json` conforms to the following structure:

```json
{
  "version": 1,
  "settings": {
    "startingCapital": "100",
    "rounds": 6,
    "durations": { "info": 20, "news": 5, "investing": 10, "entry": 5 },
    "pins": { "admin": "1234", "coordinator": "5678" }
  },
  "companies": [
    {
      "id": "c1",
      "name": "Reliance Industries",
      "sector": "Energy / Retail",
      "description": "Conglomerate holding dominant positions in oil-to-chemicals, telecom (Jio), and retail.",
      "returns": ["0.12", "-0.04", "0.22", "0.08", "-0.15", "0.19"]
    }
  ],
  "nextCompanyId": 12,
  "teams": [
    { "id": "t1", "name": "Alpha Traders" }
  ],
  "nextTeamId": 1,
  "news": {
    "1": ["Reserve Bank keeps repo rate unchanged.", "Global crude drops 4%."],
    "2": ["Tech rally driven by cloud AI announcements."]
  },
  "allocations": {
    "1": {
      "t1": { "c1": "25.00", "c3": "15.50" }
    }
  },
  "step": 0,
  "phaseStartedAt": 1729512345000,
  "phaseEndsAt": 1729513545000,
  "finalReveal": 0
}
```

---

## 5. REST API Reference

| Endpoint | Method | Required Role | Description |
|---|---|---|---|
| `/api/bootstrap` | `GET` | Public | Returns initial UI bootstrap payload (company list, round count, starting capital). |
| `/api/state` | `GET` | Public / Role-filtered | Returns current game state, active phase, remaining timer, and standings. Sanitizes future returns. |
| `/api/auth` | `POST` | Public (`x-pin`) | Validates a PIN and returns authorized role (`admin` or `coordinator`). |
| `/api/step` | `POST` | Admin | Advances the event to the next phase. |
| `/api/back` | `POST` | Admin | Rolls back the timeline to the previous phase. |
| `/api/timer` | `POST` | Admin | Adjusts timer countdown (sets duration, pauses, or resets). |
| `/api/entry` | `POST` | Coordinator / Admin | Records a team's investment chit for the active round. |
| `/api/teams` | `POST` | Admin | Overwrites or registers team list. |
| `/api/news` | `POST` | Admin | Saves news headlines for a specific round. |
| `/api/returns` | `POST` | Admin | Updates the secret returns matrix for companies. |
| `/api/pins` | `POST` | Admin | Rotates the administrative and coordinator PINs. |
| `/api/reveal` | `POST` | Admin | Advances step-by-step reveals during the final podium phase. |
| `/api/reset` | `POST` | Admin | Resets state to Round 1 initial conditions. |

---

## 6. Deployment Models & Architectural Trade-offs

### 6.1 Model Comparison

| Attribute | Local LAN Server (`src/server.js`) | Serverless Deployment (`api/index.js` on Vercel) |
|---|---|---|
| **Intended Use** | Event Day Live Execution | Previews, Demos & Remote Testing |
| **State Persistence** | **Persistent Disk:** Stored in `./data/state.json`. Survives reboots. | **Ephemeral `/tmp`:** Reset on cold lambda starts. |
| **Concurrency** | Single Node process; guaranteed zero write collisions. | Multiple concurrent lambdas can cause state divergence. |
| **Network Dependency** | Completely offline (uses local Wi-Fi router). | Requires 100% stable internet connectivity. |
| **Setup Cost** | Run `npm start` on 1 laptop. | Instant zero-install cloud link. |

> [!WARNING]
> **Production Recommendation for Event Day:**
> Always run **Local LAN Mode** (`npm start`) on the event laptop. If a cloud-hosted version is required for remote participants, deploy `src/server.js` as an always-on persistent container on **Railway, Render, or Fly.io**, rather than serverless functions.
