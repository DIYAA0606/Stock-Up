# Stock-Up — Guess the Growth

> **Portfolio calculator and live leaderboard for the PICT EDC stock-prediction event.**
> Coordinators type in each team's investment chit, the software compounds capital round by round, and the projector shows a live leaderboard.

🌐 **Live Site:** [https://stock-up-sepia.vercel.app](https://stock-up-sepia.vercel.app)

---

## What is this?

**Guess the Growth** is an event-day tool for running a stock-market simulation game. Teams are given a starting capital of ₹100 Cr and invest across 12 companies over 6 rounds. After every round, actual growth figures are revealed and portfolios are automatically compounded. The projector screen shows the live leaderboard.

---

## Pages

| Page | Who uses it | PIN |
|---|---|---|
| [`/`](https://stock-up-sepia.vercel.app) | Everyone — landing page with links | None |
| [`/display.html`](https://stock-up-sepia.vercel.app/display.html) | **Projector** — shows news, growth tiles, leaderboard | None |
| [`/entry.html`](https://stock-up-sepia.vercel.app/entry.html) | **Coordinators** — type in each team's investment chit | Coordinator PIN |
| [`/admin.html`](https://stock-up-sepia.vercel.app/admin.html) | **Admin / Organiser** — run the event, set up teams, news, growth data | Admin PIN |

---

## Credentials

> ⚠️ These are the credentials for the deployed (Vercel) version.
> For local dev, PINs are printed in the terminal on startup.

| Role | PIN |
|---|---|
| Admin | `1234` |
| Coordinator | `5678` |

To change PINs on Vercel, update the environment variables:

```bash
npx vercel env add ADMIN_PIN production        # enter new PIN when prompted
npx vercel env add COORDINATOR_PIN production  # enter new PIN when prompted
npx vercel --prod --yes                        # redeploy to apply
```

---

## Running Locally

**Requirements:** Node.js 20 or newer. No additional dependencies.

```bash
git clone https://github.com/Deveshonmac/Stock-Up.git
cd Stock-Up

npm start          # Starts the server, prints admin & coordinator PINs + LAN address
npm test           # Runs the 32 automated tests
npm run demo       # Throwaway 24-team event in data-demo/ (PINs: 1111 / 2222)
npm run demo 30 12 # 30 teams, played through to step 12
```

The server prints the admin PIN, coordinator PIN, and LAN URLs on startup. Share the LAN URL with coordinators' laptops.

### Environment variables (local)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | Where state.json and backups are stored |
| `ADMIN_PIN` | *(random 4-digit)* | Override the admin PIN |
| `COORDINATOR_PIN` | *(random 4-digit)* | Override the coordinator PIN |

```bash
ADMIN_PIN=9999 COORDINATOR_PIN=1111 npm start
```

---

## Event-Day Runbook

### Setup (before the event)
1. **Admin tab → Teams**: Paste team names, one per line.
2. **Admin tab → News**: Add news items for each round (1–6).
3. **Admin tab → Growth data**: Paste the final company returns CSV.
4. **Rehearse**: Run `npm run demo` once to practise with fake data.

### Running each round
The **Run the event** tab has a single **Next** button. The flow per round is:

| Phase | What happens |
|---|---|
| **Company Info / News** | Projector shows news cards |
| **Investment Window** | Teams write down their allocations on a chit |
| **Capital Update** | Coordinators type each chit into `/entry.html` |
| **Quarter Results** | Growth tiles revealed; leaderboard updated |

After Round 6: **Final Results** reveals teams from last to first place.

### Coordinator keyboard flow
`Part of team name` → **Enter** → type amounts → **Enter** (moves between companies) → **Ctrl+Enter** (jump to readback) → **Enter** (save)

### Backups
State is saved in `data/state.json`. Timestamped backups are created in `data/backups/` every time results are revealed. On Vercel, state lives in `/tmp` (ephemeral per cold start) — use local mode for persistent state across the event.

---

## Tech Stack & Project Structure

```
Stock-Up/
├── public/             # Static frontend (served as-is)
│   ├── index.html      # Landing page
│   ├── display.html    # Projector view
│   ├── entry.html      # Coordinator chit entry
│   ├── admin.html      # Admin panel
│   ├── common.js       # Shared frontend utilities (fetch, PIN gate, clock)
│   └── style.css       # All styles
├── src/
│   ├── server.js       # Zero-dependency HTTP server + API routes
│   ├── app.js          # All game logic (advance, entry, results, CSV export)
│   ├── engine.js       # Pure portfolio math (compounding, ranking)
│   ├── store.js        # JSON-file persistence with atomic writes + audit log
│   └── seed.js         # Default 12 companies × 6 quarters seed data
├── api/
│   └── index.js        # Vercel serverless function entrypoint
├── test/               # 32 automated tests (Node built-in test runner)
├── scripts/
│   └── demo.js         # Demo mode script
├── vercel.json         # Vercel routing config
└── package.json
```

**No external runtime dependencies.** Everything runs on Node.js built-ins (`http`, `fs`, `crypto`, `path`).

---

## Game Rules (enforced by the software)

- **Starting capital:** ₹100 Cr per team (configurable before any chit is entered).
- **Rounds:** 6 quarters.
- **Investment:** A team may not invest more than its available capital. Investing in fewer than 4 companies shows a soft warning.
- **Uninvested cash:** Carries over as-is. Exit value = `invested × (1 + growth)`.
- **Growth format:** Plain numbers are fractions (`0.18` = +18%); cells ending in `%` are percentages.
- **Corrections:** Correcting an earlier chit recalculates all later rounds. The correction is refused if it would break a later round's budget.
- **Tie-break:** Equal worth shares a rank (no tie-break currently).

---

## Deployment (Vercel)

The project is deployed to Vercel using a serverless function for the API and static hosting for the frontend.

```bash
# One-time setup (already done)
npx vercel --prod --yes

# Redeploy after code changes
git push origin main   # if connected via Git integration
# or
npx vercel --prod --yes
```

**Vercel configuration** ([`vercel.json`](./vercel.json)):
- All `/api/*` requests → serverless function at `api/index.js`
- All other requests → static files from `public/`

> **Note on state persistence:** Vercel's serverless functions use ephemeral `/tmp` storage. State resets on each cold start. For a persistent event (all rounds in one session), the server stays warm. For multi-day persistence, run locally or use an external database.

---

## Tests

```bash
npm test
```

32 tests covering game logic, API routes, PIN protection, path traversal blocking, CSV export, and a full 6-round end-to-end simulation.

---

## Still open (organisers' decisions)

- Tie-break rule: equal worth currently shares a rank.
- Rounding: values are exact internally, shown to 2 decimal places.
- Whether Common vs Preferred stock exists — not modelled.
- Company names in the seed are placeholders; replace them via the Growth data tab.
