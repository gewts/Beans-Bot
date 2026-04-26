const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "beans.db");
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// -------------------- Schema --------------------
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

// -------------------- Counter helpers --------------------
function getNextId(name) {
  const row = db.prepare("SELECT value FROM counters WHERE name = ?").get(name);
  const id = row.value;
  db.prepare("UPDATE counters SET value = value + 1 WHERE name = ?").run(name);
  return id;
}

// -------------------- Users --------------------
function getUser(userId) {
  let user = db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId);
  if (!user) {
    db.prepare("INSERT INTO users (user_id, balance) VALUES (?, 0)").run(userId);
    user = { user_id: userId, balance: 0 };
  }
  return user;
}

function adjustBalance(userId, delta) {
  getUser(userId); // ensure user exists
  db.prepare("UPDATE users SET balance = balance + ? WHERE user_id = ?").run(delta, userId);
  return db.prepare("SELECT balance FROM users WHERE user_id = ?").get(userId).balance;
}

function getAllUserIds() {
  return db.prepare("SELECT user_id FROM users").all().map((r) => r.user_id);
}

// -------------------- Markets --------------------
function marketFromRow(row) {
  if (!row) return null;
  return {
    marketId: row.market_id,
    type: row.type,
    title: row.title,
    line: row.line,
    status: row.status,
    oddsLocked: row.odds_locked === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    picks: {
      A: { label: row.pick_a_label, odds: row.pick_a_odds },
      B: { label: row.pick_b_label, odds: row.pick_b_odds },
    },
    prop: row.prop_player
      ? { player: row.prop_player, stat: row.prop_stat, kind: row.prop_kind }
      : null,
    teamtotal: row.teamtotal_team
      ? { team: row.teamtotal_team, stat: row.teamtotal_stat, kind: row.teamtotal_kind }
      : null,
  };
}

function getMarket(marketId) {
  return marketFromRow(
    db.prepare("SELECT * FROM markets WHERE market_id = ?").get(marketId)
  );
}

function getAllMarkets() {
  return db.prepare("SELECT * FROM markets").all().map(marketFromRow);
}

function createMarket({
  type, title, line, createdBy,
  pickALabel, pickAOdds, pickBLabel, pickBOdds,
  prop, teamtotal,
}) {
  const marketId = getNextId("nextMarketId");
  db.prepare(`
    INSERT INTO markets (
      market_id, type, title, line, status, odds_locked, created_by, created_at,
      pick_a_label, pick_a_odds, pick_b_label, pick_b_odds,
      prop_player, prop_stat, prop_kind,
      teamtotal_team, teamtotal_stat, teamtotal_kind
    ) VALUES (?, ?, ?, ?, 'OPEN', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    marketId, type, title, line ?? null, createdBy, Date.now(),
    pickALabel, pickAOdds, pickBLabel, pickBOdds,
    prop?.player ?? null, prop?.stat ?? null, prop?.kind ?? null,
    teamtotal?.team ?? null, teamtotal?.stat ?? null, teamtotal?.kind ?? null
  );
  return getMarket(marketId);
}

function updateMarketStatus(marketId, status) {
  db.prepare("UPDATE markets SET status = ? WHERE market_id = ?").run(status, marketId);
}

function updateMarketOddsLocked(marketId, locked) {
  db.prepare("UPDATE markets SET odds_locked = ? WHERE market_id = ?").run(locked ? 1 : 0, marketId);
}

function updateMarketOdds(marketId, pickAOdds, pickBOdds) {
  db.prepare("UPDATE markets SET pick_a_odds = ?, pick_b_odds = ? WHERE market_id = ?")
    .run(pickAOdds, pickBOdds, marketId);
}

// -------------------- Bets --------------------
function betFromRow(row) {
  if (!row) return null;
  return {
    betId: row.bet_id,
    marketId: row.market_id,
    userId: row.user_id,
    stake: row.stake,
    pick: row.pick,
    odds: row.odds,
    status: row.status,
    placedAt: row.placed_at,
  };
}

function createBet({ marketId, userId, stake, pick, odds }) {
  const betId = getNextId("nextBetId");
  db.prepare(`
    INSERT INTO bets (bet_id, market_id, user_id, stake, pick, odds, status, placed_at)
    VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?)
  `).run(betId, marketId, userId, stake, pick, odds, Date.now());
  return betId;
}

function updateBetStatus(betId, status) {
  db.prepare("UPDATE bets SET status = ? WHERE bet_id = ?").run(status, betId);
}

function getOpenBetsForUser(userId) {
  return db.prepare("SELECT * FROM bets WHERE user_id = ? AND status = 'OPEN'")
    .all(userId).map(betFromRow);
}

function getSettledBetsForUser(userId) {
  return db.prepare("SELECT * FROM bets WHERE user_id = ? AND status != 'OPEN'")
    .all(userId).map(betFromRow);
}

function getOpenBetsForMarket(marketId) {
  return db.prepare("SELECT * FROM bets WHERE market_id = ? AND status = 'OPEN'")
    .all(marketId).map(betFromRow);
}

function getAllBets() {
  return db.prepare("SELECT * FROM bets").all().map(betFromRow);
}

function getAllBetCounts() {
  return db.prepare(
    "SELECT market_id, pick, COUNT(*) as count FROM bets GROUP BY market_id, pick"
  ).all();
}

// -------------------- Parlays --------------------
function legsForParlay(parlayId) {
  return db.prepare("SELECT * FROM parlay_legs WHERE parlay_id = ? ORDER BY id ASC")
    .all(parlayId)
    .map((row) => ({
      id: row.id,
      parlayId: row.parlay_id,
      marketId: row.market_id,
      marketType: row.market_type,
      pick: row.pick,
      labelSnapshot: row.label_snapshot,
      oddsSnapshot: row.odds_snapshot,
      result: row.result,
    }));
}

function parlayFromRow(row) {
  if (!row) return null;
  return {
    parlayId: row.parlay_id,
    userId: row.user_id,
    status: row.status,
    stake: row.stake,
    createdAt: row.created_at,
    placedAt: row.placed_at,
    legs: legsForParlay(row.parlay_id),
  };
}

function getParlay(parlayId) {
  return parlayFromRow(
    db.prepare("SELECT * FROM parlays WHERE parlay_id = ?").get(parlayId)
  );
}

function getBuildingParlay(userId) {
  return parlayFromRow(
    db.prepare("SELECT * FROM parlays WHERE user_id = ? AND status = 'BUILDING'").get(userId)
  );
}

function getOpenParlaysForUser(userId) {
  return db.prepare("SELECT * FROM parlays WHERE user_id = ? AND status = 'OPEN'")
    .all(userId).map(parlayFromRow);
}

function getSettledParlaysForUser(userId) {
  return db.prepare("SELECT * FROM parlays WHERE user_id = ? AND status = 'SETTLED'")
    .all(userId).map(parlayFromRow);
}

function getOpenParlaysForMarket(marketId) {
  return db.prepare(`
    SELECT DISTINCT p.* FROM parlays p
    JOIN parlay_legs pl ON p.parlay_id = pl.parlay_id
    WHERE pl.market_id = ? AND p.status = 'OPEN'
  `).all(marketId).map(parlayFromRow);
}

function getAllParlays() {
  return db.prepare("SELECT * FROM parlays").all().map(parlayFromRow);
}

function getAllSettledParlays() {
  return db.prepare("SELECT * FROM parlays WHERE status = 'SETTLED'").all().map(parlayFromRow);
}

function createParlay(userId) {
  const parlayId = getNextId("nextParlayId");
  db.prepare(`
    INSERT INTO parlays (parlay_id, user_id, status, created_at)
    VALUES (?, ?, 'BUILDING', ?)
  `).run(parlayId, userId, Date.now());
  return parlayId;
}

function addParlayLeg({ parlayId, marketId, marketType, pick, labelSnapshot, oddsSnapshot }) {
  db.prepare(`
    INSERT INTO parlay_legs (parlay_id, market_id, market_type, pick, label_snapshot, odds_snapshot, result)
    VALUES (?, ?, ?, ?, ?, ?, 'PENDING')
  `).run(parlayId, marketId, marketType, pick, labelSnapshot, oddsSnapshot);
}

function removeParlayLeg(parlayId, legIndex) {
  const legs = db.prepare(
    "SELECT id FROM parlay_legs WHERE parlay_id = ? ORDER BY id ASC"
  ).all(parlayId);
  if (legIndex < 0 || legIndex >= legs.length) return false;
  db.prepare("DELETE FROM parlay_legs WHERE id = ?").run(legs[legIndex].id);
  return true;
}

function updateParlayPlaced(parlayId, stake, legsSnapshot) {
  db.prepare(
    "UPDATE parlays SET status = 'OPEN', stake = ?, placed_at = ? WHERE parlay_id = ?"
  ).run(stake, Date.now(), parlayId);
  // overwrite legs with confirmed snapshot
  db.prepare("DELETE FROM parlay_legs WHERE parlay_id = ?").run(parlayId);
  for (const leg of legsSnapshot) {
    db.prepare(`
      INSERT INTO parlay_legs (parlay_id, market_id, market_type, pick, label_snapshot, odds_snapshot, result)
      VALUES (?, ?, ?, ?, ?, ?, 'PENDING')
    `).run(parlayId, leg.marketId, leg.marketType, leg.pick, leg.labelSnapshot, leg.oddsSnapshot);
  }
}

function updateParlayStatus(parlayId, status) {
  db.prepare("UPDATE parlays SET status = ? WHERE parlay_id = ?").run(status, parlayId);
}

function updateParlayLegResult(parlayId, marketId, result) {
  db.prepare(
    "UPDATE parlay_legs SET result = ? WHERE parlay_id = ? AND market_id = ?"
  ).run(result, parlayId, marketId);
}

function deleteParlay(parlayId) {
  db.prepare("DELETE FROM parlay_legs WHERE parlay_id = ?").run(parlayId);
  db.prepare("DELETE FROM parlays WHERE parlay_id = ?").run(parlayId);
}

// -------------------- Pending Confirms --------------------
function getPendingConfirm(nonce) {
  const row = db.prepare("SELECT * FROM pending_confirms WHERE nonce = ?").get(nonce);
  if (!row) return null;
  return { ...row, userId: row.user_id, expiresAt: row.expires_at, payload: JSON.parse(row.payload) };
}

function setPendingConfirm({ nonce, userId, type, payload, expiresAt }) {
  db.prepare(`
    INSERT OR REPLACE INTO pending_confirms (nonce, user_id, type, payload, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(nonce, userId, type, JSON.stringify(payload), Date.now(), expiresAt);
}

function deletePendingConfirm(nonce) {
  db.prepare("DELETE FROM pending_confirms WHERE nonce = ?").run(nonce);
}

function cleanupExpiredConfirms() {
  db.prepare("DELETE FROM pending_confirms WHERE expires_at < ?").run(Date.now());
}

module.exports = {
  db,
  getUser, adjustBalance, getAllUserIds,
  getMarket, getAllMarkets, createMarket,
  updateMarketStatus, updateMarketOddsLocked, updateMarketOdds,
  createBet, updateBetStatus,
  getOpenBetsForUser, getSettledBetsForUser, getOpenBetsForMarket,
  getAllBets, getAllBetCounts,
  getParlay, getBuildingParlay, getOpenParlaysForUser, getSettledParlaysForUser,
  getOpenParlaysForMarket, getAllParlays, getAllSettledParlays,
  createParlay, addParlayLeg, removeParlayLeg,
  updateParlayPlaced, updateParlayStatus, updateParlayLegResult, deleteParlay,
  getPendingConfirm, setPendingConfirm, deletePendingConfirm, cleanupExpiredConfirms,
};
