require("dotenv").config();
const fs = require("fs");
const path = require("path");
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

const {
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
} = require("./store");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token) throw new Error("Missing DISCORD_TOKEN in .env");
if (!clientId) throw new Error("Missing CLIENT_ID in .env");
if (!guildId) throw new Error("Missing GUILD_ID in .env");

const BOOK_ROLE_NAME = "Book";
const CURRENCY = "Beans";

const MOVE_EVERY_BET = true;
const MIN_STAKE_TO_MOVE = 1;
const ODDS_STEP = 15;
const ODDS_MIN = -5000;
const ODDS_MAX = 5000;
const MAX_WAGER = 50;
const CONFIRM_TIMEOUT_MS = 60_000;
const HISTORY_PAGE_FIELD_LIMIT = 1000;
const HISTORY_PAGE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_ODDS = -120;

const ERROR_LOG_PATH = path.join(__dirname, "..", "error.log");

// In-memory history page sessions
const historyPages = {};

// ---------------- Error Logging ----------------
function logError(context, err, interaction = null) {
  const ts = new Date().toISOString();
  const user = interaction?.user
    ? `${interaction.user.username}(${interaction.user.id})`
    : "unknown";
  const command = interaction?.commandName ?? interaction?.customId ?? "unknown";
  const msg =
    `[${ts}] ERROR in ${context}\n` +
    `  User: ${user}\n` +
    `  Command: ${command}\n` +
    `  ${err?.stack ?? err}\n` +
    `---\n`;

  console.error(msg);
  try {
    fs.appendFileSync(ERROR_LOG_PATH, msg, "utf8");
  } catch (e) {
    console.error("Failed to write to error log:", e);
  }
}

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
  return typeof x === "number" && x !== 0 ? x : DEFAULT_ODDS;
}

function clampOdds(x) {
  let v = Math.max(ODDS_MIN, Math.min(ODDS_MAX, x));
  if (v === 0) v = 10;
  return v;
}

function normalizeAmericanOdds(odds) {
  if (odds < 0 && odds > -100) {
    return 200 - Math.abs(odds);
  }
  return odds;
}

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

  A.odds = normalizeAmericanOdds(A.odds);
  B.odds = normalizeAmericanOdds(B.odds);

  updateMarketOdds(market.marketId, A.odds, B.odds);
}

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

function normalizeKey(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ");
}

function buildParlayPreviewEmbed(p) {
  if (!p || !p.legs || p.legs.length === 0) {
    return new EmbedBuilder()
      .setTitle("🧱 Parlay Builder")
      .setDescription("No legs yet.\nUse `/parlay addline` or `/parlay addprop`.");
  }

  const oddsList = p.legs.map((l) => l.oddsSnapshot);
  const combinedDec = combinedDecimalFromAmericanOdds(oddsList);
  const combinedAmerican = fmtAmericanFromDecimal(combinedDec);

  const lines = p.legs.map(
    (l, i) =>
      `**${i + 1})** [${l.marketType}] ${l.labelSnapshot} (**${fmtOdds(l.oddsSnapshot)}**)`
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
    const candidate = current.length === 0 ? line : `${current}\n\n${line}`;
    if (candidate.length <= limit) {
      current = candidate;
    } else {
      if (current.length > 0) pages.push(current);
      if (line.length > limit) {
        pages.push(line.slice(0, limit - 4) + " ...");
        current = "";
      } else {
        current = line;
      }
    }
  }

  if (current.length > 0) pages.push(current);
  return pages.length > 0 ? pages : ["—"];
}

function cleanupExpiredHistoryPages() {
  const now = Date.now();
  for (const [k, v] of Object.entries(historyPages)) {
    if (!v || now > v.expiresAt) delete historyPages[k];
  }
}

function computeMarketBetPercents() {
  const counts = {};

  function bump(marketId, side) {
    if (!counts[marketId]) counts[marketId] = { A: 0, B: 0, total: 0 };
    if (side !== "A" && side !== "B") return;
    counts[marketId][side] += 1;
    counts[marketId].total += 1;
  }

  for (const b of getAllBets()) {
    if (typeof b.marketId !== "number") continue;
    bump(b.marketId, b.pick);
  }

  for (const p of getAllParlays()) {
    if (!p || (p.status !== "OPEN" && p.status !== "SETTLED")) continue;
    for (const leg of p.legs || []) {
      if (typeof leg.marketId !== "number") continue;
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

function computeUserLeaderboardStats(userId) {
  const singles = getSettledBetsForUser(userId);
  const parlays = getSettledParlaysForUser(userId);

  let wins = 0, losses = 0, pushes = 0, net = 0;

  for (const b of singles) {
    if (b.status === "PUSH") { pushes++; continue; }
    if (b.status === "LOST") { losses++; net -= b.stake; continue; }
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

    if (allPush) { pushes++; continue; }
    if (anyLost) { losses++; net -= p.stake; continue; }

    wins++;
    const { payout } = calcParlayPayout(p.stake, p.legs || []);
    net += payout - p.stake;
  }

  return { wins, losses, pushes, net, settledCount: singles.length + parlays.length };
}

function pctBar(sideCount, total) {
  if (!total || total <= 0) return "";
  const pct = Math.round((sideCount / total) * 100);
  return `${pct}%`;
}

function marketContextLine(m) {
  if (!m) return "Unknown Market";

  if (m.type === "TEAMTOTAL") {
    const team = m.teamtotal?.team ?? m.title ?? "Team";
    const stat = m.teamtotal?.stat ?? "TOTAL";
    const line = typeof m.line === "number" ? m.line : null;
    return line !== null
      ? `**${team}** — **${stat}** | Line: **${line}**`
      : `**${team}** — **${stat}**`;
  }

  if (m.type === "TOTAL") {
    const line = typeof m.line === "number" ? m.line : null;
    return line !== null ? `**${m.title}** | Line: **${line}**` : `**${m.title}**`;
  }

  if (m.type === "PROP" && m.prop) {
    const player = m.prop.player ?? "Player";
    const stat = m.prop.stat ?? "STAT";
    const line = typeof m.line === "number" ? m.line : null;
    return line !== null
      ? `**${player}** — **${stat}** | Line: **${line}**`
      : `**${player}** — **${stat}**`;
  }

  if (typeof m.line === "number" && m.type === "SPREAD") {
    return `**${m.title}** | Line: **${m.line}**`;
  }

  return `**${m.title}**`;
}

// ---------------- Market List Embed ----------------
function buildMarketEmbed(markets, betCounts) {
  const embed = new EmbedBuilder()
    .setTitle("📋 Current Markets")
    .setColor(0x2b2d31);

  if (markets.length === 0) {
    embed.setDescription("No open or locked markets right now.");
    return embed;
  }

  const typeOrder = ["ML", "SPREAD", "TOTAL", "TEAMTOTAL", "PROP"];
  const typeEmoji = { ML: "🏆", SPREAD: "📐", TOTAL: "🎯", TEAMTOTAL: "📊", PROP: "🎰" };

  const grouped = {};
  for (const m of markets) {
    if (!grouped[m.type]) grouped[m.type] = [];
    grouped[m.type].push(m);
  }

  for (const type of typeOrder) {
    if (!grouped[type]) continue;

    for (const m of grouped[type]) {
      const A = m.picks?.A;
      const B = m.picks?.B;
      const c = betCounts[m.marketId] || { A: 0, B: 0, total: 0 };

      const statusIcon =
        m.status === "LOCKED" ? "🔒" :
        m.oddsLocked ? "🧊" : "🟢";

      const header = `${typeEmoji[m.type] ?? "📌"} **#${m.marketId} — ${m.title}** ${statusIcon}`;

      const contextParts = [];
      if (m.type === "SPREAD" && typeof m.line === "number")
        contextParts.push(`Spread: **${m.line > 0 ? "+" : ""}${m.line}**`);
      if (m.type === "TOTAL" && typeof m.line === "number")
        contextParts.push(`Total: **${m.line}**`);
      if (m.type === "TEAMTOTAL" && m.teamtotal)
        contextParts.push(`${m.teamtotal.team} **${m.teamtotal.stat}** | Line: **${m.line}**`);
      if (m.type === "PROP" && m.prop)
        contextParts.push(`${m.prop.player} **${m.prop.stat}** | Line: **${m.line}**`);

      let pickLines = "";
      if (m.type === "PROP") {
        const aPct = c.total > 0 ? ` — ${pctBar(c.A, c.total)} of bets` : "";
        pickLines = `> **A:** ${A.label} \`${fmtOdds(A.odds)}\`${aPct}`;
      } else {
        const aPct = c.total > 0 ? ` — ${pctBar(c.A, c.total)} of bets` : "";
        const bPct = c.total > 0 ? ` — ${pctBar(c.B, c.total)} of bets` : "";
        pickLines =
          `> **A:** ${A.label} \`${fmtOdds(A.odds)}\`${aPct}\n` +
          `> **B:** ${B.label} \`${fmtOdds(B.odds)}\`${bPct}`;
      }

      const totalBets = c.total > 0 ? `${c.total} bet${c.total === 1 ? "" : "s"} placed` : "No action yet";

      const body =
        (contextParts.length > 0 ? `${contextParts.join(" | ")}\n` : "") +
        pickLines + "\n" +
        `*${totalBets}*`;

      embed.addFields({ name: header, value: body, inline: false });
    }
  }

  const openCount = markets.filter((m) => m.status === "OPEN").length;
  const lockedCount = markets.filter((m) => m.status === "LOCKED").length;
  embed.setFooter({
    text: `${openCount} open • ${lockedCount} locked • Odds move automatically unless 🧊 frozen`,
  });

  return embed;
}

// ---------------- Discord client ----------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  client.user.setPresence({
    activities: [{ name: "Watching hudl film", type: 3 }],
    status: "online",
  });
});

client.on(Events.InteractionCreate, async (interaction) => {

  // ----------------------------------------------------------------
  // BUTTON INTERACTIONS
  // ----------------------------------------------------------------
  if (interaction.isButton()) {
    try {
      cleanupExpiredConfirms();
      cleanupExpiredHistoryPages();

      // ---- History pagination ----
      if (
        interaction.customId.startsWith("history_prev:") ||
        interaction.customId.startsWith("history_next:") ||
        interaction.customId.startsWith("history_close:")
      ) {
        const [action, nonce] = interaction.customId.split(":");
        const session = historyPages[nonce];

        if (!session) {
          await interaction.reply({ content: "⏰ This history view expired.", ephemeral: true });
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
          delete historyPages[nonce];
          await interaction.update({ content: "📜 History closed.", embeds: [], components: [] });
          return;
        }

        if (action === "history_prev") session.pageIndex = Math.max(0, session.pageIndex - 1);
        if (action === "history_next") session.pageIndex = Math.min(session.pages.length - 1, session.pageIndex + 1);

        const pageText = session.pages[session.pageIndex] || "—";

        const embed = new EmbedBuilder()
          .setTitle(session.title)
          .setDescription(session.description)
          .addFields(
            { name: "Totals", value: session.totalsField, inline: true },
            { name: "Streak / Big Swings", value: session.streakField, inline: false },
            { name: "Settled Tickets", value: pageText, inline: false }
          )
          .setFooter({
            text: `Page ${session.pageIndex + 1} of ${session.pages.length} • Settled tickets for ${session.whoName}`,
          });

        await interaction.update({
          embeds: [embed],
          components: [buildHistoryButtonRow(nonce, session.pageIndex, session.pages.length)],
        });
        return;
      }

      // ---- Confirm / Cancel ----
      const [kind, nonce] = interaction.customId.split(":");
      const pending = getPendingConfirm(nonce);

      if (!pending) {
        await interaction.reply({ content: "⏰ This confirmation expired.", ephemeral: true });
        return;
      }

      if (pending.userId !== interaction.user.id) {
        await interaction.reply({ content: "❌ This confirmation isn't for you.", ephemeral: true });
        return;
      }

      if (kind === "cancel") {
        deletePendingConfirm(nonce);
        await interaction.update({ content: "❎ Cancelled.", embeds: [], components: [] });
        return;
      }

      if (kind === "confirm") {
        deletePendingConfirm(nonce);

        // ---- Place straight bet ----
        if (pending.type === "bet") {
          const { marketId, pickKey, stake, oddsSnapshot } = pending.payload;

          const market = getMarket(marketId);
          if (!market || market.status !== "OPEN") {
            await interaction.update({ content: "❌ Market is no longer OPEN.", embeds: [], components: [] });
            return;
          }

          const pick = market.picks?.[pickKey];
          if (!pick) {
            await interaction.update({ content: "❌ Pick no longer exists.", embeds: [], components: [] });
            return;
          }

          const u = getUser(interaction.user.id);
          if (stake > MAX_WAGER) {
            await interaction.update({ content: `❌ Max wager is ${MAX_WAGER} ${CURRENCY}.`, embeds: [], components: [] });
            return;
          }
          if (u.balance < stake) {
            await interaction.update({ content: `❌ Insufficient funds. Balance: ${u.balance} ${CURRENCY}`, embeds: [], components: [] });
            return;
          }

          const newBalance = adjustBalance(interaction.user.id, -stake);
          const betId = createBet({ marketId, userId: interaction.user.id, stake, pick: pickKey, odds: oddsSnapshot });

          if (MOVE_EVERY_BET && stake >= MIN_STAKE_TO_MOVE && canMarketMove(market)) {
            applyOddsStepToMarket(market, pickKey, 1);
          }

          const { payout, profit } = calcPayout(stake, oddsSnapshot);

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
              { name: "New Balance", value: `${newBalance} ${CURRENCY}`, inline: true }
            );

          await interaction.channel.send({
            content: `🎟️ <@${interaction.user.id}> placed a bet`,
            embeds: [slip],
          });
          await interaction.update({ content: "✅ Placed! (Posted to the channel)", embeds: [], components: [] });
          return;
        }

        // ---- Place parlay ----
        if (pending.type === "parlay") {
          const { parlayId, stake, legsSnapshot } = pending.payload;

          const p = getParlay(parlayId);
          if (!p || p.status !== "BUILDING") {
            await interaction.update({ content: "❌ Parlay builder no longer exists.", embeds: [], components: [] });
            return;
          }

          if (stake > MAX_WAGER) {
            await interaction.update({ content: `❌ Max wager is ${MAX_WAGER} ${CURRENCY}.`, embeds: [], components: [] });
            return;
          }

          const u = getUser(interaction.user.id);
          if (u.balance < stake) {
            await interaction.update({ content: `❌ Insufficient funds. Balance: ${u.balance} ${CURRENCY}`, embeds: [], components: [] });
            return;
          }

          for (const leg of legsSnapshot) {
            const m = getMarket(leg.marketId);
            if (!m || m.status !== "OPEN") {
              await interaction.update({ content: "❌ One or more legs are on a locked/unavailable market.", embeds: [], components: [] });
              return;
            }
          }

          const newBalance = adjustBalance(interaction.user.id, -stake);
          updateParlayPlaced(parlayId, stake, legsSnapshot);

          if (MOVE_EVERY_BET && stake >= MIN_STAKE_TO_MOVE) {
            for (const leg of legsSnapshot) {
              const m = getMarket(leg.marketId);
              if (canMarketMove(m)) applyOddsStepToMarket(m, leg.pick, 1);
            }
          }

          const preview = calcParlayPayout(stake, legsSnapshot);
          const lines = legsSnapshot.map(
            (l, i) => `**${i + 1})** [${l.marketType}] ${l.labelSnapshot} (${fmtOdds(l.oddsSnapshot)})`
          );

          const embed = new EmbedBuilder()
            .setTitle(`🧾 PARLAY SLIP #${parlayId}`)
            .setDescription(lines.join("\n"))
            .addFields(
              { name: "Stake", value: `${stake} ${CURRENCY}`, inline: true },
              { name: "Potential Payout", value: `${preview.payout} ${CURRENCY}`, inline: true },
              { name: "New Balance", value: `${newBalance} ${CURRENCY}`, inline: true }
            )
            .setFooter({ text: "Parlay is OPEN — settles as markets are settled" });

          await interaction.channel.send({
            content: `🧾 <@${interaction.user.id}> placed a parlay`,
            embeds: [embed],
          });
          await interaction.update({ content: "✅ Placed! (Posted to the channel)", embeds: [], components: [] });
          return;
        }

        await interaction.update({ content: "❌ Unknown confirmation type.", embeds: [], components: [] });
      }
    } catch (e) {
      logError("button handler", e, interaction);
      try {
        await interaction.reply({ content: "❌ Something went wrong. Try again.", ephemeral: true });
      } catch { /* already replied */ }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  try {
    // ----------------------------------------------------------------
    // /ping
    // ----------------------------------------------------------------
    if (interaction.commandName === "ping") {
      await interaction.reply("pong");
      return;
    }

    // ----------------------------------------------------------------
    // /help
    // ----------------------------------------------------------------
    if (interaction.commandName === "help") {
      await interaction.reply(`🫘 BEANS BOT — HOW TO USE ℹ️

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
/ping — Test the bots status`);
      return;
    }

    // ----------------------------------------------------------------
    // /leaderboard
    // ----------------------------------------------------------------
    if (interaction.commandName === "leaderboard") {
      const userIds = getAllUserIds();
      const rows = [];

      for (const userId of userIds) {
        const stats = computeUserLeaderboardStats(userId);
        if (stats.settledCount <= 0) continue;
        const name = await getDisplayNameFromGuild(interaction, userId);
        rows.push({ userId, name, ...stats });
      }

      if (rows.length === 0) {
        await interaction.reply("No settled bets yet, so the leaderboard is empty.");
        return;
      }

      rows.sort((a, b) => {
        if (b.net !== a.net) return b.net - a.net;
        if (b.wins !== a.wins) return b.wins - a.wins;
        return a.name.localeCompare(b.name);
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
        .setFooter({ text: `Your rank: ${viewerRankText} • Ranked by net ${CURRENCY} • Settled tickets only` });

      await interaction.reply({ embeds: [embed] });
      return;
    }

    // ----------------------------------------------------------------
    // /bank
    // ----------------------------------------------------------------
    if (interaction.commandName === "bank") {
      const sub = interaction.options.getSubcommand();

      if (sub === "balance") {
        const targetUser = interaction.options.getUser("user");

        if (
          targetUser &&
          !(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
            hasRole(interaction, BOOK_ROLE_NAME))
        ) {
          await interaction.reply({ content: "❌ Only admins/book can check other users' balances.", ephemeral: true });
          return;
        }

        const userToCheck = targetUser ?? interaction.user;
        const u = getUser(userToCheck.id);
        await interaction.reply(`💰 **${userToCheck.username}'s Balance:** ${u.balance} ${CURRENCY}`);
        return;
      }
    }

    // ----------------------------------------------------------------
    // /adminbank
    // ----------------------------------------------------------------
    if (interaction.commandName === "adminbank") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: "❌ Admins only.", ephemeral: true });
        return;
      }

      const sub = interaction.options.getSubcommand();

      if (sub === "give") {
        const user = interaction.options.getUser("user", true);
        const amount = interaction.options.getInteger("amount", true);
        const newBalance = adjustBalance(user.id, amount);
        await interaction.reply(`✅ Gave **${amount} ${CURRENCY}** to <@${user.id}>. New balance: **${newBalance}**`);
        return;
      }

      if (sub === "take") {
        const user = interaction.options.getUser("user", true);
        const amount = interaction.options.getInteger("amount", true);
        const u = getUser(user.id);
        const deducted = Math.min(amount, u.balance);
        const newBalance = adjustBalance(user.id, -deducted);
        await interaction.reply(`➖ Deducted **${deducted} ${CURRENCY}** from <@${user.id}>. New balance: **${newBalance}**`);
        return;
      }
    }

    // ----------------------------------------------------------------
    // /adminhistory
    // ----------------------------------------------------------------
    if (interaction.commandName === "adminhistory") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: "❌ Admins only.", ephemeral: true });
        return;
      }

      const sub = interaction.options.getSubcommand();

      if (sub === "clear") {
        const user = interaction.options.getUser("user", true);
        const userId = user.id;

        const settledBets = getSettledBetsForUser(userId);
        for (const b of settledBets) updateBetStatus(b.betId, "CLEARED");

        const settledParlays = getSettledParlaysForUser(userId);
        for (const p of settledParlays) deleteParlay(p.parlayId);

        await interaction.reply(
          `🧹 Cleared history for <@${userId}>.\nRemoved **${settledBets.length}** singles and **${settledParlays.length}** parlays.`
        );
        return;
      }
    }

    // ----------------------------------------------------------------
    // /book stats
    // ----------------------------------------------------------------
    if (interaction.commandName === "book") {
      const sub = interaction.options.getSubcommand();

      if (sub === "stats") {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
          await interaction.reply({ content: "❌ Admins only.", ephemeral: true });
          return;
        }

        const allBets = getAllBets();
        const settledSingles = allBets.filter((b) => b.status && b.status !== "OPEN");

        let singlesHouseNet = 0, singlesWon = 0, singlesLost = 0, singlesPushed = 0;

        for (const b of settledSingles) {
          if (b.status === "LOST") { singlesHouseNet += b.stake; singlesLost++; }
          else if (b.status === "WON") {
            const { profit } = calcPayout(b.stake, b.odds);
            singlesHouseNet -= profit;
            singlesWon++;
          } else if (b.status === "PUSH") {
            singlesPushed++;
          }
        }

        const settledParlays = getAllSettledParlays();
        let parlaysHouseNet = 0, parlaysWon = 0, parlaysLost = 0, parlaysPushed = 0;

        for (const p of settledParlays) {
          const legs = p.legs || [];
          const anyLost = legs.some((l) => l.result === "LOST");
          const allPush = legs.length > 0 && legs.every((l) => l.result === "PUSH");

          if (anyLost) { parlaysHouseNet += p.stake; parlaysLost++; }
          else if (allPush) { parlaysPushed++; }
          else {
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

    // ----------------------------------------------------------------
    // /history view
    // ----------------------------------------------------------------
    if (interaction.commandName === "history") {
      const sub = interaction.options.getSubcommand();

      if (sub === "view") {
        const targetUser = interaction.options.getUser("user");
        if (
          targetUser &&
          !(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
            hasRole(interaction, BOOK_ROLE_NAME))
        ) {
          await interaction.reply({ content: "❌ Only admins/book can view another user's history.", ephemeral: true });
          return;
        }

        const userObj = targetUser ?? interaction.user;
        const userId = userObj.id;
        const whoName = userObj.username;

        const settledSingles = getSettledBetsForUser(userId);
        const settledParlays = getSettledParlaysForUser(userId);

        if (settledSingles.length === 0 && settledParlays.length === 0) {
          await interaction.reply(`${whoName} doesn't have any settled tickets yet.`);
          return;
        }

        function singleTicketMoney(b) {
          if (b.status === "PUSH") return { stake: b.stake, payout: b.stake, net: 0, w: 0, l: 0, p: 1 };
          if (b.status === "LOST") return { stake: b.stake, payout: 0, net: -b.stake, w: 0, l: 1, p: 0 };
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
          if (outcome === "PUSH") return { stake, payout: stake, net: 0, w: 0, l: 0, p: 1 };
          if (outcome === "LOST") return { stake, payout: 0, net: -stake, w: 0, l: 1, p: 0 };
          const { payout } = calcParlayPayout(stake, p.legs || []);
          return { stake, payout, net: payout - stake, w: 1, l: 0, p: 0 };
        }

        function safeROI(net, stake) {
          if (!stake || stake <= 0) return 0;
          return Math.round((net / stake) * 100);
        }

        let tW = 0, tL = 0, tP = 0, tStake = 0, tPayout = 0, tNet = 0;
        const recent = [];

        for (const b of settledSingles) {
          const mkt = getMarket(b.marketId);
          const pick = mkt?.picks?.[b.pick];
          const money = singleTicketMoney(b);

          tW += money.w; tL += money.l; tP += money.p;
          tStake += money.stake; tPayout += money.payout; tNet += money.net;

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

          tW += money.w; tL += money.l; tP += money.p;
          tStake += money.stake; tPayout += money.payout; tNet += money.net;

          const emoji = outcome === "WON" ? "✅" : outcome === "LOST" ? "❌" : "↔️";

          const legsLines = (p.legs || [])
            .map((l, i) => {
              const resEmoji =
                l.result === "WON" ? "✅" :
                l.result === "LOST" ? "❌" :
                l.result === "PUSH" ? "↔️" : "⏳";
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

        let streakType = null, streakCount = 0;
        for (const r of recent) {
          if (r.outcome === "PUSH") continue;
          const t = r.outcome === "WON" ? "W" : "L";
          if (!streakType) { streakType = t; streakCount = 1; }
          else if (t === streakType) { streakCount++; }
          else break;
        }
        const streakStr = streakType ? `${streakType}${streakCount}` : "—";

        let biggestWinNet = null, biggestLossNet = null;
        for (const r of recent) {
          if (typeof r.net !== "number") continue;
          if (r.net > 0 && (biggestWinNet === null || r.net > biggestWinNet)) biggestWinNet = r.net;
          if (r.net < 0 && (biggestLossNet === null || r.net < biggestLossNet)) biggestLossNet = r.net;
        }

        const tROI = safeROI(tNet, tStake);
        const allTicketLines = recent.map((r) => r.line);
        const pages = chunkHistoryLines(allTicketLines);

        cleanupExpiredHistoryPages();
        const nonce = makeNonce();
        historyPages[nonce] = {
          userId: interaction.user.id,
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

        const embed = new EmbedBuilder()
          .setTitle(historyPages[nonce].title)
          .setDescription(historyPages[nonce].description)
          .addFields(
            { name: "Totals", value: historyPages[nonce].totalsField, inline: true },
            { name: "Streak / Big Swings", value: historyPages[nonce].streakField, inline: false },
            { name: "Settled Tickets", value: pages[0] || "—", inline: false }
          )
          .setFooter({ text: `Page 1 of ${pages.length} • Settled tickets for ${whoName}` });

        await interaction.reply({
          embeds: [embed],
          components: [buildHistoryButtonRow(nonce, 0, pages.length)],
        });
        return;
      }
    }

    // ----------------------------------------------------------------
    // /open
    // ----------------------------------------------------------------
    if (interaction.commandName === "open") {
      const targetUser = interaction.options.getUser("user");

      if (targetUser && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: "❌ Only admins can view another user's open tickets.", ephemeral: true });
        return;
      }

      const userObj = targetUser ?? interaction.user;
      const userId = userObj.id;
      const whoName = userObj.username;

      const openBets = getOpenBetsForUser(userId);
      const openParlays = getOpenParlaysForUser(userId);

      if (openBets.length === 0 && openParlays.length === 0) {
        await interaction.reply(`${whoName} has no open slips or open parlays.`);
        return;
      }

      const embed = new EmbedBuilder().setTitle(`🎟️ Open Tickets — ${whoName}`);

      if (openBets.length > 0) {
        const lines = [];
        for (const b of openBets) {
          const m = getMarket(b.marketId);
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
          let combinedAmerican = "N/A", payout = p.stake, profit = 0;

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

    // ----------------------------------------------------------------
    // /market list
    // ----------------------------------------------------------------
    if (interaction.commandName === "market") {
      const sub = interaction.options.getSubcommand();

      if (sub === "list") {
        const allMarkets = getAllMarkets();
        const openOrLocked = allMarkets
          .filter((m) => m.status === "OPEN" || m.status === "LOCKED")
          .sort((a, b) => a.marketId - b.marketId);

        const betCounts = computeMarketBetPercents();
        const embed = buildMarketEmbed(openOrLocked, betCounts);
        await interaction.reply({ embeds: [embed] });
        return;
      }
    }

    // ----------------------------------------------------------------
    // /bookmarket
    // ----------------------------------------------------------------
    if (interaction.commandName === "bookmarket") {
      if (!hasRole(interaction, BOOK_ROLE_NAME)) {
        await interaction.reply({
          content: `❌ Only the **${BOOK_ROLE_NAME}** role can use /bookmarket.`,
          ephemeral: true,
        });
        return;
      }

      const sub = interaction.options.getSubcommand();

      // ---- create ----
      if (sub === "create") {
        const type = interaction.options.getString("type", true);
        const title = interaction.options.getString("title", true);
        const line = interaction.options.getNumber("line") ?? null;
        const player = interaction.options.getString("player") ?? null;
        const stat = interaction.options.getString("stat") ?? null;

        let aLabel = interaction.options.getString("a_label");
        let bLabel = interaction.options.getString("b_label");
        let aOdds = defaultOdds(interaction.options.getInteger("a_odds"));
        let bOdds = defaultOdds(interaction.options.getInteger("b_odds"));

        if (aOdds === 0 || bOdds === 0) {
          await interaction.reply({ content: "❌ Odds cannot be 0.", ephemeral: true });
          return;
        }

        let prop = null;
        let teamtotal = null;

        if (type === "TEAMTOTAL") {
          const existingOpenTT = getAllMarkets().some(
            (m) => m.type === "TEAMTOTAL" && m.status === "OPEN"
          );
          if (existingOpenTT) {
            await interaction.reply({
              content: "❌ There is already an OPEN TEAMTOTAL market. Settle/lock it before creating a new one.",
              ephemeral: true,
            });
            return;
          }
          if (!stat || typeof line !== "number") {
            await interaction.reply({ content: "❌ TEAMTOTAL requires: stat and line.", ephemeral: true });
            return;
          }
          aLabel = aLabel ?? `Over ${line}`;
          bLabel = bLabel ?? `Under ${line}`;
          teamtotal = { team: "Eastern", stat: String(stat).toUpperCase(), kind: "OU" };
        }

        if (type === "PROP") {
          if (!player || !stat || typeof line !== "number") {
            await interaction.reply({ content: "❌ PROP requires player, stat, and line.", ephemeral: true });
            return;
          }
          const statUpper = String(stat).toUpperCase();
          if (!["GOALS", "PENALTIES"].includes(statUpper)) {
            await interaction.reply({ content: "❌ Supported prop stats: GOALS, PENALTIES.", ephemeral: true });
            return;
          }
          aLabel = aLabel ?? `Over ${line}`;
          bLabel = "-";
          prop = { player, stat: statUpper, kind: "OU" };
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

        const market = createMarket({
          type, title, line,
          createdBy: interaction.user.id,
          pickALabel: aLabel,
          pickAOdds: clampOdds(aOdds),
          pickBLabel: bLabel,
          pickBOdds: clampOdds(bOdds),
          prop,
          teamtotal,
        });

        const embed = new EmbedBuilder()
          .setTitle(`📈 ${type} Market #${market.marketId}`)
          .setDescription(
            `**${title}**` +
            (type === "PROP"
              ? `\nPlayer: **${player}** | Stat: **${String(stat).toUpperCase()}** | Line: **${line}**`
              : type === "TEAMTOTAL"
              ? `\nTeam: **Eastern** | Stat: **${String(stat).toUpperCase()}** | Line: **${line}**`
              : line !== null ? `\nLine: **${line}**` : "")
          )
          .addFields(
            { name: "A", value: `${aLabel}\n**${fmtOdds(market.picks.A.odds)}**`, inline: true },
            { name: "B", value: `${bLabel}`, inline: true },
            { name: "Status", value: "OPEN", inline: true }
          );

        await interaction.reply({ embeds: [embed] });
        return;
      }

      // ---- lock ----
      if (sub === "lock") {
        const marketId = interaction.options.getInteger("market_id", true);
        const m = getMarket(marketId);
        if (!m) { await interaction.reply({ content: "❌ Market not found.", ephemeral: true }); return; }
        if (m.status === "SETTLED") { await interaction.reply({ content: "❌ Market is already settled.", ephemeral: true }); return; }
        updateMarketStatus(marketId, "LOCKED");
        updateMarketOddsLocked(marketId, true);
        await interaction.reply(`🔒 Locked Market #${marketId}. Betting disabled and odds frozen.`);
        return;
      }

      // ---- lockall ----
      if (sub === "lockall") {
        const openMarkets = getAllMarkets().filter((m) => m.status === "OPEN");
        if (openMarkets.length === 0) {
          await interaction.reply({ content: "ℹ️ No OPEN markets to lock.", ephemeral: true });
          return;
        }
        for (const m of openMarkets) {
          updateMarketStatus(m.marketId, "LOCKED");
          updateMarketOddsLocked(m.marketId, true);
        }
        await interaction.reply(`🔒 Locked **${openMarkets.length}** OPEN market${openMarkets.length === 1 ? "" : "s"}.`);
        return;
      }

      // ---- unlockall ----
      if (sub === "unlockall") {
        const lockedMarkets = getAllMarkets().filter((m) => m.status === "LOCKED");
        if (lockedMarkets.length === 0) {
          await interaction.reply({ content: "ℹ️ No LOCKED markets to unlock.", ephemeral: true });
          return;
        }
        for (const m of lockedMarkets) {
          updateMarketStatus(m.marketId, "OPEN");
          updateMarketOddsLocked(m.marketId, false);
        }
        await interaction.reply(`🟢 Unlocked **${lockedMarkets.length}** market${lockedMarkets.length === 1 ? "" : "s"}.`);
        return;
      }

      // ---- unlock ----
      if (sub === "unlock") {
        const marketId = interaction.options.getInteger("market_id", true);
        const m = getMarket(marketId);
        if (!m) { await interaction.reply({ content: "❌ Market not found.", ephemeral: true }); return; }
        if (m.status === "SETTLED") { await interaction.reply({ content: "❌ Market is already settled.", ephemeral: true }); return; }
        updateMarketStatus(marketId, "OPEN");
        updateMarketOddsLocked(marketId, false);
        await interaction.reply(`🟢 Unlocked Market #${marketId}. Betting allowed.`);
        return;
      }

      // ---- odds ----
      if (sub === "odds") {
        const marketId = interaction.options.getInteger("market_id", true);
        const locked = interaction.options.getBoolean("locked", true);
        const m = getMarket(marketId);
        if (!m) { await interaction.reply({ content: "❌ Market not found.", ephemeral: true }); return; }
        if (m.status === "SETTLED") { await interaction.reply({ content: "❌ Market is already settled.", ephemeral: true }); return; }
        updateMarketOddsLocked(marketId, locked);
        await interaction.reply(
          locked ? `🧊 Odds frozen for Market #${marketId}.` : `🔥 Odds movement enabled for Market #${marketId}.`
        );
        return;
      }

      // ---- nudge ----
      if (sub === "nudge") {
        const marketId = interaction.options.getInteger("market_id", true);
        const side = interaction.options.getString("side", true);
        const steps = interaction.options.getInteger("steps") ?? 1;
        const m = getMarket(marketId);
        if (!m) { await interaction.reply({ content: "❌ Market not found.", ephemeral: true }); return; }
        if (m.status !== "OPEN") { await interaction.reply({ content: "❌ Market must be OPEN to nudge odds.", ephemeral: true }); return; }
        if (m.oddsLocked) { await interaction.reply({ content: "❌ Odds are frozen.", ephemeral: true }); return; }
        applyOddsStepToMarket(m, side, steps);
        await interaction.reply(
          `📉 Nudged Market #${marketId} (hit ${side}) x${steps}.\n` +
          `A: ${m.picks.A.label} ${fmtOdds(m.picks.A.odds)} | B: ${m.picks.B.label} ${fmtOdds(m.picks.B.odds)}`
        );
        return;
      }

      // ---- settle ----
      if (sub === "settle") {
        const marketId = interaction.options.getInteger("market_id", true);
        const result = interaction.options.getString("result", true);
        const market = getMarket(marketId);
        if (!market) { await interaction.reply({ content: "❌ Market not found.", ephemeral: true }); return; }
        if (market.status === "SETTLED") { await interaction.reply({ content: "❌ Market already settled.", ephemeral: true }); return; }

        const bets = getOpenBetsForMarket(marketId);

        for (const bet of bets) {
          if (result === "PUSH") {
            adjustBalance(bet.userId, bet.stake);
            updateBetStatus(bet.betId, "PUSH");
          } else if (bet.pick === result) {
            const { payout } = calcPayout(bet.stake, bet.odds);
            adjustBalance(bet.userId, payout);
            updateBetStatus(bet.betId, "WON");
          } else {
            updateBetStatus(bet.betId, "LOST");
          }
        }

        const parlaysToCheck = getOpenParlaysForMarket(marketId);

        for (const p of parlaysToCheck) {
          for (const leg of p.legs) {
            if (leg.marketId !== marketId) continue;
            const legResult =
              result === "PUSH" ? "PUSH" :
              leg.pick === result ? "WON" : "LOST";
            updateParlayLegResult(p.parlayId, marketId, legResult);
          }

          const updated = getParlay(p.parlayId);
          const legs = updated.legs || [];

          if (legs.some((l) => l.result === "LOST")) {
            updateParlayStatus(p.parlayId, "SETTLED");
            continue;
          }

          const allResolved = legs.every((l) => l.result !== "PENDING");
          if (!allResolved) continue;

          if (legs.every((l) => l.result === "PUSH")) {
            adjustBalance(updated.userId, updated.stake);
            updateParlayStatus(p.parlayId, "SETTLED");
            continue;
          }

          const { payout: parlayPayout } = calcParlayPayout(updated.stake, legs);
          adjustBalance(updated.userId, parlayPayout);
          updateParlayStatus(p.parlayId, "SETTLED");
        }

        updateMarketStatus(marketId, "SETTLED");
        await interaction.reply(`✅ Settled **Market #${marketId}** as **${result}**.`);
        return;
      }

      // ---- risk ----
      if (sub === "risk") {
        const allMarkets = getAllMarkets();
        const openMarkets = allMarkets.filter((m) => m.status === "OPEN" || m.status === "LOCKED");

        if (openMarkets.length === 0) {
          await interaction.reply({ content: "ℹ️ No open markets to show risk for.", ephemeral: true });
          return;
        }

        const allOpenBets = getAllBets().filter((b) => b.status === "OPEN");
        const allOpenParlays = getAllParlays().filter((p) => p.status === "OPEN");

        const embed = new EmbedBuilder()
          .setTitle("⚠️ Operator Risk Dashboard")
          .setColor(0xe67e22);

        let totalExposureA = 0;
        let totalExposureB = 0;
        let marketsWithAction = 0;

        for (const m of openMarkets.sort((a, b) => a.marketId - b.marketId)) {
          const singleBets = allOpenBets.filter((b) => b.marketId === m.marketId);

          const parlayLegs = [];
          for (const p of allOpenParlays) {
            for (const leg of p.legs || []) {
              if (leg.marketId === m.marketId && leg.result === "PENDING") {
                parlayLegs.push({ ...leg, parlayStake: p.stake, parlayId: p.parlayId });
              }
            }
          }

          let stakeOnA = 0, stakeOnB = 0;
          let payoutIfAWins = 0, payoutIfBWins = 0;

          for (const b of singleBets) {
            if (b.pick === "A") {
              stakeOnA += b.stake;
              const { payout } = calcPayout(b.stake, b.odds);
              payoutIfAWins += payout;
            } else {
              stakeOnB += b.stake;
              const { payout } = calcPayout(b.stake, b.odds);
              payoutIfBWins += payout;
            }
          }

          const totalStake = stakeOnA + stakeOnB;

          // House net if A wins = stake collected from B bettors minus profit paid to A bettors
          const houseIfAWins = stakeOnB - (payoutIfAWins - stakeOnA);
          const houseIfBWins = stakeOnA - (payoutIfBWins - stakeOnB);

          totalExposureA += houseIfAWins;
          totalExposureB += houseIfBWins;

          if (totalStake === 0 && parlayLegs.length === 0) continue;

          marketsWithAction++;
          const statusIcon = m.status === "LOCKED" ? "🔒" : "🟢";
          const A = m.picks?.A;
          const B = m.picks?.B;

          const aLine = `**${A?.label ?? "A"}** \`${fmtOdds(A?.odds ?? 0)}\` — ${stakeOnA} ${CURRENCY} wagered`;
          const bLine = `**${B?.label ?? "B"}** \`${fmtOdds(B?.odds ?? 0)}\` — ${stakeOnB} ${CURRENCY} wagered`;
          const houseALine = `House if **A** wins: **${formatSigned(houseIfAWins)} ${CURRENCY}**`;
          const houseBLine = `House if **B** wins: **${formatSigned(houseIfBWins)} ${CURRENCY}**`;

          let fieldValue =
            `${aLine}\n${bLine}\n` +
            `Total action: **${totalStake} ${CURRENCY}**\n` +
            `${houseALine} | ${houseBLine}`;

          if (parlayLegs.length > 0) {
            fieldValue += `\n*+${parlayLegs.length} parlay leg${parlayLegs.length === 1 ? "" : "s"} pending*`;
          }

          embed.addFields({
            name: `${statusIcon} #${m.marketId} — ${m.title} [${m.type}]`,
            value: fieldValue,
            inline: false,
          });
        }

        if (marketsWithAction === 0) {
          embed.setDescription("No action on any open markets yet.");
        }

        embed.setFooter({
          text: `Overall: If all A → ${formatSigned(totalExposureA)} ${CURRENCY} | If all B → ${formatSigned(totalExposureB)} ${CURRENCY}`,
        });

        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      await interaction.reply({ content: "Unknown /bookmarket subcommand.", ephemeral: true });
      return;
    }

    // ----------------------------------------------------------------
    // /bet place
    // ----------------------------------------------------------------
    if (interaction.commandName === "bet") {
      const sub = interaction.options.getSubcommand();
      if (sub !== "place") return;

      const type = interaction.options.getString("type", true);
      const stake = interaction.options.getInteger("stake", true);

      if (stake > MAX_WAGER) {
        await interaction.reply({ content: `❌ Max wager is **${MAX_WAGER} ${CURRENCY}** per bet.`, ephemeral: true });
        return;
      }

      if (type === "PROP") {
        await interaction.reply({ content: "❌ Props can only be added via parlays. Use `/parlay addprop`.", ephemeral: true });
        return;
      }

      const pickKey = interaction.options.getString("pick", true);
      const allMarkets = getAllMarkets();
      const market = allMarkets.find((m) => m.type === type && m.status === "OPEN");

      if (!market) {
        await interaction.reply({ content: `❌ No OPEN ${type} market available.`, ephemeral: true });
        return;
      }

      const pick = market.picks?.[pickKey];
      if (!pick) {
        await interaction.reply({ content: "❌ Invalid pick for this market.", ephemeral: true });
        return;
      }

      const u = getUser(interaction.user.id);
      if (u.balance < stake) {
        await interaction.reply({ content: `❌ Insufficient funds. Balance: ${u.balance} ${CURRENCY}`, ephemeral: true });
        return;
      }

      const oddsSnapshot = pick.odds;
      cleanupExpiredConfirms();

      const nonce = makeNonce();
      setPendingConfirm({
        nonce,
        userId: interaction.user.id,
        type: "bet",
        payload: { marketId: market.marketId, pickKey, stake, oddsSnapshot },
        expiresAt: Date.now() + CONFIRM_TIMEOUT_MS,
      });

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

      await interaction.reply({ embeds: [preview], components: [buildConfirmRow(nonce)], ephemeral: true });
      return;
    }

    // ----------------------------------------------------------------
    // /parlay
    // ----------------------------------------------------------------
    if (interaction.commandName === "parlay") {
      const sub = interaction.options.getSubcommand();

      if (sub === "start") {
        const existing = getBuildingParlay(interaction.user.id);
        if (existing) {
          await interaction.reply({ content: "❌ You already have a parlay builder.", ephemeral: true });
          return;
        }
        const parlayId = createParlay(interaction.user.id);
        const p = getParlay(parlayId);
        await interaction.reply({ content: "✅ Parlay builder started.", embeds: [buildParlayPreviewEmbed(p)] });
        return;
      }

      if (sub === "addline") {
        const p = getBuildingParlay(interaction.user.id);
        if (!p) { await interaction.reply({ content: "Start first: `/parlay start`", ephemeral: true }); return; }

        const type = interaction.options.getString("type", true);
        const pickKey = interaction.options.getString("pick", true);

        const hasML = p.legs.some((l) => l.marketType === "ML");
        const hasSpread = p.legs.some((l) => l.marketType === "SPREAD");
        if ((type === "ML" && hasSpread) || (type === "SPREAD" && hasML)) {
          await interaction.reply({ content: "❌ Correlated legs not allowed (ML + Spread).", ephemeral: true });
          return;
        }

        if (p.legs.some((l) => l.marketType === type)) {
          await interaction.reply({ content: `❌ You already have a **${type}** leg in this parlay.`, ephemeral: true });
          return;
        }

        if (p.legs.length >= 8) {
          await interaction.reply({ content: "❌ Max parlay size is 8 legs.", ephemeral: true });
          return;
        }

        const allMarkets = getAllMarkets();
        const market = allMarkets.find((m) => m.type === type && m.status === "OPEN");
        if (!market) { await interaction.reply({ content: `❌ No OPEN ${type} market right now.`, ephemeral: true }); return; }

        if (p.legs.some((l) => l.marketId === market.marketId)) {
          await interaction.reply({ content: "❌ You already added that market.", ephemeral: true });
          return;
        }

        const pick = market.picks?.[pickKey];
        if (!pick) { await interaction.reply({ content: "❌ Invalid pick for this market.", ephemeral: true }); return; }

        const labelSnapshot =
          market.type === "TEAMTOTAL" && market.teamtotal
            ? `${market.teamtotal.team} ${market.teamtotal.stat} — ${pick.label} (Line ${market.line})`
            : pick.label;

        addParlayLeg({
          parlayId: p.parlayId,
          marketId: market.marketId,
          marketType: market.type,
          pick: pickKey,
          labelSnapshot,
          oddsSnapshot: pick.odds,
        });

        const updated = getParlay(p.parlayId);
        await interaction.reply({
          content: `✅ Added leg: [${market.type}] ${pick.label} (${fmtOdds(pick.odds)})`,
          embeds: [buildParlayPreviewEmbed(updated)],
        });
        return;
      }

      if (sub === "addprop") {
        const p = getBuildingParlay(interaction.user.id);
        if (!p) { await interaction.reply({ content: "Start first: `/parlay start`", ephemeral: true }); return; }

        if (p.legs.length >= 8) { await interaction.reply({ content: "❌ Max parlay size is 8 legs.", ephemeral: true }); return; }

        const player = interaction.options.getString("player", true);
        const stat = interaction.options.getString("stat", true);
        const playerKey = normalizeKey(player);
        const statUpper = String(stat).toUpperCase();

        const allMarkets = getAllMarkets();
        const candidates = allMarkets.filter((m) => {
          if (m.status !== "OPEN") return false;
          if (m.type !== "PROP") return false;
          if (!m.prop) return false;
          if (String(m.prop.stat || "").toUpperCase() !== statUpper) return false;
          return normalizeKey(m.prop.player) === playerKey;
        });

        if (candidates.length === 0) {
          await interaction.reply({ content: `❌ No OPEN ${statUpper} prop found for **${player}**.`, ephemeral: true });
          return;
        }
        if (candidates.length > 1) {
          await interaction.reply({ content: `⚠️ Multiple OPEN ${statUpper} props found for **${player}**.`, ephemeral: true });
          return;
        }

        const market = candidates[0];
        if (p.legs.some((l) => l.marketId === market.marketId)) {
          await interaction.reply({ content: "❌ You already added that prop.", ephemeral: true });
          return;
        }

        const pick = market.picks?.A;
        if (!pick) { await interaction.reply({ content: "❌ Prop market missing A pick.", ephemeral: true }); return; }

        addParlayLeg({
          parlayId: p.parlayId,
          marketId: market.marketId,
          marketType: "PROP",
          pick: "A",
          labelSnapshot: `${market.prop.player} ${market.prop.stat} — ${pick.label} (Line ${market.line})`,
          oddsSnapshot: pick.odds,
        });

        const updated = getParlay(p.parlayId);
        await interaction.reply({
          content: `✅ Added ${market.prop.stat} prop: ${market.prop.player} ${pick.label} (Line ${market.line}) (${fmtOdds(pick.odds)})`,
          embeds: [buildParlayPreviewEmbed(updated)],
        });
        return;
      }

      if (sub === "remove") {
        const p = getBuildingParlay(interaction.user.id);
        if (!p) { await interaction.reply({ content: "No parlay builder found. Use `/parlay start`.", ephemeral: true }); return; }

        const legNum = interaction.options.getInteger("leg", true);
        const idx = legNum - 1;

        if (idx < 0 || idx >= p.legs.length) {
          await interaction.reply({ content: "❌ Invalid leg number.", ephemeral: true });
          return;
        }

        const removed = p.legs[idx];
        removeParlayLeg(p.parlayId, idx);
        const updated = getParlay(p.parlayId);

        await interaction.reply({
          content: `🗑️ Removed leg ${legNum}: ${removed.labelSnapshot}`,
          embeds: [buildParlayPreviewEmbed(updated)],
        });
        return;
      }

      if (sub === "cancel") {
        const p = getBuildingParlay(interaction.user.id);
        if (!p) { await interaction.reply({ content: "No parlay builder to cancel.", ephemeral: true }); return; }
        deleteParlay(p.parlayId);
        await interaction.reply("🧹 Parlay builder cancelled.");
        return;
      }

      if (sub === "place") {
        const p = getBuildingParlay(interaction.user.id);
        if (!p) { await interaction.reply({ content: "No parlay builder found. Use `/parlay start`.", ephemeral: true }); return; }

        if (p.legs.length < 2) {
          await interaction.reply({ content: "❌ Parlays require at least 2 legs.", ephemeral: true });
          return;
        }

        const stake = interaction.options.getInteger("stake", true);
        if (stake > MAX_WAGER) {
          await interaction.reply({ content: `❌ Max wager is **${MAX_WAGER} ${CURRENCY}** per parlay.`, ephemeral: true });
          return;
        }

        const u = getUser(interaction.user.id);
        if (u.balance < stake) {
          await interaction.reply({ content: `❌ Insufficient funds. Balance: ${u.balance} ${CURRENCY}`, ephemeral: true });
          return;
        }

        for (const leg of p.legs) {
          const m = getMarket(leg.marketId);
          if (!m || m.status !== "OPEN") {
            await interaction.reply({ content: "❌ One or more legs are on a locked/unavailable market.", ephemeral: true });
            return;
          }
        }

        cleanupExpiredConfirms();

        const legsSnapshot = p.legs.map((leg) => {
          const m = getMarket(leg.marketId);
          const pick = m?.picks?.[leg.pick];
          return {
            marketId: leg.marketId,
            marketType: leg.marketType,
            pick: leg.pick,
            labelSnapshot: (leg.marketType === "PROP" || leg.marketType === "TEAMTOTAL")
              ? leg.labelSnapshot
              : pick.label,
            oddsSnapshot: pick.odds,
            result: "PENDING",
          };
        });

        const nonce = makeNonce();
        setPendingConfirm({
          nonce,
          userId: interaction.user.id,
          type: "parlay",
          payload: { parlayId: p.parlayId, stake, legsSnapshot },
          expiresAt: Date.now() + CONFIRM_TIMEOUT_MS,
        });

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

        await interaction.reply({ embeds: [preview], components: [buildConfirmRow(nonce)], ephemeral: true });
        return;
      }
    }

    await interaction.reply({ content: "Unknown command.", ephemeral: true });

  } catch (err) {
    logError("command handler", err, interaction);
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: "❌ Something went wrong. The error has been logged.", ephemeral: true });
      } else {
        await interaction.reply({ content: "❌ Something went wrong. The error has been logged.", ephemeral: true });
      }
    } catch { /* already replied */ }
  }
});

client.login(token);
