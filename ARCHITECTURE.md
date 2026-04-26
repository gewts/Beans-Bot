# Beans Bot — Architecture & Conventions

## Purpose
A Discord sportsbook bot for Eastern Men's Lacrosse (D3) alumni to bet with a virtual currency called **Beans**. Purely for fun. May expand to Eastern Men's Football in the future.

## Hosting
- **Device:** Raspberry Pi 5 (2GB RAM)
- **Storage:** 128GB NVMe SSD (boots from NVMe, no SD card)
- **Process manager:** PM2 (`pm2 start src/index.js --name beans-bot`)
- **Auto-start:** PM2 systemd service enabled (`pm2 startup` + `pm2 save`)
- **SSH:** `ssh gewt@pi-bot.local`
- **Project path:** `/home/gewt/Beans-Bot/`

## Stack
- **Runtime:** Node.js v20 (via NVM)
- **Discord library:** discord.js v14
- **Database:** SQLite via better-sqlite3
- **Config:** dotenv (`.env` in project root, gitignored)

## Project Structure
```
Beans-Bot/
├── src/
│   ├── index.js          # All bot logic, command handlers, button handlers
│   ├── store.js          # All SQLite DB access functions
│   ├── migrate.js        # One-time migration from data.json → beans.db
│   └── register-commands.js  # Slash command registration (run once after changes)
├── beans.db              # SQLite database (gitignored)
├── .env                  # DISCORD_TOKEN, CLIENT_ID, GUILD_ID (gitignored)
├── package.json
└── ARCHITECTURE.md       # This file
```

## Database Schema
Tables: `users`, `markets`, `bets`, `parlays`, `parlay_legs`, `pending_confirms`, `counters`

### users
| column | type | notes |
|---|---|---|
| user_id | TEXT PK | Discord user ID |
| balance | INTEGER | Bean balance |

### markets
| column | type | notes |
|---|---|---|
| market_id | INTEGER PK | Auto from counter |
| type | TEXT | ML, SPREAD, TOTAL, TEAMTOTAL, PROP |
| title | TEXT | Display name |
| line | REAL | Spread/total/prop line |
| status | TEXT | OPEN, LOCKED, SETTLED |
| odds_locked | INTEGER | 0/1 — freeze odds movement while OPEN |
| pick_a_label | TEXT | Label for side A |
| pick_a_odds | INTEGER | American odds for A |
| pick_b_label | TEXT | Label for side B |
| pick_b_odds | INTEGER | American odds for B |
| prop_player | TEXT | PROP only |
| prop_stat | TEXT | PROP only: GOALS or PENALTIES |
| teamtotal_team | TEXT | TEAMTOTAL only: always "Eastern" |
| teamtotal_stat | TEXT | TEAMTOTAL only: GOALS or PENALTIES |

### bets
| column | type | notes |
|---|---|---|
| bet_id | INTEGER PK | Auto from counter |
| market_id | INTEGER | FK to markets |
| user_id | TEXT | Discord user ID |
| stake | INTEGER | Beans wagered |
| pick | TEXT | A or B |
| odds | INTEGER | American odds snapshot at bet time |
| status | TEXT | OPEN, WON, LOST, PUSH |
| placed_at | INTEGER | Unix timestamp |

### parlays
| column | type | notes |
|---|---|---|
| parlay_id | INTEGER PK | Auto from counter |
| user_id | TEXT | Discord user ID |
| status | TEXT | BUILDING, OPEN, SETTLED |
| stake | INTEGER | Beans wagered (null until placed) |
| placed_at | INTEGER | Unix timestamp |

### parlay_legs
| column | type | notes |
|---|---|---|
| id | INTEGER PK | Autoincrement |
| parlay_id | INTEGER | FK to parlays |
| market_id | INTEGER | FK to markets |
| market_type | TEXT | ML, SPREAD, TOTAL, TEAMTOTAL, PROP |
| pick | TEXT | A or B |
| label_snapshot | TEXT | Label locked at place time |
| odds_snapshot | INTEGER | Odds locked at place time |
| result | TEXT | PENDING, WON, LOST, PUSH |

### pending_confirms
Stores ephemeral bet/parlay confirmations (button flows). Cleaned up on expiry (60s TTL).

### counters
Stores nextMarketId, nextBetId, nextParlayId.

## Key Constants (src/index.js)
```javascript
BOOK_ROLE_NAME = "Book"      // Discord role for book operators
CURRENCY = "Beans"
MOVE_EVERY_BET = true        // Move odds on every bet
MIN_STAKE_TO_MOVE = 1        // Min stake to trigger odds move
ODDS_STEP = 15               // Odds move by this per bet
ODDS_MIN = -5000
ODDS_MAX = 5000
MAX_WAGER = 50               // Max beans per bet or parlay
CONFIRM_TIMEOUT_MS = 60000   // 60 seconds to confirm a bet
DEFAULT_ODDS = -120          // Default odds when none specified
```

## Odds System
- American odds throughout
- `americanToDecimal()` converts for payout math
- `calcPayout(stake, odds)` → `{ payout, profit }`
- `calcParlayPayout(stake, legs)` → `{ payout, profit, combinedDecimal }`
- Odds move automatically on each bet via `applyOddsStepToMarket(market, side, steps)`
- Odds movement can be frozen per market (`oddsLocked = true`) while still allowing betting
- `normalizeAmericanOdds()` prevents weird values like -60 (flips to plus money)

## Market Types
| type | description | notes |
|---|---|---|
| ML | Moneyline | Team A vs Team B |
| SPREAD | Point spread | Requires line |
| TOTAL | Game total O/U | Requires line |
| TEAMTOTAL | Team-specific total | Always "Eastern", requires stat + line |
| PROP | Player prop | OVER only, GOALS or PENALTIES, requires player + stat + line |

## Roles & Permissions
- **Regular users:** bet, parlay, bank, market list, open, history, leaderboard
- **Book role:** all of the above + /bookmarket (create, lock, unlock, settle, nudge, odds)
- **Admin:** all of the above + /adminbank, /adminhistory, /book stats, view other users' data

## Command Reference

### Public
- `/ping` — health check
- `/help` — usage guide
- `/bank balance [user]` — check bean balance
- `/market list` — view open/locked markets
- `/bet place type stake pick` — straight bet (ML, SPREAD, TOTAL, TEAMTOTAL only)
- `/parlay start` — start parlay builder
- `/parlay addline type pick` — add ML/SPREAD/TOTAL/TEAMTOTAL leg
- `/parlay addprop player stat` — add PROP leg (OVER only)
- `/parlay remove leg` — remove leg by number
- `/parlay cancel` — cancel builder
- `/parlay place stake` — place parlay
- `/open [user]` — view open tickets
- `/history view [user]` — paginated settled history
- `/leaderboard` — top 5 by net beans

### Book Role
- `/bookmarket create type title [line] [player] [stat] [a_label] [b_label] [a_odds] [b_odds]`
- `/bookmarket lock market_id`
- `/bookmarket lockall`
- `/bookmarket unlock market_id`
- `/bookmarket unlockall`
- `/bookmarket odds market_id locked`
- `/bookmarket nudge market_id side [steps]`
- `/bookmarket settle market_id result`
- `/bookmarket risk` — operator risk dashboard

### Admin Only
- `/adminbank give user amount`
- `/adminbank take user amount`
- `/adminhistory clear user`
- `/book stats`

## Conventions
- All DB access goes through `store.js` — never raw SQL in `index.js`
- History pagination is in-memory (`historyPages` object) — not persisted, 10min TTL
- Pending confirms stored in DB with 60s TTL, cleaned on each button interaction
- Parlay legs locked to odds snapshot at confirm time, not at addline time
- PROP markets are OVER-only (always pick A)
- TEAMTOTAL always uses "Eastern" as the team
- `beans.db` lives in project root, gitignored
- `.env` gitignored, `.env.example` committed
- Errors logged to console via PM2, viewable with `pm2 logs beans-bot`

## Deployment Workflow
1. Edit files on Pi via SSH or SCP from Windows PC
2. Test with `node src/index.js` (Ctrl+C to stop)
3. Restart bot: `pm2 restart beans-bot`
4. Push to GitHub: `git add . && git commit -m "message" && git push`
5. If slash commands changed: `node src/register-commands.js`

## Future Plans
- Predictive odds model (Elo + stats + manual inputs) for suggested odds
- Possibly expand to Eastern Men's Football (separate bot instance or sport flag)

## Session Paste
Copy this at the start of each Claude session:
> "This is Beans Bot — a Discord sportsbook for Eastern D3 lacrosse alumni. Stack: Node.js, discord.js v14, better-sqlite3, PM2 on Raspberry Pi 5. Project at /home/gewt/Beans-Bot on pi-bot.local. See ARCHITECTURE.md for full details."
