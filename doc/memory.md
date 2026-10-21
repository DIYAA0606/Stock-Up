# Project Memory & Decision Log — Stock-Up: Guess the Growth

---

## 1. Project Background & Context

**Stock-Up (Guess the Growth)** was created for the PICT EDC (Pune Institute of Computer Technology — Entrepreneurship Development Cell) annual flagship competition. 

In this simulation, dozens of collegiate teams receive physical chits and a virtual starting capital of ₹100 Cr. Over six simulated financial quarters, teams allocate capital across 12 volatile companies based on corporate news bulletins, quarterly reports, and economic rumors. The event culminates in a live, high-energy projection screen revealing quarterly returns and dramatic leaderboard shifts.

---

## 2. Architectural Decision Records (ADRs)

### ADR-001: Zero External Runtime Dependencies
* **Context:** The software must run reliably on random student laptops, college lab computers, or venue machines that may have restrictive institutional firewalls, outdated package managers, or no internet access.
* **Decision:** Build the entire backend exclusively using Node.js standard libraries (`http`, `fs`, `crypto`, `os`, `path`), and write the frontend in vanilla HTML, CSS, and ES6 JavaScript.
* **Consequences:** 
  * Positive: `npm start` works instantly with zero `npm install` delays or proxy failures. Total repo size is tiny (< 1 MB).
  * Negative: Standard boilerplate (HTTP routing, MIME handling, body parsing) had to be written manually in [`src/server.js`](file:///Users/devesh/Downloads/guess-the-growth/src/server.js).

### ADR-002: BigInt Fixed-Point Arithmetic (Scaled by $10^6$)
* **Context:** Financial simulations compounding percentages across multiple rounds suffer from IEEE 754 floating-point drift (e.g. `0.1 + 0.2 === 0.30000000000000004`). In a competitive event with cash prizes, even a 1-paisa rounding discrepancy can cause disputes.
* **Decision:** All financial values and growth multipliers are converted to exact integers scaled by $10^6$ (`1 Cr = 1_000_000n units`, `18% = 180_000n units`) using JavaScript `BigInt` in [`src/engine.js`](file:///Users/devesh/Downloads/guess-the-growth/src/engine.js).
* **Consequences:** 
  * Positive: Mathematically exact compounding with 100% test reproducibility across all platforms.
  * Negative: Cannot directly serialize `BigInt` into native JSON; values must be converted to/from decimal strings at the boundary (`fromUnits`, `toUnits`).

### ADR-003: Atomic Filesystem Persistence (`state.json`)
* **Context:** Setting up PostgreSQL, MongoDB, or SQLite introduces native binary dependencies or external services that complicate offline LAN hosting.
* **Decision:** State is maintained in-memory and committed to `./data/state.json` using atomic temporary file renames (`fs.writeFileSync(tmp) -> fs.renameSync(tmp, file)`). Pre-action snapshots are automatically stored in `./data/backups/`.
* **Consequences:** 
  * Positive: Zero database setup; state can be inspected or edited directly using any text editor. Complete crash safety against corrupted files.
  * Negative: Not suitable for multi-threaded or multi-instance environments without external locks.

### ADR-004: Role-Based Authentication via `x-pin` Header
* **Context:** Coordinators and organizers need fast, low-friction access without managing passwords, OAuth providers, or email verification.
* **Decision:** Authenticate requests using a 4-digit numeric PIN passed in the `x-pin` HTTP header, verified against `settings.pins.admin` and `settings.pins.coordinator`.
* **Consequences:** 
  * Positive: Coordinators simply enter a 4-digit code in the browser once; it is stored in `sessionStorage` and attached to all API calls.
  * Negative: Relies on HTTPS or a private LAN to prevent network sniffing of PINs. Mitigated by an IP-based sliding window rate limiter (max 15 invalid attempts per minute).

### ADR-005: Dual Deployment (LAN Primary vs Vercel Serverless)
* **Context:** Organizers needed a public URL for previews, rehearsals, and documentation, while preserving offline LAN capability for event day.
* **Decision:** Maintain `src/server.js` for standalone LAN execution, and provide `api/index.js` wrapped by `vercel.json` for cloud deployment.
* **Consequences:** 
  * Positive: Easy cloud demo link accessible from anywhere.
  * Negative: Vercel serverless instances are ephemeral; state stored in `/tmp` resets during cold starts (see Technical Debt section).

---

## 3. Bug Audit & Fix History (Commit `44e512d`)

During the comprehensive system test and audit conducted on October 21, 2026, 6 significant bugs were identified and resolved:

| Component | Issue Identified | Root Cause | Solution Implemented |
|---|---|---|---|
| [`display.html`](file:///Users/devesh/Downloads/guess-the-growth/public/display.html) | Company details leaked on projector during Round 1 investing & entry phases. | Missing phase check in display render condition. | Added `b.phase === 'news'` guard so company cards only render during information release. |
| [`common.js`](file:///Users/devesh/Downloads/guess-the-growth/public/common.js) | Currency formatter showed raw `"₹NaN Cr"` on uninitialized or null values. | `fmt()` lacked a `NaN` guard before running numeric formatting. | Added `if (isNaN(n)) return '–';` guard. |
| [`display.html`](file:///Users/devesh/Downloads/guess-the-growth/public/display.html) | Countdown timer froze at `00:00` indefinitely after phase expired. | `tick()` did not clear `textContent` when remaining seconds reached 0 or null. | Timer display now cleans up (`textContent = ''`) as soon as time expires. |
| [`common.js`](file:///Users/devesh/Downloads/guess-the-growth/public/common.js) | Submitting an empty PIN field exhausted the 15-attempt rate limiter. | Empty strings were sent to `/api/auth`, counting as invalid attempts. | Added client-side empty string check in `gate()` before dispatching network request. |
| [`admin.html`](file:///Users/devesh/Downloads/guess-the-growth/public/admin.html) | News editor UI was limited to 3 items, but server accepted 6. | Admin template hardcoded only 3 input fields. | Expanded the admin news editor form to support 6 full news headlines per round. |
| [`display.html`](file:///Users/devesh/Downloads/guess-the-growth/public/display.html) | Projector screen gave no indication if host laptop lost Wi-Fi connection. | Silent fetch failures in `poll()` loop without visual error state. | Added connection tracker; displays red `● connection lost` indicator after 3 consecutive failures. |

---

## 4. Known Technical Debt & Watch-outs

### 1. Ephemeral State on Vercel Serverless
* **Symptoms:** When hosted on Vercel, if the serverless function goes idle (cold start) or shifts to another lambda container, game state resets back to the initial seed state.
* **Status:** Expected architectural behavior of serverless diskless functions. Documented.
* **Remedy for Team:** Do **NOT** use the Vercel link for the actual live event. Use `npm start` on a local laptop connected to the venue Wi-Fi, or deploy to Railway/Render.

### 2. Multi-Instance Concurrency
* **Symptoms:** If multiple users access a serverless deployment simultaneously, requests may hit different lambda instances whose `/tmp/state.json` copies diverge.
* **Status:** Avoided completely when running in single-process LAN mode.

### 3. HTTP Polling vs WebSockets / SSE
* **Symptoms:** Clients poll `/api/state` every 2 seconds. While lightweight (< 1KB per response), real-time updates have up to a 2-second delay.
* **Status:** Acceptable for current event pace. Potential candidate for future Server-Sent Events (SSE) refactor.

---

## 5. Recommended Next Steps for the Team

1. **Host Event Locally:** Always run `npm start` on the host laptop on event day. Connect coordinators and projector to the host laptop's local IP address (`http://192.168.x.x:3000`).
2. **If Cloud Hosting is Required:**
   * Option A (Fastest): Deploy `src/server.js` directly to **Railway**, **Render**, or **Fly.io** as an always-on Node process.
   * Option B: Replace `src/store.js` file reads/writes with an external cloud KV database (such as **Upstash Redis** or **Supabase**).
