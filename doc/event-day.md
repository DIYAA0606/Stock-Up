# Event Day Guide — Guess the Growth

## Before You Leave Home (~30 min)

1. **Edit start-event.bat** — set a real SESSION_SECRET (any long random string) and a memorable ADMIN_PIN (4–8 digits).
2. **Back up data** — copy the data/ folder to data-backup-YYYYMMDD/ before the event starts.
3. **Replace the matrix** — open config/returns.csv and fill in the real quarter-by-quarter growth percentages for all 10 stocks, OR paste the CSV into the admin panel under **Growth data** tab. The admin panel shows a **SAMPLE DATA** badge until you do this.

## On Arrival (laptop setup)

4. **Plug in power** — disable sleep: Settings → System → Power & Sleep → set all to "Never".
5. **Allow port 3000** — run once (as admin) if teams can't connect:
   `
   netsh advfirewall firewall add rule name="GTG-3000" dir=in action=allow protocol=TCP localport=3000
   `
6. **Network** — use a hotspot or router that allows device-to-device traffic. Some college Wi-Fi blocks it; a personal hotspot always works.
7. **Double-click start-event.bat** — the console will print the LAN IP and URLs:
   - Admin: http://<LAN-IP>:3000/admin.html
   - Coordinators: http://<LAN-IP>:3000/coordinator.html
   - Projector: http://<LAN-IP>:3000/display.html

## During the Event

### Coordinator Workflow
1. Coordinator opens coordinator.html and logs in with their **code** (e.g. C03) and **PIN**.
2. If their team needs a rumor: coordinator presses **Buy rumor (5 Cr)** → confirm → 5 Cr is immediately and permanently deducted. *Only then* hand over the chit.
3. Coordinator enters allocations for each stock (minimum 1 Cr or 0; amounts between 0 and 1 are rejected).
4. Press **Review chit** → **Confirm & submit**.

### Admin Workflow
- Use the **Control** tab to advance phases (Info → Investment Window → Capital Update → Reveal).
- The **Standings** tab shows the live chit dashboard — red rows = teams that have not submitted yet.
- Leaderboard is public after Q1 and Q2. Q3 and Q4 standings are hidden from the projector and coordinators; only the admin console shows them.
- After Q4 is revealed, click **Advance** → Final Ceremony → use **Reveal next team** to unveil from last place upward.

## Adjustments & Corrections

- **Admin can correct a chit** at any time from the Coordinator portal (admin login bypasses phase restriction).
- **Rumor count adjustments**: admin can increase/decrease rumor count from the admin panel (with audit log).

## Recovery

- **Server crash** — double-click start-event.bat again. State is persisted in data/state.json; nothing is lost.
- **Restore from backup** — copy files from data/backups/ (a backup is written at every quarter reveal) back into data/.
- **Wrong returns matrix** — paste corrected CSV in admin panel → Growth data tab → Save.

## After the Event

- Download the full results CSV from the **Standings** tab in admin.
- Back up data/ again.
