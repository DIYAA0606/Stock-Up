# Team Handover Guide & Operations Runbook — Stock-Up: Guess the Growth

---

## 1. Quick Start for New Developers

### Prerequisites
* **Node.js:** Version 20.0.0 or higher.
* **No external packages required:** The core project runs with pure standard library modules.

### Commands Cheat Sheet
```bash
# 1. Clone the repository
git clone https://github.com/Deveshonmac/Stock-Up.git
cd Stock-Up

# 2. Start the local server
npm start
# Output prints the Admin PIN, Coordinator PIN, and local network URLs.

# 3. Run automated tests (All 32 tests must pass)
npm test

# 4. Launch a simulated test event (24 teams pre-loaded, PINs: 1111 / 2222)
npm run demo

# 5. Launch a custom demo (e.g. 30 teams simulated up to step 12)
npm run demo 30 12
```

---

## 2. Repository Layout

```text
guess-the-growth/
├── README.md               # Quick overview & live links
├── package.json            # Node scripts and engine requirements
├── vercel.json             # Vercel serverless rewrite rules
├── doc/                    # Complete team handover documentation
│   ├── prd.md              # Product requirements, personas, rules
│   ├── architecture.md     # System architecture, schemas, API reference
│   ├── memory.md           # Decision log (ADRs), audit history, tech debt
│   └── handover.md         # This operational runbook
├── api/
│   └── index.js            # Serverless adapter for Vercel deployment
├── src/
│   ├── server.js           # HTTP server, static asset router, rate limiter
│   ├── app.js              # State machine, validations, round timeline
│   ├── store.js            # JSON persistence, atomic saves, audit logging
│   ├── engine.js           # Exact BigInt financial math & compounding
│   └── seed.js             # Default company returns CSV fallback
├── public/                 # Frontend client single-page applications
│   ├── index.html          # Public landing page with role links
│   ├── display.html        # Projector display view (news, timer, rankings)
│   ├── entry.html          # Coordinator chit-entry form (keyboard-optimized)
│   ├── admin.html          # Organizer command center & configuration
│   ├── common.js           # Shared utilities (gate auth, fmt, toast, api)
│   └── style.css           # Global design system & theme variables
├── data/                   # Persistent runtime data directory (ignored by git)
│   ├── state.json          # Master application state
│   ├── audit.log           # Structured JSON-lines audit trail
│   └── backups/            # Pre-action timestamped snapshots
├── scripts/
│   └── demo.js             # Automated event simulator for rehearsals
└── test/
    └── *.test.js           # Comprehensive automated test suite (32 tests)
```

---

## 3. Configuration & Environment Variables

| Variable | Default Value | Description |
|---|---|---|
| `PORT` | `3000` | Port for the HTTP server to listen on. |
| `DATA_DIR` | `./data` | Filepath where `state.json`, `audit.log`, and `backups/` reside. |
| `ADMIN_PIN` | *Random 4-digit* | Overrides the administrative PIN for `/admin.html`. |
| `COORDINATOR_PIN` | *Random 4-digit* | Overrides the coordinator PIN for `/entry.html`. |

**Example starting with fixed credentials:**
```bash
ADMIN_PIN=9434 COORDINATOR_PIN=5121 npm start
```

---

## 4. Event-Day Operations Playbook

### 4.1 Pre-Event Setup (60 Minutes Before Start)
1. **Network Setup:**
   * Connect the Host Laptop to the event Wi-Fi router (or phone hotspot).
   * Run `npm start`. Note the printed LAN address (e.g. `http://192.168.1.45:3000`).
2. **Projector Setup:**
   * Connect projector to a display laptop (or secondary monitor on host).
   * Open `http://<HOST_IP>:3000/display.html` in Chrome/Brave. Press `F11` for full screen.
3. **Coordinator Laptops:**
   * Have coordinators navigate to `http://<HOST_IP>:3000/entry.html`.
   * Provide them with the **Coordinator PIN**.
4. **Data Verification in `/admin.html`:**
   * Open `http://<HOST_IP>:3000/admin.html` and enter the **Admin PIN**.
   * **Teams Tab:** Paste the confirmed registered team list, one per line.
   * **News Tab:** Verify news headlines for all 6 rounds are populated.
   * **Growth Tab:** Verify the final company returns matrix matches the secret spreadsheet.
   * Click **Reset Event** to ensure fresh clean state for Round 1.

---

### 4.2 Running Each Round (Organizer Flow)

Each round proceeds strictly through the following four steps in `/admin.html`:

```text
[1. News / Info] ──> [2. Investment Window] ──> [3. Capital Update] ──> [4. Quarter Results]
```

1. **Step into News:**
   * Announce the round. The projector displays the news cards automatically.
   * The countdown timer starts automatically (default: 5 mins).
2. **Step into Investment Window:**
   * Teams have 10 minutes to formulate strategy and fill physical chits.
   * Projector displays countdown timer.
3. **Step into Capital Update:**
   * Runners collect physical chits and distribute them across Coordinator laptops.
   * Coordinators enter allocations in `/entry.html`.
   * Admin monitors the entry progress counter in `/admin.html` (e.g. `24 / 24 submitted`).
4. **Step into Quarter Results:**
   * Click **Next Phase**.
   * Projector dynamically reveals company return percentages (green/red) and updates the leaderboard live.

---

### 4.3 Coordinator Speed Entry (`/entry.html`)

The entry form is built specifically for ultra-fast, mouse-free numeric entry:
* Type part of the team name (e.g. `alp` for `Alpha Traders`) $\rightarrow$ Press `Enter`.
* Focus automatically moves to the first company.
* Type allocation amount in Cr (e.g. `25` or `15.5`) $\rightarrow$ Press `Enter` to jump to the next company.
* Real-time cash balance updates at the bottom.
* Press `Ctrl + Enter` (or `Cmd + Enter`) at any point to jump straight to the submission modal.
* Press `Enter` to confirm and save.

---

### 4.4 Final Results Reveal (Post Round 6)

When Round 6 Quarter Results conclude, clicking **Next Phase** enters **Final Results** mode:
* The projector switches to a dramatic podium screen.
* In `/admin.html`, click **Reveal Next Team** to step backwards through the leaderboard from last place to 1st place (winner).

---

## 5. Emergency & Disaster Recovery Procedures

### Scenario A: Admin Accidentally Clicked "Next Phase" Too Early
* **Fix:** Click the **Back** button in `/admin.html`. The system automatically steps back one phase. An automated snapshot backup is saved before the rollback occurs.

### Scenario B: Coordinator Entered Wrong Number on a Submitted Chit
* **Fix:** 
  1. Have the coordinator search for the same team again in `/entry.html`.
  2. The previous round entries will pre-populate.
  3. Correct the mistake and submit again. Submissions for the current round overwrite cleanly.

### Scenario C: Host Laptop Crashes or Restarts
* **Fix:**
  1. Restart the laptop and re-open terminal.
  2. Run `npm start`.
  3. The system immediately reads `data/state.json` and resumes *exactly* at the step, round, and allocation state where it left off.
  4. Display screens will reconnect automatically within 2 seconds.

---

## 6. Deployment & Migration Recommendations

### If Moving to a Dedicated Cloud Server (Railway / Render / Fly.io):
1. Create a new service pointing to your GitHub repository.
2. Set build command: *(none)*
3. Set start command: `npm start`
4. Set persistent volume mounted to `/data` (if supported).
5. Set environment variables:
   * `ADMIN_PIN`: Your secret admin code.
   * `COORDINATOR_PIN`: Your secret coordinator code.
   * `PORT`: `8080` (or as provided by host).

### If Staying on Vercel:
* Vercel serverless lambdas are stateless and wipe `/tmp` on cold restart.
* If you must host long-term on Vercel, replace the file writes in [`src/store.js`](file:///Users/devesh/Downloads/guess-the-growth/src/store.js) with an asynchronous key-value store such as **Upstash Redis** (`@upstash/redis`).
