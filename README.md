# Guess the Growth

Portfolio calculator and live leaderboard for the PICT EDC stock-prediction event.
Coordinators type each team's chit in, the software compounds every team's capital round by round, and the projector shows the leaderboard.
Node 20 or newer, no dependencies.

    npm test        # 32 tests
    npm start       # prints the admin PIN, coordinator PIN and the LAN addresses
    npm run demo    # throwaway 24-team event in data-demo/ (PINs 1111 / 2222), never touches real data
    npm run demo -- 30 12   # 30 teams, played through to step 12 (0 = start, 24 = final results)

## Pages

| Page | Who | PIN |
|---|---|---|
| `/display.html` | Projector | none (never receives growth figures before they are revealed) |
| `/entry.html` | Coordinators | coordinator PIN |
| `/admin.html` | You | admin PIN |

Set your own PINs with `ADMIN_PIN=... COORDINATOR_PIN=... npm start`. Port: `PORT=3000`.

## Rules the software enforces

- 100 Cr starting capital (changeable before any chit is entered), 6 rounds.
- A chit may not invest more than the team's available capital. Anything else is a soft warning (fewer than 4 companies).
- Uninvested money stays as cash. Exit value = invested x (1 + growth). Leftover capital carries into the next round; nothing is added.
- Plain numbers in the growth sheet are fractions (0.18 = +18%); cells with a % sign are percentages.
- Corrections to an earlier chit recalculate all later rounds, and are refused if they would break a later round's budget.

## Event-day runbook

1. Admin: Teams (paste names), News (rounds 1-6), Growth data (paste the final sheet).
2. Run `npm run demo` once beforehand to rehearse with 24 teams. Real data is untouched.
3. Round loop on the Run the event tab: News, Investment Window, Capital Update, Quarter Results. The Next button warns if any team has no chit.
4. Final Results: Reveal next team counts up from last place; Reveal all shows everything.
5. Standings tab: Download CSV for the full record. State is in `data/state.json`; backups are in `data/backups/` and are written every time results are revealed.

Coordinator keyboard flow: type part of the team name, Enter; type amounts, Enter moves to the next company, Ctrl+Enter jumps to the read-back; Enter saves.

## Still open (organisers' decisions)

- Tie-break: equal worth currently shares a rank.
- Rounding: values are exact internally and shown to 2 decimals.
- Whether Common vs Preferred stock exists. Not modelled.
- The deck lists placeholder companies; replace them on the Growth data tab when final. Company names there are the seeded sheet values.
