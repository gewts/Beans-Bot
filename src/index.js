// src/index.js
require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} = require("discord.js");
const { load, save, getUser } = require("./store");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token) throw new Error("Missing DISCORD_TOKEN in .env");
if (!clientId) throw new Error("Missing CLIENT_ID in .env");
if (!guildId) throw new Error("Missing GUILD_ID in .env");

const BOOK_ROLE_NAME = "Book";
const CURRENCY = "Beans";

// ---- Market movement settings (your choices) ----
const MOVE_EVERY_BET = true;        // immediate
const MIN_STAKE_TO_MOVE = 1;        // beans
const ODDS_STEP = 15;               // move by this each ticket
// loose caps just to avoid insane values / 0
const ODDS_MIN = -5000;
const ODDS_MAX = 5000;

const MAX_WAGER = 50; // max beans per straight bet or parlay

const CONFIRM_TIMEOUT_MS = 60_000; // 60 seconds

const HISTORY_PAGE_FIELD_LIMIT = 1000; // stay safely under Discord's 1024 field limit
const HISTORY_PAGE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ---------------- Helpers ----------------
function hasRole(interaction, roleName) {
  const roles = interaction.member?.roles?.cache;
  if (!roles) return false;
  return roles.some((r) => r.name === roleName);
}

function fmtOdds(odds) {
  return odds > 0 ? `+${odds}` : `${odds}`;
}

function defaultOdds(x) {
  return typeof x === "number" && x !== 0 ? x : -110;
}

function clampOdds(x) {
  let v = Math.max(ODDS_MIN, Math.min(ODDS_MAX, x));
  if (v === 0) v = 10;
  return v;
}

// moves odds only (line stays fixed)
function applyOddsStepToMarket(market, hitSide, steps = 1) {
  const A = market.picks?.A;
  const B = market.picks?.B;
  if (!A || !B) return;

  const delta = ODDS_STEP * steps;

  if (hitSide === "A") {
    A.odds = clampOdds(A.odds - delta);
    B.odds = clampOdds(B.odds + delta);
  } else {
    B.odds = clampOdds(B.odds - delta);
    A.odds = clampOdds(A.odds + delta);
  }

  // ✅ Normalize so we never show weird odds like -60
  A.odds = normalizeAmericanOdds(A.odds);
  B.odds = normalizeAmericanOdds(B.odds);
}

function normalizeAmericanOdds(odds) {
  // Sportsbooks don't show -99 .. -1 on spreads/totals/props (or your ML per your choice)
  if (odds < 0 && odds > -100) {
    // flip into plus-money
    return 200 - Math.abs(odds);
  }
  return odds;
}

// odds move only when market is OPEN and not oddsLocked
function canMarketMove(market) {
  if (!market) return false;
  if (market.status !== "OPEN") return false;
  if (market.oddsLocked === true) return false;
  return true;
}

function americanToDecimal(odds) {
  if (odds === 0) throw new Error("Invalid odds");
  if (odds > 0) return 1 + odds / 100;
  return 1 + 100 / Math.abs(odds);
}

function calcPayout(stake, odds) {
  const dec = americanToDecimal(odds);
  const payout = Math.floor(stake * dec);
  const profit = payout - stake;
  return { payout, profit };
}

function combinedDecimalFromAmericanOdds(oddsList) {
  return oddsList.reduce((acc, o) => acc * americanToDecimal(o), 1);
}

function decimalToAmerican(decimal) {
  if (decimal <= 1) return 0;
  const profitRatio = decimal - 1;
  if (profitRatio >= 1) return Math.round(profitRatio * 100);
  return -Math.round(100 / profitRatio);
}

function fmtAmericanFromDecimal(decimal) {
  const a = decimalToAmerican(decimal);
  if (a === 0) return "N/A";
  return a > 0 ? `+${a}` : `${a}`;
}

function calcParlayPayout(stake, legs) {
  const effectiveOdds = legs
    .filter((l) => l.result !== "PUSH")
    .map((l) => l.oddsSnapshot);

  if (effectiveOdds.length === 0) {
    return { payout: stake, profit: 0, combinedDecimal: 1.0 };
  }

  const combinedDecimal = combinedDecimalFromAmericanOdds(effectiveOdds);
  const payout = Math.floor(stake * combinedDecimal);
  const profit = payout - stake;
  return { payout, profit, combinedDecimal };
}

function fmtLegResult(r) {
  if (r === "WON") return "✅ WON";
  if (r === "LOST") return "❌ LOST";
  if (r === "PUSH") return "↔️ PUSH";
  return "⏳ PENDING";
}

function findBuildingParlay(data, userId) {
  return Object.values(data.parlays || {}).find(
    (p) => p.userId === userId && p.status === "BUILDING"
  );
}

function normalizeKey(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ");
}

function buildParlayPreviewEmbed(p) {
  if (!p) {
    return new EmbedBuilder().setTitle("🧱 Parlay Builder").setDescription("No parlay builder found.");
  }

  if (!p.legs || p.legs.length === 0) {
    return new EmbedBuilder()
      .setTitle("🧱 Parlay Builder")
      .setDescription("No legs yet.\nUse `/parlay addline` or `/parlay addprop`.");
  }

  const oddsList = p.legs.map((l) => l.oddsSnapshot);
  const combinedDec = combinedDecimalFromAmericanOdds(oddsList);
  const combinedAmerican = fmtAmericanFromDecimal(combinedDec);

  const lines = p.legs.map(
    (l, i) => `**${i + 1})** [${l.marketType}] ${l.labelSnapshot} (**${fmtOdds(l.oddsSnapshot)}**)`
  );

  return new EmbedBuilder()
    .setTitle(`🧱 Parlay Builder (Legs: ${p.legs.length})`)
    .setDescription(lines.join("\n"))
    .addFields({ name: "Combined Odds", value: `**${combinedAmerican}**`, inline: true })
    .setFooter({ text: "Use /parlay place stake:<amount> to place it" });
}

function formatSigned(n) {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n}`;
}

function makeNonce() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildConfirmRow(nonce) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm:${nonce}`)
      .setLabel("Confirm")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`cancel:${nonce}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger)
  );
}

function ensurePendingStore(data) {
  if (!data.pendingConfirms) data.pendingConfirms = {};
}

function cleanupExpiredConfirms(data) {
  ensurePendingStore(data);
  const now = Date.now();
  for (const [k, v] of Object.entries(data.pendingConfirms)) {
    if (!v || now > v.expiresAt) delete data.pendingConfirms[k];
  }
}
function ensureHistoryPageStore(data) {
  if (!data.historyPages) data.historyPages = {};
}

function cleanupExpiredHistoryPages(data) {
  ensureHistoryPageStore(data);
  const now = Date.now();
  for (const [k, v] of Object.entries(data.historyPages)) {
    if (!v || now > v.expiresAt) delete data.historyPages[k];
  }
}

function buildHistoryButtonRow(nonce, pageIndex, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`history_prev:${nonce}`)
      .setLabel("⬅ Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(pageIndex <= 0),

    new ButtonBuilder()
      .setCustomId(`history_next:${nonce}`)
      .setLabel("➡ Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(pageIndex >= totalPages - 1),

    new ButtonBuilder()
      .setCustomId(`history_close:${nonce}`)
      .setLabel("Close")
      .setStyle(ButtonStyle.Danger)
  );
}

function chunkHistoryLines(lines, limit = HISTORY_PAGE_FIELD_LIMIT) {
  const pages = [];
  let current = "";

  for (const line of lines) {
    // add separator between tickets
    const candidate = current.length === 0 ? line : `${current}\n\n${line}`;

    if (candidate.length <= limit) {
      current = candidate;
    } else {
      if (current.length > 0) {
        pages.push(current);
      }

      // if a single ticket is somehow too large, hard-truncate it safely
      if (line.length > limit) {
        pages.push(line.slice(0, limit - 4) + " ...");
        current = "";
      } else {
        current = line;
      }
    }
  }

  if (current.length > 0) {
    pages.push(current);
  }

  return pages.length > 0 ? pages : ["—"];
}
function computeMarketBetPercents(data) {
  const counts = {}; // marketId -> { A: n, B: n, total: n }

  function bump(marketId, side) {
    if (!counts[marketId]) counts[marketId] = { A: 0, B: 0, total: 0 };
    if (side !== "A" && side !== "B") return;
    counts[marketId][side] += 1;
    counts[marketId].total += 1;
  }

  // singles: count all placed tickets (OPEN + settled)
  for (const b of Object.values(data.bets || {})) {
    if (!b || typeof b.marketId !== "number") continue;
    bump(b.marketId, b.pick);
  }

  // parlays: count each leg as 1 ticket (only if parlay was actually placed or settled)
  for (const p of Object.values(data.parlays || {})) {
    if (!p || (p.status !== "OPEN" && p.status !== "SETTLED")) continue;
    for (const leg of (p.legs || [])) {
      if (!leg || typeof leg.marketId !== "number") continue;
      bump(leg.marketId, leg.pick);
    }
  }

  return counts;
}
async function getDisplayNameFromGuild(interaction, userId) {
  try {
    const member =
      interaction.guild?.members?.cache?.get(userId) ||
      (await interaction.guild?.members?.fetch(userId));

    return member?.displayName || member?.user?.username || `User ${userId}`;
  } catch {
    try {
      const user = await interaction.client.users.fetch(userId);
      return user?.username || `User ${userId}`;
    } catch {
      return `User ${userId}`;
    }
  }
}

function computeUserLeaderboardStats(data, userId) {
  const singles = Object.values(data.bets || {}).filter(
    (b) => b.userId === userId && b.status && b.status !== "OPEN"
  );

  const parlays = Object.values(data.parlays || {}).filter(
    (p) => p.userId === userId && p.status === "SETTLED" && typeof p.stake === "number"
  );

  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let net = 0;

  for (const b of singles) {
    if (b.status === "PUSH") {
      pushes++;
      continue;
    }
    if (b.status === "LOST") {
      losses++;
      net -= b.stake;
      continue;
    }
    if (b.status === "WON") {
      wins++;
      const { payout } = calcPayout(b.stake, b.odds);
      net += payout - b.stake;
    }
  }

  for (const p of parlays) {
    const legs = p.legs || [];
    const anyLost = legs.some((l) => l.result === "LOST");
    const allPush = legs.length > 0 && legs.every((l) => l.result === "PUSH");

    if (allPush) {
      pushes++;
      continue;
    }

    if (anyLost) {
      losses++;
      net -= p.stake;
      continue;
    }

    wins++;
    const { payout } = calcParlayPayout(p.stake, p.legs || []);
    net += payout - p.stake;
  }

  return {
    wins,
    losses,
    pushes,
    net,
    settledCount: singles.length + parlays.length,
  };
}
function pctTag(sideCount, total) {
  if (!total || total <= 0) return "";
  const pct = Math.round((sideCount / total) * 100);
  return ` [${pct}% bets placed]`;
}
function marketContextLine(m) {
  if (!m) return "Unknown Market";

  // TEAMTOTAL formatting (robust to different property names)
  if (m.type === "TEAMTOTAL") {
    const team =
      m.teamTotal?.team ??
      m.teamtotal?.team ??
      m.team ??
      m.title ??
      "Team";

    const stat =
      m.teamTotal?.stat ??
      m.teamtotal?.stat ??
      m.stat ??
      "TOTAL";

    const line = typeof m.line === "number" ? m.line : null;

    return line !== null
      ? `**${team}** — **${stat}** | Line: **${line}**`
      : `**${team}** — **${stat}**`;
  }

  // TOTAL formatting
  if (m.type === "TOTAL") {
    const line = typeof m.line === "number" ? m.line : null;
    return line !== null ? `**${m.title}** | Line: **${line}**` : `**${m.title}**`;
  }

  // PROP formatting
  if (m.type === "PROP" && m.prop) {
    const player = m.prop.player ?? "Player";
    const stat = m.prop.stat ?? "STAT";
    const line = typeof m.line === "number" ? m.line : null;
    return line !== null
      ? `**${player}** — **${stat}** | Line: **${line}**`
      : `**${player}** — **${stat}**`;
  }

  // ML / SPREAD (and anything else)
  if (typeof m.line === "number" && m.type === "SPREAD") {
    return `**${m.title}** | Line: **${m.line}**`;
  }

  return `**${m.title}**`;
}

// ---------------- Discord client ----------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);

  client.user.setPresence({
    activities: [
      {
        name: "Watching hudl film",
        type: 3, // WATCHING
      },
    ],
    status: "online",
  });
});

client.on(Events.InteractionCreate, async (interaction) => {
  // ---- Button interactions (Confirm / Cancel) ----
if (interaction.isButton()) {
  const data = load();
  cleanupExpiredConfirms(data);
    cleanupExpiredHistoryPages(data);
  ensureHistoryPageStore(data);

  // ---- History pagination buttons ----
  if (
    interaction.customId.startsWith("history_prev:") ||
    interaction.customId.startsWith("history_next:") ||
    interaction.customId.startsWith("history_close:")
  ) {
    const [action, nonce] = interaction.customId.split(":");
    const session = data.historyPages[nonce];

    if (!session) {
      await interaction.reply({
        content: "⏰ This history view expired.",
        ephemeral: true,
      });
      return;
    }

    if (session.userId !== interaction.user.id) {
      await interaction.reply({
        content: "❌ Only the user who opened this history view can use these buttons.",
        ephemeral: true,
      });
      return;
    }

    if (action === "history_close") {
      delete data.historyPages[nonce];
      save(data);

      await interaction.update({
        content: "📜 History closed.",
        embeds: [],
        components: [],
      });
      return;
    }

    if (action === "history_prev") {
      session.pageIndex = Math.max(0, session.pageIndex - 1);
    }

    if (action === "history_next") {
      session.pageIndex = Math.min(session.pages.length - 1, session.pageIndex + 1);
    }

    const pageText = session.pages[session.pageIndex] || "—";

    const embed = new EmbedBuilder()
      .setTitle(session.title)
      .setDescription(session.description)
      .addFields(
        {
          name: "Totals",
          value: session.totalsField,
          inline: true,
        },
        {
          name: "Streak / Big Swings",
          value: session.streakField,
          inline: false,
        },
        {
          name: "Settled Tickets",
          value: pageText,
          inline: false,
        }
      )
      .setFooter({
        text: `Page ${session.pageIndex + 1} of ${session.pages.length} • Settled tickets for ${session.whoName}`,
      });

    save(data);

    await interaction.update({
      embeds: [embed],
      components: [buildHistoryButtonRow(nonce, session.pageIndex, session.pages.length)],
    });
    return;
  }

  const [kind, nonce] = interaction.customId.split(":");
  ensurePendingStore(data);

  const pending = data.pendingConfirms[nonce];
  if (!pending) {
    await interaction.reply({ content: "⏰ This confirmation expired.", ephemeral: true });
    return;
  }

  if (pending.userId !== interaction.user.id) {
    await interaction.reply({ content: "❌ This confirmation isn’t for you.", ephemeral: true });
    return;
  }

  // Cancel
  if (kind === "cancel") {
    delete data.pendingConfirms[nonce];
    save(data);

    await interaction.update({
      content: "❎ Cancelled.",
      embeds: [],
      components: [],
    });
    return;
  }

  // Confirm
  if (kind === "confirm") {
    // Remove pending immediately to prevent double-click duplication
    delete data.pendingConfirms[nonce];

    try {
      // Execute based on pending type
      if (pending.type === "bet") {
        // Place straight bet using stored snapshot
        const { marketId, pickKey, stake, oddsSnapshot } = pending.payload;

        const market = data.markets?.[marketId];
        if (!market || market.status !== "OPEN") {
          save(data);
          await interaction.update({ content: "❌ Market is no longer OPEN.", embeds: [], components: [] });
          return;
        }

        const pick = market.picks?.[pickKey];
        if (!pick) {
          save(data);
          await interaction.update({ content: "❌ Pick no longer exists.", embeds: [], components: [] });
          return;
        }

        const u = getUser(data, interaction.user.id);

        // enforce current rules (max wager, balance)
        if (stake > MAX_WAGER) {
          save(data);
          await interaction.update({ content: `❌ Max wager is ${MAX_WAGER} ${CURRENCY}.`, embeds: [], components: [] });
          return;
        }
        if (u.balance < stake) {
          save(data);
          await interaction.update({ content: `❌ Insufficient funds. Balance: ${u.balance} ${CURRENCY}`, embeds: [], components: [] });
          return;
        }

        u.balance -= stake;

        const betId = data.nextBetId++;
        data.bets[betId] = {
          betId,
          marketId: market.marketId,
          userId: interaction.user.id,
          stake,
          pick: pickKey,
          odds: oddsSnapshot,   // locked to preview snapshot
          status: "OPEN",
          placedAt: Date.now(),
        };

        // move odds immediately if allowed (based on stake >= MIN_STAKE_TO_MOVE)
        if (MOVE_EVERY_BET && stake >= MIN_STAKE_TO_MOVE && canMarketMove(market)) {
          applyOddsStepToMarket(market, pickKey, 1);
        }

        const { payout, profit } = calcPayout(stake, oddsSnapshot);
        save(data);

        let extraLine = market.line !== null ? `\nLine: **${market.line}**` : "";

if (market.type === "TEAMTOTAL" && market.teamtotal) {
  extraLine =
    `\nTeam: **${market.teamtotal.team}**` +
    `\nStat: **${market.teamtotal.stat}**` +
    (market.line !== null ? `\nLine: **${market.line}**` : "");
}

if (market.type === "PROP" && market.prop) {
  extraLine =
    `\nPlayer: **${market.prop.player}**` +
    `\nStat: **${market.prop.stat}**` +
    (market.line !== null ? `\nLine: **${market.line}**` : "");
}

const slip = new EmbedBuilder()
  .setTitle(`🎟️ BET SLIP #${betId}`)
  .setDescription(
    `**${market.title}**${extraLine}\n` +
    `**Type:** ${market.type}\n` +
    `**Pick:** ${pick.label}`
  )
          .addFields(
            { name: "Odds", value: fmtOdds(oddsSnapshot), inline: true },
            { name: "Stake", value: `${stake} ${CURRENCY}`, inline: true },
            { name: "To Win", value: `${profit} ${CURRENCY}`, inline: true },
            { name: "Potential Payout", value: `${payout} ${CURRENCY}`, inline: false },
            { name: "New Balance", value: `${u.balance} ${CURRENCY}`, inline: true }
          );

        // post publicly
await interaction.channel.send({
  content: `🎟️ <@${interaction.user.id}> placed a bet`,
  embeds: [slip],
});

// keep the confirmation UI private/clean
await interaction.update({
  content: "✅ Placed! (Posted to the channel)",
  embeds: [],
  components: [],
});
return;

      }

      if (pending.type === "parlay") {
        const { parlayId, stake, legsSnapshot } = pending.payload;

        const p = data.parlays?.[parlayId];
        if (!p || p.status !== "BUILDING") {
          save(data);
          await interaction.update({ content: "❌ Parlay builder no longer exists.", embeds: [], components: [] });
          return;
        }

        if (stake > MAX_WAGER) {
          save(data);
          await interaction.update({ content: `❌ Max wager is ${MAX_WAGER} ${CURRENCY}.`, embeds: [], components: [] });
          return;
        }

        const u = getUser(data, interaction.user.id);
        if (u.balance < stake) {
          save(data);
          await interaction.update({ content: `❌ Insufficient funds. Balance: ${u.balance} ${CURRENCY}`, embeds: [], components: [] });
          return;
        }

        // Ensure all markets still OPEN
        for (const leg of legsSnapshot) {
          const m = data.markets?.[leg.marketId];
          if (!m || m.status !== "OPEN") {
            save(data);
            await interaction.update({ content: "❌ One or more legs are on a locked/unavailable market.", embeds: [], components: [] });
            return;
          }
        }

        // Deduct + place
        u.balance -= stake;

        p.stake = stake;
        p.status = "OPEN";
        p.placedAt = Date.now();

        // overwrite legs with snapshot locked at preview time
        p.legs = legsSnapshot.map((l) => ({ ...l, result: "PENDING" }));

        // Move odds for each leg if allowed (stake>=min)
        if (MOVE_EVERY_BET && stake >= MIN_STAKE_TO_MOVE) {
          for (const leg of p.legs) {
            const m = data.markets[leg.marketId];
            if (canMarketMove(m)) {
              applyOddsStepToMarket(m, leg.pick, 1);
            }
          }
        }

        const preview = calcParlayPayout(stake, p.legs);
        save(data);

        const lines = p.legs.map(
          (l, i) => `**${i + 1})** [${l.marketType}] ${l.labelSnapshot} (${fmtOdds(l.oddsSnapshot)})`
        );

        const embed = new EmbedBuilder()
          .setTitle(`🧾 PARLAY SLIP #${p.parlayId}`)
          .setDescription(lines.join("\n"))
          .addFields(
            { name: "Stake", value: `${stake} ${CURRENCY}`, inline: true },
            { name: "Potential Payout", value: `${preview.payout} ${CURRENCY}`, inline: true },
            { name: "New Balance", value: `${u.balance} ${CURRENCY}`, inline: true }
          )
          .setFooter({ text: "Parlay is OPEN — settles as markets are settled" });

        // post publicly
await interaction.channel.send({
  content: `🧾 <@${interaction.user.id}> placed a parlay`,
  embeds: [embed],
});

// keep the confirmation UI private/clean
await interaction.update({
  content: "✅ Placed! (Posted to the channel)",
  embeds: [],
  components: [],
});
return;


      }

      save(data);
      await interaction.update({ content: "❌ Unknown confirmation type.", embeds: [], components: [] });
      return;
    } catch (e) {
      console.error(e);
      save(data);
      await interaction.update({ content: "❌ Error placing ticket.", embeds: [], components: [] });
      return;
    }
  }
}

  if (!interaction.isChatInputCommand()) return;

  const data = load();

  try {
    // ---------------- /ping ----------------
    if (interaction.commandName === "ping") {
      await interaction.reply("pong");
      return;
    }

    // ---------------- /help ----------------
    if (interaction.commandName === "help") {
      const msg = `🫘 BEANS BOT — HOW TO USE ℹ️

💰 Account & Lines
/bank balance — check your bean balance
/market list — view current game lines and player props

*(To deposit/withdraw beans DM @gewt.)*

🎟️ Straight Bets
/bet place — place a single bet on ML, spread, totals (No props)

🧱 Parlays
/parlay start — start building a parlay
/parlay addline — add ML / spread / total leg
/parlay addprop — add GOALS / PENALTIES prop leg (Over only)
/parlay remove — remove a leg by number
/parlay cancel — cancel unplaced parlay
/parlay place — place parlay and deduct balance

📊 Slips & History
/open — view open bets and parlays
/history view — view settled bet history and account stats
/leaderboard — show top 5 all time bean bettors

ℹ️ Help
/help — show this message
/ping — Test the bots status`;
      await interaction.reply(msg);
      return;
    }


// ---------------- /leaderboard ----------------
if (interaction.commandName === "leaderboard") {
  const userIds = new Set();

  for (const b of Object.values(data.bets || {})) {
    if (b.userId) userIds.add(b.userId);
  }
  for (const p of Object.values(data.parlays || {})) {
    if (p.userId) userIds.add(p.userId);
  }

  const rows = [];
  for (const userId of userIds) {
  const stats = computeUserLeaderboardStats(data, userId);
  if (stats.settledCount <= 0) continue; // exclude users with no settled bets

  const name = await getDisplayNameFromGuild(interaction, userId);

  rows.push({
    userId,
    name,
    ...stats,
  });
}

  if (rows.length === 0) {
    await interaction.reply("No settled bets yet, so the leaderboard is empty.");
    return;
  }

  rows.sort((a, b) => {
    if (b.net !== a.net) return b.net - a.net;      // primary sort: net beans
    if (b.wins !== a.wins) return b.wins - a.wins;  // tie-breaker: more wins
    return a.name.localeCompare(b.name);            // final tie-breaker: name
  });

  const top5 = rows.slice(0, 5);

  const lines = top5.map((r, idx) => {
    let prefix = `${idx + 1}.`;
    if (idx === 0) prefix = "👑";
    if (idx === 1) prefix = "🥈";
    if (idx === 2) prefix = "🥉";

    return `${prefix} **${r.name}** : ${formatSigned(r.net)} ${CURRENCY} — ${r.wins}-${r.losses}-${r.pushes}`;
  });

  const viewerRankIndex = rows.findIndex((r) => r.userId === interaction.user.id);
  const viewerRankText = viewerRankIndex >= 0 ? `#${viewerRankIndex + 1}` : "Unranked";

  const embed = new EmbedBuilder()
    .setTitle("🏆 Bean Board")
    .setDescription(lines.join("\n"))
    .setFooter({
      text: `Your rank: ${viewerRankText} • Ranked by net ${CURRENCY} • Settled tickets only`,
    });

  await interaction.reply({ embeds: [embed] });
  return;
}
    // ---------------- /bank ----------------
if (interaction.commandName === "bank") {
  const sub = interaction.options.getSubcommand();

  if (sub === "balance") {
    const targetUser = interaction.options.getUser("user");

    // If they try to check someone else, require Admin OR Book role
    if (targetUser && !(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) || hasRole(interaction, BOOK_ROLE_NAME))) {
      await interaction.reply({ content: "❌ Only admins/book can check other users' balances.", ephemeral: true });
      return;
    }

    const userToCheck = targetUser ?? interaction.user;
    const u = getUser(data, userToCheck.id);

    await interaction.reply(`💰 **${userToCheck.username}'s Balance:** ${u.balance} ${CURRENCY}`);
    save(data);
    return;
  }
}

    // ---------------- /book stats ----------------
    if (interaction.commandName === "book") {
      const sub = interaction.options.getSubcommand();

      if (sub === "stats") {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
          await interaction.reply({ content: "❌ Admins only.", ephemeral: true });
          return;
        }

        const allBets = Object.values(data.bets || {});
        const settledSingles = allBets.filter((b) => b.status && b.status !== "OPEN");

        let singlesHouseNet = 0;
        let singlesWon = 0;
        let singlesLost = 0;
        let singlesPushed = 0;

        for (const b of settledSingles) {
          if (b.status === "LOST") {
            singlesHouseNet += b.stake;
            singlesLost++;
          } else if (b.status === "WON") {
            const { profit } = calcPayout(b.stake, b.odds);
            singlesHouseNet -= profit;
            singlesWon++;
          } else if (b.status === "PUSH") {
            singlesPushed++;
          }
        }

        const allParlays = Object.values(data.parlays || {});
        const settledParlays = allParlays.filter((p) => p.status === "SETTLED" && typeof p.stake === "number");

        let parlaysHouseNet = 0;
        let parlaysWon = 0;
        let parlaysLost = 0;
        let parlaysPushed = 0;

        for (const p of settledParlays) {
          const legs = p.legs || [];
          const anyLost = legs.some((l) => l.result === "LOST");
          const allPush = legs.length > 0 && legs.every((l) => l.result === "PUSH");

          if (anyLost) {
            parlaysHouseNet += p.stake;
            parlaysLost++;
          } else if (allPush) {
            parlaysPushed++;
          } else {
            const { profit } = calcParlayPayout(p.stake, p.legs);
            parlaysHouseNet -= profit;
            parlaysWon++;
          }
        }

        const totalHouseNet = singlesHouseNet + parlaysHouseNet;

        const embed = new EmbedBuilder()
          .setTitle("📊 Book Operator Stats")
          .setDescription(`**House Net:** **${formatSigned(totalHouseNet)} ${CURRENCY}**`)
          .addFields(
            {
              name: "Singles (settled)",
              value:
                `Count: **${settledSingles.length}**\n` +
                `User W/L/P: **${singlesWon} / ${singlesLost} / ${singlesPushed}**\n` +
                `House Net: **${formatSigned(singlesHouseNet)} ${CURRENCY}**`,
              inline: true,
            },
            {
              name: "Parlays (settled)",
              value:
                `Count: **${settledParlays.length}**\n` +
                `User W/L/P: **${parlaysWon} / ${parlaysLost} / ${parlaysPushed}**\n` +
                `House Net: **${formatSigned(parlaysHouseNet)} ${CURRENCY}**`,
              inline: true,
            }
          )
          .setFooter({ text: "Net is based on settled tickets only (OPEN excluded)" });

        await interaction.reply({ embeds: [embed] });
        return;
      }
    }

// ---------------- /history ----------------
if (interaction.commandName === "history") {
  const sub = interaction.options.getSubcommand();

if (sub === "view") {
  // Admin/Book can optionally view another user's history
  const targetUser = interaction.options.getUser("user");
  if (
    targetUser &&
    !(
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
      hasRole(interaction, BOOK_ROLE_NAME)
    )
  ) {
    await interaction.reply({
      content: "❌ Only admins/book can view another user's history.",
      ephemeral: true,
    });
    return;
  }

  const userObj = targetUser ?? interaction.user;
  const userId = userObj.id;
  const whoName = userObj.username;

  const settledSingles = Object.values(data.bets || {}).filter(
    (b) => b.userId === userId && b.status && b.status !== "OPEN"
  );

  const settledParlays = Object.values(data.parlays || {}).filter(
    (p) => p.userId === userId && p.status === "SETTLED" && typeof p.stake === "number"
  );

  if (settledSingles.length === 0 && settledParlays.length === 0) {
    await interaction.reply(`${whoName} doesn’t have any settled tickets yet.`);
    return;
  }

  function singleTicketMoney(b) {
    if (b.status === "PUSH") {
      return { stake: b.stake, payout: b.stake, net: 0, w: 0, l: 0, p: 1 };
    }
    if (b.status === "LOST") {
      return { stake: b.stake, payout: 0, net: -b.stake, w: 0, l: 1, p: 0 };
    }
    const { payout } = calcPayout(b.stake, b.odds);
    return { stake: b.stake, payout, net: payout - b.stake, w: 1, l: 0, p: 0 };
  }

  function parlayOutcome(p) {
    const legs = p.legs || [];
    const anyLost = legs.some((l) => l.result === "LOST");
    const allPush = legs.length > 0 && legs.every((l) => l.result === "PUSH");
    if (anyLost) return "LOST";
    if (allPush) return "PUSH";
    return "WON";
  }

  function parlayTicketMoney(p) {
    const stake = p.stake;
    const outcome = parlayOutcome(p);
    if (outcome === "PUSH") {
      return { stake, payout: stake, net: 0, w: 0, l: 0, p: 1 };
    }
    if (outcome === "LOST") {
      return { stake, payout: 0, net: -stake, w: 0, l: 1, p: 0 };
    }
    const { payout } = calcParlayPayout(stake, p.legs || []);
    return { stake, payout, net: payout - stake, w: 1, l: 0, p: 0 };
  }

  function safeROI(net, stake) {
    if (!stake || stake <= 0) return 0;
    return Math.round((net / stake) * 100);
  }

  // totals
  let tW = 0,
    tL = 0,
    tP = 0;
  let tStake = 0,
    tPayout = 0,
    tNet = 0;

  // build full ticket list (newest first later)
  const recent = [];

  for (const b of settledSingles) {
    const mkt = data.markets?.[b.marketId];
    const pick = mkt?.picks?.[b.pick];
    const money = singleTicketMoney(b);

    tW += money.w;
    tL += money.l;
    tP += money.p;
    tStake += money.stake;
    tPayout += money.payout;
    tNet += money.net;

    const emoji = b.status === "WON" ? "✅" : b.status === "LOST" ? "❌" : "↔️";
    recent.push({
      ts: b.placedAt || 0,
      outcome: b.status,
      net: money.net,
      line:
        `${emoji} **S#${b.betId}** [${mkt?.type ?? "?"}] ` +
        `${marketContextLine(mkt)} — ${pick?.label ?? "?"} (${fmtOdds(b.odds)}) | ` +
        `${b.stake} → ${money.payout} (${formatSigned(money.net)})`,
    });
  }

  for (const p of settledParlays) {
    const outcome = parlayOutcome(p);
    const money = parlayTicketMoney(p);

    tW += money.w;
    tL += money.l;
    tP += money.p;
    tStake += money.stake;
    tPayout += money.payout;
    tNet += money.net;

    const emoji = outcome === "WON" ? "✅" : outcome === "LOST" ? "❌" : "↔️";

    const legsLines = (p.legs || [])
      .map((l, i) => {
        const resEmoji =
          l.result === "WON"
            ? "✅"
            : l.result === "LOST"
            ? "❌"
            : l.result === "PUSH"
            ? "↔️"
            : "⏳";
        return `${i + 1}) ${l.labelSnapshot} (${fmtOdds(l.oddsSnapshot)}) ${resEmoji}`;
      })
      .join("\n");

    recent.push({
      ts: p.placedAt || 0,
      outcome,
      net: money.net,
      line:
        `${emoji} **P#${p.parlayId}** Parlay | Stake ${p.stake} → ${money.payout} (${formatSigned(money.net)})\n` +
        `${legsLines}`,
    });
  }

  recent.sort((a, b) => b.ts - a.ts);

  // streak ignoring PUSH
  let streakType = null;
  let streakCount = 0;
  for (const r of recent) {
    if (r.outcome === "PUSH") continue;
    const t = r.outcome === "WON" ? "W" : "L";
    if (!streakType) {
      streakType = t;
      streakCount = 1;
    } else if (t === streakType) {
      streakCount++;
    } else {
      break;
    }
  }
  const streakStr = streakType ? `${streakType}${streakCount}` : "—";

  // biggest win/loss
  let biggestWinNet = null;
  let biggestLossNet = null;
  for (const r of recent) {
    if (typeof r.net !== "number") continue;
    if (r.net > 0 && (biggestWinNet === null || r.net > biggestWinNet)) {
      biggestWinNet = r.net;
    }
    if (r.net < 0 && (biggestLossNet === null || r.net < biggestLossNet)) {
      biggestLossNet = r.net;
    }
  }

  const tROI = safeROI(tNet, tStake);

  // ✅ full history pages
  const allTicketLines = recent.map((r) => r.line);
  const pages = chunkHistoryLines(allTicketLines);

  cleanupExpiredHistoryPages(data);
  ensureHistoryPageStore(data);

  const nonce = makeNonce();
  data.historyPages[nonce] = {
    userId: interaction.user.id, // only command runner can flip pages
    whoName,
    title: `📜 History — ${whoName}`,
    description: `**Record:** **${tW}-${tL}-${tP}**  |  **Net:** **${formatSigned(tNet)} ${CURRENCY}**  |  **ROI:** **${tROI}%**`,
    totalsField:
      `Stake: **${tStake}**\n` +
      `Payout: **${tPayout}**\n` +
      `Net: **${formatSigned(tNet)} ${CURRENCY}**\n` +
      `ROI: **${tROI}%**`,
    streakField:
      `Streak: **${streakStr}**\n` +
      `Biggest Win: **${biggestWinNet === null ? "—" : `${formatSigned(biggestWinNet)} ${CURRENCY}`}**\n` +
      `Biggest Loss: **${biggestLossNet === null ? "—" : `${formatSigned(biggestLossNet)} ${CURRENCY}`}**`,
    pages,
    pageIndex: 0,
    expiresAt: Date.now() + HISTORY_PAGE_TTL_MS,
  };

  save(data);

  const embed = new EmbedBuilder()
    .setTitle(data.historyPages[nonce].title)
    .setDescription(data.historyPages[nonce].description)
    .addFields(
      {
        name: "Totals",
        value: data.historyPages[nonce].totalsField,
        inline: true,
      },
      {
        name: "Streak / Big Swings",
        value: data.historyPages[nonce].streakField,
        inline: false,
      },
      {
        name: "Settled Tickets",
        value: pages[0] || "—",
        inline: false,
      }
    )
    .setFooter({
      text: `Page 1 of ${pages.length} • Settled tickets for ${whoName}`,
    });

  await interaction.reply({
    embeds: [embed],
    components: [buildHistoryButtonRow(nonce, 0, pages.length)],
  });
  return;
}
}
// ---------------- /adminbank ----------------
if (interaction.commandName === "adminbank") {
  const sub = interaction.options.getSubcommand();

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "❌ Admins only.", ephemeral: true });
    return;
  }

  if (sub === "give") {
    const user = interaction.options.getUser("user", true);
    const amount = interaction.options.getInteger("amount", true);

    const u = getUser(data, user.id);
    u.balance += amount;

    save(data);
    await interaction.reply(`✅ Gave **${amount} ${CURRENCY}** to <@${user.id}>. New balance: **${u.balance}**`);
    return;
  }

  if (sub === "take") {
    const user = interaction.options.getUser("user", true);
    const amount = interaction.options.getInteger("amount", true);

    const u = getUser(data, user.id);
    const deducted = Math.min(amount, u.balance);
    u.balance -= deducted;

    save(data);
    await interaction.reply(`➖ Deducted **${deducted} ${CURRENCY}** from <@${user.id}>. New balance: **${u.balance}**`);
    return;
  }
}
// ---------------- /adminhistory ----------------
if (interaction.commandName === "adminhistory") {
  const sub = interaction.options.getSubcommand();

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "❌ Admins only.", ephemeral: true });
    return;
  }

  if (sub === "clear") {
    const user = interaction.options.getUser("user", true);
    const userId = user.id;

    let removedBets = 0;
    let removedParlays = 0;

    for (const id of Object.keys(data.bets || {})) {
      const b = data.bets[id];
      if (b.userId === userId && b.status && b.status !== "OPEN") {
        delete data.bets[id];
        removedBets++;
      }
    }

    for (const id of Object.keys(data.parlays || {})) {
      const p = data.parlays[id];
      if (p.userId === userId && p.status === "SETTLED") {
        delete data.parlays[id];
        removedParlays++;
      }
    }

    save(data);

    await interaction.reply(
      `🧹 Cleared history for <@${userId}>.\nRemoved **${removedBets}** singles and **${removedParlays}** parlays.`
    );
    return;
  }
}


    // ---------------- /open ----------------
if (interaction.commandName === "open") {
  // Admin can optionally view another user's open slips
  const targetUser = interaction.options.getUser("user");

  if (targetUser && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "❌ Only admins can view another user's open tickets.", ephemeral: true });
    return;
  }

  const userObj = targetUser ?? interaction.user;
  const userId = userObj.id;
  const whoName = userObj.username;

  const openBets = Object.values(data.bets || {}).filter((b) => b.userId === userId && b.status === "OPEN");
  const openParlays = Object.values(data.parlays || {}).filter((p) => p.userId === userId && p.status === "OPEN");

  if (openBets.length === 0 && openParlays.length === 0) {
    await interaction.reply(`${whoName} has no open slips or open parlays.`);
    return;
  }

  const embed = new EmbedBuilder().setTitle(`🎟️ Open Tickets — ${whoName}`);

  if (openBets.length > 0) {
    const lines = [];
    for (const b of openBets) {
      const m = data.markets[b.marketId];
      if (!m) continue;
      const pick = m.picks?.[b.pick];
      if (!pick) continue;

      const { payout, profit } = calcPayout(b.stake, b.odds);

      lines.push(
  `**Slip #${b.betId} — ${m.type}**\n` +
    `${marketContextLine(m)}\n` +
    `Pick: ${pick.label}\n` +
    `Odds: ${fmtOdds(b.odds)} | Stake: ${b.stake} ${CURRENCY}\n` +
    `To Win: ${profit} ${CURRENCY} | Payout: **${payout} ${CURRENCY}**`
);
    }

    embed.addFields({ name: `Singles (${openBets.length})`, value: lines.join("\n\n") || "—" });
  } else {
    embed.addFields({ name: "Singles (0)", value: "—" });
  }

  if (openParlays.length > 0) {
    const lines = [];
    for (const p of openParlays) {
      const effectiveOdds = (p.legs || []).filter((l) => l.result !== "PUSH").map((l) => l.oddsSnapshot);

      let combinedAmerican = "N/A";
      let payout = p.stake;
      let profit = 0;

      if (effectiveOdds.length > 0) {
        const combinedDec = combinedDecimalFromAmericanOdds(effectiveOdds);
        combinedAmerican = fmtAmericanFromDecimal(combinedDec);
        const calc = calcParlayPayout(p.stake, p.legs);
        payout = calc.payout;
        profit = calc.profit;
      }

      const legsLine = (p.legs || [])
        .map((l, i) => `${i + 1}) ${l.labelSnapshot} — ${fmtLegResult(l.result)}`)
        .join("\n");

      lines.push(
        `**Parlay #${p.parlayId}**\n` +
          `Odds: **${combinedAmerican}** | Stake: ${p.stake} ${CURRENCY}\n` +
          `To Win: ${profit} ${CURRENCY} | Payout: **${payout} ${CURRENCY}**\n` +
          `${legsLine}`
      );
    }

    embed.addFields({ name: `Parlays (${openParlays.length})`, value: lines.join("\n\n") || "—" });
  } else {
    embed.addFields({ name: "Parlays (0)", value: "—" });
  }

  await interaction.reply({ embeds: [embed] });
  return;
}


// ---------------- /market ----------------
if (interaction.commandName === "market") {
  const sub = interaction.options.getSubcommand();

  // only "list" exists now
  if (sub === "list") {
    const openOrLocked = Object.values(data.markets).filter(
      (m) => m.status === "OPEN" || m.status === "LOCKED"
    );

    if (openOrLocked.length === 0) {
      await interaction.reply("No markets right now.");
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle("📋 Markets")
      .setDescription("Showing OPEN and LOCKED markets. Odds update automatically unless frozen.");

    const sorted = openOrLocked.sort((a, b) => a.marketId - b.marketId);
    const betCounts = computeMarketBetPercents(data);

    for (const m of sorted) {
      const A = m.picks?.A;
      const B = m.picks?.B;

      const c = betCounts[m.marketId] || { A: 0, B: 0, total: 0 };
      const aTag = c.total > 0 ? pctTag(c.A, c.total) : "";
      const bTag = c.total > 0 ? pctTag(c.B, c.total) : "";

      const status =
        m.status === "LOCKED"
          ? "🔒 LOCKED"
          : m.oddsLocked
          ? "🧊 ODDS FROZEN"
          : "🟢 OPEN";

      const header = `#${m.marketId} — ${m.type}  ${status}`;
      let body = "";

      if (m.type === "PROP" && m.prop) {
  body += `Player: **${m.prop.player}** | Stat: **${m.prop.stat}** | Line: **${m.line}**\n`;
} else if (m.type === "TEAMTOTAL" && m.teamtotal) {
  body += `Team: **${m.teamtotal.team}** | Stat: **${m.teamtotal.stat}** | Line: **${m.line}**\n`;
} else if (m.type === "TOTAL") {
  body += `Line: **${m.line}**\n`;
} else {
  if (m.line !== null) body += `Line: **${m.line}**\n`;
}

      // add A/B labels explicitly
if (m.type === "PROP") {
  body += `**A:** ${A.label} **(${fmtOdds(A.odds)})**${aTag}\n`;
  body += `**B:** -`;
} else {
  body += `**A:** ${A.label} **(${fmtOdds(A.odds)})**${aTag}\n`;
  body += `**B:** ${B.label} **(${fmtOdds(B.odds)})**${bTag}`;
}


      embed.addFields({ name: header, value: body, inline: false });
    }

    await interaction.reply({ embeds: [embed] });
    return;
  }
}

// ---------------- /bookmarket ----------------
if (interaction.commandName === "bookmarket") {
  const sub = interaction.options.getSubcommand();

  if (!hasRole(interaction, BOOK_ROLE_NAME)) {
    await interaction.reply({
      content: `❌ Only the **${BOOK_ROLE_NAME}** role can use /bookmarket.`,
      ephemeral: true,
    });
    return;
  }

  // ---------------- create (MOVED FROM /market create) ----------------
  if (sub === "create") {
    const type = interaction.options.getString("type", true);
    const title = interaction.options.getString("title", true);
    const line = interaction.options.getNumber("line") ?? null;

    const player = interaction.options.getString("player") ?? null;
    const stat = interaction.options.getString("stat") ?? null;
    const kind = interaction.options.getString("kind") ?? null;

    let aLabel = interaction.options.getString("a_label");
    let bLabel = interaction.options.getString("b_label");
    let aOdds = defaultOdds(interaction.options.getInteger("a_odds"));
    let bOdds = defaultOdds(interaction.options.getInteger("b_odds"));

    if (aOdds === 0 || bOdds === 0) {
      await interaction.reply({ content: "❌ Odds cannot be 0.", ephemeral: true });
      return;
    }
    // ✅ TEAMTOTAL: enforce only one OPEN at a time
if (type === "TEAMTOTAL") {
  const existingOpenTT = Object.values(data.markets || {}).some(
    (m) => m.type === "TEAMTOTAL" && m.status === "OPEN"
  );
  if (existingOpenTT) {
    await interaction.reply({
      content: "❌ There is already an OPEN TEAMTOTAL market. Settle/lock it before creating a new one.",
      ephemeral: true,
    });
    return;
  }

  // TEAMTOTAL requires stat + line
  if (!stat || typeof line !== "number") {
    await interaction.reply({
      content: "❌ TEAMTOTAL requires: stat and line (ex: PENALTIES, 3.5).",
      ephemeral: true,
    });
    return;
  }

  // lock team to Eastern for now
  const team = "Eastern";
  const statUpper = String(stat).toUpperCase();

  // Default labels: Over/Under
  aLabel = aLabel ?? `Over ${line}`;
  bLabel = bLabel ?? `Under ${line}`;

  // Optionally, you can auto-title if you want:
  // title = title ?? `${team} ${statUpper}`;

  // Store extra metadata on market
  // (we’ll use this for display in /market list now, and for betting later)
}
    if (type === "PROP") {
  if (!player || !stat || typeof line !== "number") {
    await interaction.reply({
      content: "❌ PROP requires player, stat, and line.",
      ephemeral: true
    });
    return;
  }

  const statUpper = String(stat).toUpperCase();

  // Allow GOALS and PENALTIES
  if (!["GOALS", "PENALTIES"].includes(statUpper)) {
    await interaction.reply({
      content: "❌ Supported prop stats: GOALS, PENALTIES.",
      ephemeral: true
    });
    return;
  }

  // OVER-ONLY prop UI
  aLabel = aLabel ?? `Over ${line}`;
  bLabel = "-";
}


    if (type === "TOTAL") {
      const shownLine = line !== null ? line : "?";
      aLabel = aLabel ?? `Over ${shownLine}`;
      bLabel = bLabel ?? `Under ${shownLine}`;
    }

    if (type === "ML" || type === "SPREAD") {
      aLabel = aLabel ?? "Pick A";
      bLabel = bLabel ?? "Pick B";
    }

    const marketId = data.nextMarketId++;
    data.markets[marketId] = {
      marketId,
      type,
      title,
      line,
      status: "OPEN",      // OPEN | LOCKED | SETTLED
      oddsLocked: false,   // freeze odds movement but allow betting (only when OPEN)
      createdBy: interaction.user.id,
      createdAt: Date.now(),
      picks: {
        A: { label: aLabel, odds: clampOdds(aOdds) },
        B: { label: bLabel, odds: clampOdds(bOdds) },
      },
      prop: type === "PROP"
  ? { player, stat: String(stat).toUpperCase(), kind: kind || "OU" }
  : null,

// ✅ NEW: TEAMTOTAL metadata
teamtotal:
  type === "TEAMTOTAL"
    ? { team: "Eastern", stat: String(stat || "").toUpperCase(), kind: "OU" }
    : null,
    };

    save(data);

    const embed = new EmbedBuilder()
      .setTitle(`📈 ${type} Market #${marketId}`)
      .setDescription(
  `**${title}**` +
    (type === "PROP"
      ? `\nPlayer: **${player}** | Stat: **${String(stat).toUpperCase()}** | Line: **${line}**`
      : type === "TEAMTOTAL"
      ? `\nTeam: **Eastern** | Stat: **${String(stat).toUpperCase()}** | Line: **${line}**`
      : line !== null
      ? `\nLine: **${line}**`
      : "")
)
      .addFields(
  { name: "A", value: `${aLabel}\n**${fmtOdds(data.markets[marketId].picks.A.odds)}**`, inline: true },
  { name: "B", value: `${bLabel}`, inline: true },
  { name: "Status", value: "OPEN", inline: true }
);


    await interaction.reply({ embeds: [embed] });
    return;
  }

  // ---------------- lock ----------------
  if (sub === "lock") {
    const marketId = interaction.options.getInteger("market_id", true);
    const m = data.markets[marketId];
    if (!m) {
      await interaction.reply({ content: "❌ Market not found.", ephemeral: true });
      return;
    }
    if (m.status === "SETTLED") {
      await interaction.reply({ content: "❌ Market is already settled.", ephemeral: true });
      return;
    }
    m.status = "LOCKED";
    m.oddsLocked = true;
    save(data);
    await interaction.reply(`🔒 Locked Market #${marketId}. Betting disabled and odds frozen.`);
    return;
  }
    // ---------------- lockall ----------------
  if (sub === "lockall") {
    const openMarkets = Object.values(data.markets || {}).filter(
      (m) => m && m.status === "OPEN"
    );

    if (openMarkets.length === 0) {
      await interaction.reply({
        content: "ℹ️ No OPEN markets to lock.",
        ephemeral: true,
      });
      return;
    }

    for (const m of openMarkets) {
      m.status = "LOCKED";
      m.oddsLocked = true;
    }

    save(data);

    await interaction.reply(
      `🔒 Locked **${openMarkets.length}** OPEN market${openMarkets.length === 1 ? "" : "s"}. Betting disabled and odds frozen.`
    );
    return;
  }
  // ---------------- unlockall ----------------
if (sub === "unlockall") {
  const lockedMarkets = Object.values(data.markets || {}).filter(
    (m) => m && m.status === "LOCKED"
  );

  if (lockedMarkets.length === 0) {
    await interaction.reply({
      content: "ℹ️ No LOCKED markets to unlock.",
      ephemeral: true,
    });
    return;
  }

  for (const m of lockedMarkets) {
    m.status = "OPEN";
    m.oddsLocked = false;
  }

  save(data);

  await interaction.reply(
    `🟢 Unlocked **${lockedMarkets.length}** market${lockedMarkets.length === 1 ? "" : "s"}. Betting enabled and odds movement restored.`
  );
  return;
}
  // ---------------- unlock ----------------
  if (sub === "unlock") {
    const marketId = interaction.options.getInteger("market_id", true);
    const m = data.markets[marketId];
    if (!m) {
      await interaction.reply({ content: "❌ Market not found.", ephemeral: true });
      return;
    }
    if (m.status === "SETTLED") {
      await interaction.reply({ content: "❌ Market is already settled.", ephemeral: true });
      return;
    }
    m.status = "OPEN";
    save(data);
    await interaction.reply(`🟢 Unlocked Market #${marketId}. Betting allowed.`);
    return;
  }

  // ---------------- odds (freeze/unfreeze) ----------------
  if (sub === "odds") {
    const marketId = interaction.options.getInteger("market_id", true);
    const locked = interaction.options.getBoolean("locked", true);

    const m = data.markets[marketId];
    if (!m) {
      await interaction.reply({ content: "❌ Market not found.", ephemeral: true });
      return;
    }
    if (m.status === "SETTLED") {
      await interaction.reply({ content: "❌ Market is already settled.", ephemeral: true });
      return;
    }

    m.oddsLocked = locked;
    save(data);

    await interaction.reply(
      locked
        ? `🧊 Odds frozen for Market #${marketId}.`
        : `🔥 Odds movement enabled for Market #${marketId}.`
    );
    return;
  }

  // ---------------- nudge ----------------
  if (sub === "nudge") {
    const marketId = interaction.options.getInteger("market_id", true);
    const side = interaction.options.getString("side", true);
    const steps = interaction.options.getInteger("steps") ?? 1;

    const m = data.markets[marketId];
    if (!m) {
      await interaction.reply({ content: "❌ Market not found.", ephemeral: true });
      return;
    }
    if (m.status !== "OPEN") {
      await interaction.reply({ content: "❌ Market must be OPEN to nudge odds.", ephemeral: true });
      return;
    }
    if (m.oddsLocked) {
      await interaction.reply({
        content: "❌ Odds are frozen (unlock with /bookmarket odds locked:false).",
        ephemeral: true,
      });
      return;
    }

    applyOddsStepToMarket(m, side, steps);
    save(data);

    await interaction.reply(
      `📉 Nudged Market #${marketId} (hit ${side}) x${steps}.\n` +
        `A: ${m.picks.A.label} ${fmtOdds(m.picks.A.odds)} | B: ${m.picks.B.label} ${fmtOdds(m.picks.B.odds)}`
    );
    return;
  }

  // ---------------- settle ----------------
  if (sub === "settle") {
    const marketId = interaction.options.getInteger("market_id", true);
    const result = interaction.options.getString("result", true);

    const market = data.markets[marketId];
    if (!market) {
      await interaction.reply({ content: "❌ Market not found.", ephemeral: true });
      return;
    }
    if (market.status === "SETTLED") {
      await interaction.reply({ content: "❌ Market already settled.", ephemeral: true });
      return;
    }

    const bets = Object.values(data.bets || {}).filter(
      (b) => b.marketId === marketId && b.status === "OPEN"
    );

    let paid = 0;
    let pushed = 0;
    let winners = 0;
    let losers = 0;

    for (const bet of bets) {
      const u = getUser(data, bet.userId);

      if (result === "PUSH") {
        u.balance += bet.stake;
        bet.status = "PUSH";
        pushed += 1;
        continue;
      }

      if (bet.pick === result) {
        const { payout } = calcPayout(bet.stake, bet.odds);
        u.balance += payout;
        bet.status = "WON";
        winners += 1;
        paid += payout;
      } else {
        bet.status = "LOST";
        losers += 1;
      }
    }

    const parlaysToCheck = Object.values(data.parlays || {}).filter(
      (p) => p.status === "OPEN" && (p.legs || []).some((l) => l.marketId === marketId)
    );

    for (const p of parlaysToCheck) {
      for (const leg of p.legs) {
        if (leg.marketId !== marketId) continue;

        if (result === "PUSH") leg.result = "PUSH";
        else if (leg.pick === result) leg.result = "WON";
        else leg.result = "LOST";
      }

      if (p.legs.some((l) => l.result === "LOST")) {
        p.status = "SETTLED";
        continue;
      }

      const allResolved = p.legs.every((l) => l.result !== "PENDING");
      if (!allResolved) continue;

      const u = getUser(data, p.userId);

      if (p.legs.every((l) => l.result === "PUSH")) {
        u.balance += p.stake;
        p.status = "SETTLED";
        continue;
      }

      const { payout: parlayPayout } = calcParlayPayout(p.stake, p.legs);
      u.balance += parlayPayout;
      p.status = "SETTLED";
    }

    market.status = "SETTLED";
    save(data);

    await interaction.reply(
      `✅ Settled **Market #${marketId}** as **${result}**.\n`
    );
    return;
  }

  // fallback
  await interaction.reply({ content: "Unknown /bookmarket subcommand.", ephemeral: true });
  return;
}



    // ---------------- /bet place ----------------
    if (interaction.commandName === "bet") {
      const sub = interaction.options.getSubcommand();
      if (sub !== "place") return;
      const type = interaction.options.getString("type", true);
      const stake = interaction.options.getInteger("stake", true);
      if (stake > MAX_WAGER) {
        await interaction.reply({
          content: `❌ Max wager is **${MAX_WAGER} ${CURRENCY}** per bet.`,
          ephemeral: true,
        });
        return;
      }

      const pickKey = interaction.options.getString("pick", true); // A/B

      const market = Object.values(data.markets).find((m) => m.type === type && m.status === "OPEN");
      if (!market) {
        await interaction.reply({ content: `❌ No OPEN ${type} market available.`, ephemeral: true });
        return;
      }

      const pick = market.picks?.[pickKey];
      if (!pick) {
        await interaction.reply({ content: "❌ Invalid pick for this market.", ephemeral: true });
        return;
      }

      const u = getUser(data, interaction.user.id);
      if (u.balance < stake) {
        await interaction.reply({ content: `❌ Insufficient funds. Balance: ${u.balance} ${CURRENCY}`, ephemeral: true });
        return;
      }
      if (type === "PROP") {
  await interaction.reply({
    content: "❌ Props can only be added via parlays. Use `/parlay addprop`.",
    ephemeral: true,
  });
  return;
}


// snapshot odds for the preview (locks what they see)
const oddsSnapshot = pick.odds;

cleanupExpiredConfirms(data);
ensurePendingStore(data);

const nonce = makeNonce();
data.pendingConfirms[nonce] = {
  type: "bet",
  userId: interaction.user.id,
  createdAt: Date.now(),
  expiresAt: Date.now() + CONFIRM_TIMEOUT_MS,
  payload: {
    marketId: market.marketId,
    pickKey,
    stake,
    oddsSnapshot,
  },
};
save(data);

const { payout, profit } = calcPayout(stake, oddsSnapshot);

const preview = new EmbedBuilder()
  .setTitle("🧾 Confirm Bet")
  .setDescription(
    `**${market.title}**${market.line !== null ? `\nLine: **${market.line}**` : ""}\n` +
    `**Type:** ${market.type}\n` +
    `**Pick:** ${pick.label}`
  )
  .addFields(
    { name: "Odds", value: fmtOdds(oddsSnapshot), inline: true },
    { name: "Stake", value: `${stake} ${CURRENCY}`, inline: true },
    { name: "To Win", value: `${profit} ${CURRENCY}`, inline: true },
    { name: "Potential Payout", value: `${payout} ${CURRENCY}`, inline: false }
  )
  .setFooter({ text: "Confirm within 60 seconds" });

await interaction.reply({
  embeds: [preview],
  components: [buildConfirmRow(nonce)],
  ephemeral: true,
});
return;

    }

    // ---------------- /parlay ----------------
    if (interaction.commandName === "parlay") {
      const sub = interaction.options.getSubcommand();

      if (sub === "start") {
        const existing = findBuildingParlay(data, interaction.user.id);
        if (existing) {
          await interaction.reply({ content: "❌ You already have a parlay builder.", ephemeral: true });
          return;
        }

        const parlayId = data.nextParlayId++;
        data.parlays[parlayId] = {
          parlayId,
          userId: interaction.user.id,
          status: "BUILDING",
          stake: null,
          legs: [],
          createdAt: Date.now(),
          placedAt: null,
        };

        save(data);
        await interaction.reply({
          content: "✅ Parlay builder started.",
          embeds: [buildParlayPreviewEmbed(data.parlays[parlayId])],
        });
        return;
      }

      if (sub === "addline") {
        const p = findBuildingParlay(data, interaction.user.id);
        if (!p) {
          await interaction.reply({ content: "Start first: `/parlay start`", ephemeral: true });
          return;
        }

        const type = interaction.options.getString("type", true);
        const pickKey = interaction.options.getString("pick", true);

        // ✅ Correlated legs rule (Option 1): block ML + SPREAD together
        const hasML = (p.legs || []).some((l) => l.marketType === "ML");
        const hasSpread = (p.legs || []).some((l) => l.marketType === "SPREAD");
        if ((type === "ML" && hasSpread) || (type === "SPREAD" && hasML)) {
          await interaction.reply({
            content: "❌ Correlated legs not allowed (ML + Spread). Remove one to continue.",
            ephemeral: true,
          });
          return;
        }

        // only one of each type
        if ((p.legs || []).some((l) => l.marketType === type)) {
          await interaction.reply({
            content: `❌ You already have a **${type}** leg in this parlay.`,
            ephemeral: true,
          });
          return;
        }

        const market = Object.values(data.markets).find((m) => m.type === type && m.status === "OPEN");
        if (!market) {
          await interaction.reply({ content: `❌ No OPEN ${type} market right now.`, ephemeral: true });
          return;
        }

        if ((p.legs || []).some((l) => l.marketId === market.marketId)) {
          await interaction.reply({ content: "❌ You already added that market.", ephemeral: true });
          return;
        }

        if (p.legs.length >= 8) {
          await interaction.reply({ content: "❌ Max parlay size is 8 legs.", ephemeral: true });
          return;
        }

        const pick = market.picks?.[pickKey];
        if (!pick) {
          await interaction.reply({ content: "❌ Invalid pick for this market.", ephemeral: true });
          return;
        }

        const labelSnapshot =
  market.type === "TEAMTOTAL" && market.teamtotal
    ? `${market.teamtotal.team} ${market.teamtotal.stat} — ${pick.label} (Line ${market.line})`
    : pick.label;

p.legs.push({
  marketId: market.marketId,
  marketType: market.type, // ML/SPREAD/TOTAL/TEAMTOTAL
  pick: pickKey,
  labelSnapshot,
  oddsSnapshot: pick.odds,
  result: "PENDING",
});

        save(data);
        await interaction.reply({
          content: `✅ Added leg: [${market.type}] ${pick.label} (${fmtOdds(pick.odds)})`,
          embeds: [buildParlayPreviewEmbed(p)],
        });
        return;
      }

      if (sub === "addprop") {
  const p = findBuildingParlay(data, interaction.user.id);
  if (!p) {
    await interaction.reply({ content: "Start first: `/parlay start`", ephemeral: true });
    return;
  }

  if (p.legs.length >= 8) {
    await interaction.reply({ content: "❌ Max parlay size is 8 legs.", ephemeral: true });
    return;
  }

  const player = interaction.options.getString("player", true);
  const stat = interaction.options.getString("stat", true);
  const playerKey = normalizeKey(player);
  const statUpper = String(stat).toUpperCase();

  const candidates = Object.values(data.markets).filter((m) => {
    if (m.status !== "OPEN") return false;
    if (m.type !== "PROP") return false;
    if (!m.prop) return false;
    if (String(m.prop.stat || "").toUpperCase() !== statUpper) return false;
    return normalizeKey(m.prop.player) === playerKey;
  });

  if (candidates.length === 0) {
    await interaction.reply({
      content: `❌ No OPEN ${statUpper} prop found for **${player}**.`,
      ephemeral: true,
    });
    return;
  }

  if (candidates.length > 1) {
    await interaction.reply({
      content:
        `⚠️ Multiple OPEN ${statUpper} props found for **${player}**.\n` +
        `Ask the book to keep only one OPEN ${statUpper} prop for that subject at a time.`,
      ephemeral: true,
    });
    return;
  }

  const market = candidates[0];

  if ((p.legs || []).some((l) => l.marketId === market.marketId)) {
    await interaction.reply({ content: "❌ You already added that prop.", ephemeral: true });
    return;
  }

  // OVER-only props: always A
  const pickKey = "A";
  const pick = market.picks?.A;

  if (!pick) {
    await interaction.reply({ content: "❌ Prop market missing A pick.", ephemeral: true });
    return;
  }

  p.legs.push({
    marketId: market.marketId,
    marketType: "PROP",
    pick: pickKey,
    labelSnapshot: `${market.prop.player} ${market.prop.stat} — ${pick.label} (Line ${market.line})`,
    oddsSnapshot: pick.odds,
    result: "PENDING",
  });

  save(data);

  await interaction.reply({
    content: `✅ Added ${market.prop.stat} prop: ${market.prop.player} ${pick.label} (Line ${market.line}) (${fmtOdds(pick.odds)})`,
    embeds: [buildParlayPreviewEmbed(p)],
  });
  return;
}


      if (sub === "remove") {
        const p = findBuildingParlay(data, interaction.user.id);
        if (!p) {
          await interaction.reply({ content: "No parlay builder found. Use `/parlay start`.", ephemeral: true });
          return;
        }

        const legNum = interaction.options.getInteger("leg", true);
        const idx = legNum - 1;

        if (idx < 0 || idx >= p.legs.length) {
          await interaction.reply({ content: "❌ Invalid leg number.", ephemeral: true });
          return;
        }

        const removed = p.legs.splice(idx, 1)[0];
        save(data);

        await interaction.reply({
          content: `🗑️ Removed leg ${legNum}: ${removed.labelSnapshot}`,
          embeds: [buildParlayPreviewEmbed(p)],
        });
        return;
      }

      if (sub === "cancel") {
        const p = findBuildingParlay(data, interaction.user.id);
        if (!p) {
          await interaction.reply({ content: "No parlay builder to cancel.", ephemeral: true });
          return;
        }

        delete data.parlays[p.parlayId];
        save(data);

        await interaction.reply("🧹 Parlay builder cancelled.");
        return;
      }

      if (sub === "place") {
        const p = findBuildingParlay(data, interaction.user.id);
        if (!p) {
          await interaction.reply({ content: "No parlay builder found. Use `/parlay start`.", ephemeral: true });
          return;
        }

        if (p.legs.length < 2) {
          await interaction.reply({ content: "❌ Parlays require at least 2 legs.", ephemeral: true });
          return;
        }

        const stake = interaction.options.getInteger("stake", true);
        if (stake > MAX_WAGER) {
          await interaction.reply({
            content: `❌ Max wager is **${MAX_WAGER} ${CURRENCY}** per parlay.`,
            ephemeral: true,
          });
          return;
        }

        const u = getUser(data, interaction.user.id);

        if (u.balance < stake) {
          await interaction.reply({ content: `❌ Insufficient funds. Balance: ${u.balance} ${CURRENCY}`, ephemeral: true });
          return;
        }

        // block placing if any leg market is not OPEN (no live betting / locked markets)
        for (const leg of p.legs) {
          const m = data.markets?.[leg.marketId];
          if (!m || m.status !== "OPEN") {
            await interaction.reply({
              content: "❌ One or more legs are on a locked/unavailable market. Remove the leg or ask the book to unlock.",
              ephemeral: true,
            });
            return;
          }
        }

cleanupExpiredConfirms(data);
ensurePendingStore(data);

// Take a locked snapshot of legs at preview time
const legsSnapshot = p.legs.map((leg) => {
  const m = data.markets[leg.marketId];
  const pick = m?.picks?.[leg.pick];
  return {
    marketId: leg.marketId,
    marketType: leg.marketType,
    pick: leg.pick,
    labelSnapshot: (leg.marketType === "PROP" || leg.marketType === "TEAMTOTAL") ? leg.labelSnapshot : pick.label,
    oddsSnapshot: pick.odds,
    result: "PENDING",
  };
});

const nonce = makeNonce();
data.pendingConfirms[nonce] = {
  type: "parlay",
  userId: interaction.user.id,
  createdAt: Date.now(),
  expiresAt: Date.now() + CONFIRM_TIMEOUT_MS,
  payload: { parlayId: p.parlayId, stake, legsSnapshot },
};
save(data);

const calc = calcParlayPayout(stake, legsSnapshot);

const lines = legsSnapshot.map(
  (l, i) => `**${i + 1})** [${l.marketType}] ${l.labelSnapshot} (${fmtOdds(l.oddsSnapshot)})`
);

const preview = new EmbedBuilder()
  .setTitle("🧾 Confirm Parlay")
  .setDescription(lines.join("\n"))
  .addFields(
    { name: "Stake", value: `${stake} ${CURRENCY}`, inline: true },
    { name: "Potential Payout", value: `${calc.payout} ${CURRENCY}`, inline: true }
  )
  .setFooter({ text: "Confirm within 60 seconds" });

await interaction.reply({
  embeds: [preview],
  components: [buildConfirmRow(nonce)],
  ephemeral: true,
});
return;

      }
    }

    await interaction.reply({ content: "Unknown command.", ephemeral: true });
    save(data);
  } catch (err) {
    console.error(err);
    save(data);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: "❌ Error occurred. Check console.", ephemeral: true });
    } else {
      await interaction.reply({ content: "❌ Error occurred. Check console.", ephemeral: true });
    }
  }
});

client.login(token);
