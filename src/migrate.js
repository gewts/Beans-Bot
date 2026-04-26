const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DATA_PATH = path.join(__dirname, "..", "data.json");
const DB_PATH = path.join(__dirname, "beans.db");

if (!fs.existsSync(DATA_PATH)) {
  console.error("❌ data.json not found at", DATA_PATH);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = OFF");

// Run schema (same as store.js so we can run migrate standalone)
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    balance INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS markets (
    market_id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    line REAL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    odds_locked INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    created_at INTEGER,
    pick_a_label TEXT,
    pick_a_odds INTEGER,
    pick_b_label TEXT,
    pick_b_odds INTEGER,
    prop_player TEXT,
    prop_stat TEXT,
    prop_kind TEXT,
    teamtotal_team TEXT,
    teamtotal_stat TEXT,
    teamtotal_kind TEXT
  );
  CREATE TABLE IF NOT EXISTS bets (
    bet_id INTEGER PRIMARY KEY,
    market_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    stake INTEGER NOT NULL,
    pick TEXT NOT NULL,
    odds INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    placed_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS parlays (
    parlay_id INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'BUILDING',
    stake INTEGER,
    created_at INTEGER,
    placed_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS parlay_legs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parlay_id INTEGER NOT NULL,
    market_id INTEGER NOT NULL,
    market_type TEXT NOT NULL,
    pick TEXT NOT NULL,
    label_snapshot TEXT,
    odds_snapshot INTEGER NOT NULL,
    result TEXT NOT NULL DEFAULT 'PENDING',
    FOREIGN KEY (parlay_id) REFERENCES parlays(parlay_id)
  );
  CREATE TABLE IF NOT EXISTS pending_confirms (
    nonce TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 1
  );
  INSERT OR IGNORE INTO counters (name, value) VALUES ('nextMarketId', 1);
  INSERT OR IGNORE INTO counters (name, value) VALUES ('nextBetId', 1);
  INSERT OR IGNORE INTO counters (name, value) VALUES ('nextParlayId', 1);
`);

console.log("🔁 Starting migration from data.json → beans.db...\n");

const migrate = db.transaction(() => {
  // ---- Users ----
  const insertUser = db.prepare(
    "INSERT OR IGNORE INTO users (user_id, balance) VALUES (?, ?)"
  );
  let userCount = 0;
  for (const [userId, u] of Object.entries(data.users || {})) {
    insertUser.run(userId, u.balance ?? 0);
    userCount++;
  }
  console.log(`✅ Users migrated: ${userCount}`);

  // ---- Markets ----
  const insertMarket = db.prepare(`
    INSERT OR IGNORE INTO markets (
      market_id, type, title, line, status, odds_locked, created_by, created_at,
      pick_a_label, pick_a_odds, pick_b_label, pick_b_odds,
      prop_player, prop_stat, prop_kind,
      teamtotal_team, teamtotal_stat, teamtotal_kind
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let marketCount = 0;
  for (const [, m] of Object.entries(data.markets || {})) {
    insertMarket.run(
      m.marketId, m.type, m.title, m.line ?? null,
      m.status ?? "OPEN", m.oddsLocked ? 1 : 0,
      m.createdBy ?? null, m.createdAt ?? null,
      m.picks?.A?.label ?? null, m.picks?.A?.odds ?? null,
      m.picks?.B?.label ?? null, m.picks?.B?.odds ?? null,
      m.prop?.player ?? null, m.prop?.stat ?? null, m.prop?.kind ?? null,
      m.teamtotal?.team ?? null, m.teamtotal?.stat ?? null, m.teamtotal?.kind ?? null
    );
    marketCount++;
  }
  console.log(`✅ Markets migrated: ${marketCount}`);

  // ---- Bets ----
  const insertBet = db.prepare(`
    INSERT OR IGNORE INTO bets (bet_id, market_id, user_id, stake, pick, odds, status, placed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let betCount = 0;
  for (const [, b] of Object.entries(data.bets || {})) {
    insertBet.run(
      b.betId, b.marketId, b.userId,
      b.stake, b.pick, b.odds,
      b.status ?? "OPEN", b.placedAt ?? null
    );
    betCount++;
  }
  console.log(`✅ Bets migrated: ${betCount}`);

  // ---- Parlays + Legs ----
  const insertParlay = db.prepare(`
    INSERT OR IGNORE INTO parlays (parlay_id, user_id, status, stake, created_at, placed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertLeg = db.prepare(`
    INSERT INTO parlay_legs (parlay_id, market_id, market_type, pick, label_snapshot, odds_snapshot, result)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  let parlayCount = 0;
  let legCount = 0;
  for (const [, p] of Object.entries(data.parlays || {})) {
    insertParlay.run(
      p.parlayId, p.userId, p.status ?? "BUILDING",
      p.stake ?? null, p.createdAt ?? null, p.placedAt ?? null
    );
    for (const leg of (p.legs || [])) {
      insertLeg.run(
        p.parlayId, leg.marketId, leg.marketType,
        leg.pick, leg.labelSnapshot, leg.oddsSnapshot,
        leg.result ?? "PENDING"
      );
      legCount++;
    }
    parlayCount++;
  }
  console.log(`✅ Parlays migrated: ${parlayCount} (${legCount} legs)`);

  // ---- Counters ----
  const setCounter = db.prepare(
    "INSERT OR REPLACE INTO counters (name, value) VALUES (?, ?)"
  );
  setCounter.run("nextMarketId", data.nextMarketId ?? 1);
  setCounter.run("nextBetId", data.nextBetId ?? 1);
  setCounter.run("nextParlayId", data.nextParlayId ?? 1);
  console.log(`✅ Counters: nextMarketId=${data.nextMarketId} nextBetId=${data.nextBetId} nextParlayId=${data.nextParlayId}`);
});

migrate();

console.log("\n🎉 Migration complete! beans.db is ready.");
db.close();
