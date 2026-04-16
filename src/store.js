const fs = require("fs");
const path = require("path");

const DATA_PATH = path.join(__dirname, "..", "data.json");

function makeDefault() {
  return {
    users: {},
    markets: {},
    bets: {},
    parlays: {},
    nextMarketId: 1,
    nextBetId: 1,
    nextParlayId: 1,
    pendingConfirms: {},
  };
}

function load() {
  let data;
  if (!fs.existsSync(DATA_PATH)) {
    data = makeDefault();
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), "utf8");
    return data;
  }

  data = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));

  // --- migration / defaults (in case data.json existed before parlays)
  if (!data.users) data.users = {};
  if (!data.markets) data.markets = {};
  if (!data.bets) data.bets = {};
  if (!data.parlays) data.parlays = {};
  if (typeof data.nextMarketId !== "number") data.nextMarketId = 1;
  if (typeof data.nextBetId !== "number") data.nextBetId = 1;
  if (typeof data.nextParlayId !== "number") data.nextParlayId = 1;

  return data;
}

function save(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), "utf8");
}

function getUser(data, userId) {
  if (!data.users[userId]) data.users[userId] = { balance: 0 };
  return data.users[userId];
}

module.exports = { load, save, getUser };