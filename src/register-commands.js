require("dotenv").config();
const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token) throw new Error("Missing DISCORD_TOKEN in .env");
if (!clientId) throw new Error("Missing CLIENT_ID in .env");
if (!guildId) throw new Error("Missing GUILD_ID in .env");

// -------------------- PUBLIC COMMANDS --------------------
const ping = new SlashCommandBuilder()
  .setName("ping")
  .setDescription("Test the bot");

const help = new SlashCommandBuilder()
  .setName("help")
  .setDescription("Show how to use the sportsbook bot");

const open = new SlashCommandBuilder()
  .setName("open")
  .setDescription("Show open slips and open parlays")
  .addUserOption((o) =>
    o
      .setName("user")
      .setDescription("Admin only: view another user's open tickets")
      .setRequired(false)
  );

const leaderboard = new SlashCommandBuilder()
  .setName("leaderboard")
  .setDescription("Show the top 5 bean bettors");

const history = new SlashCommandBuilder()
  .setName("history")
  .setDescription("View your bet history")
  .addSubcommand((sc) =>
    sc
      .setName("view")
      .setDescription("View bet history")
      .addUserOption((o) =>
        o.setName("user").setDescription("Admin: view another user").setRequired(false)
      )
  );

const bank = new SlashCommandBuilder()
  .setName("bank")
  .setDescription("Check balance")
  .addSubcommand((sc) =>
    sc
      .setName("balance")
      .setDescription("Check your balance")
      .addUserOption((o) =>
        o.setName("user").setDescription("Admin: check another user").setRequired(false)
      )
  );

const market = new SlashCommandBuilder()
  .setName("market")
  .setDescription("View current markets")
  .addSubcommand((sc) =>
    sc.setName("list").setDescription("Show current markets and odds")
  );

const bet = new SlashCommandBuilder()
  .setName("bet")
  .setDescription("Place a straight bet")
  .addSubcommand((sc) =>
    sc
      .setName("place")
      .setDescription("Place a straight bet on the open market of a type")
      .addStringOption((o) =>
        o
          .setName("type")
          .setDescription("Market type")
          .setRequired(true)
          .addChoices(
            { name: "ML", value: "ML" },
            { name: "SPREAD", value: "SPREAD" },
            { name: "TOTAL", value: "TOTAL" },
            { name: "TEAMTOTAL", value: "TEAMTOTAL" }
          )
      )
      .addIntegerOption((o) =>
        o.setName("stake").setDescription("Stake amount").setRequired(true).setMinValue(1)
      )
      .addStringOption((o) =>
        o
          .setName("pick")
          .setDescription("Pick A or B")
          .setRequired(true)
          .addChoices({ name: "A", value: "A" }, { name: "B", value: "B" })
      )
  );

const parlay = new SlashCommandBuilder()
  .setName("parlay")
  .setDescription("Build and place parlays")
  .addSubcommand((sc) => sc.setName("start").setDescription("Start a new parlay builder"))
  .addSubcommand((sc) =>
    sc
      .setName("addline")
      .setDescription("Add ML / SPREAD / TOTAL / TEAMTOTAL leg")
      .addStringOption((o) =>
        o
          .setName("type")
          .setDescription("Line type")
          .setRequired(true)
          .addChoices(
            { name: "ML", value: "ML" },
            { name: "SPREAD", value: "SPREAD" },
            { name: "TOTAL", value: "TOTAL" },
            { name: "TEAMTOTAL", value: "TEAMTOTAL" }
          )
      )
      .addStringOption((o) =>
        o
          .setName("pick")
          .setDescription("Pick A or B")
          .setRequired(true)
          .addChoices({ name: "A", value: "A" }, { name: "B", value: "B" })
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("addprop")
      .setDescription("Add a player prop leg (OVER only)")
      .addStringOption((o) =>
        o.setName("player").setDescription("Player name").setRequired(true)
      )
      .addStringOption((o) =>
        o
          .setName("stat")
          .setDescription("Prop stat")
          .setRequired(true)
          .addChoices(
            { name: "GOALS", value: "GOALS" },
            { name: "PENALTIES", value: "PENALTIES" }
          )
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("remove")
      .setDescription("Remove a leg by number (1,2,3...)")
      .addIntegerOption((o) =>
        o.setName("leg").setDescription("Leg number").setRequired(true).setMinValue(1)
      )
  )
  .addSubcommand((sc) => sc.setName("cancel").setDescription("Cancel your current parlay builder"))
  .addSubcommand((sc) =>
    sc
      .setName("place")
      .setDescription("Place the parlay (deduct stake + lock ticket)")
      .addIntegerOption((o) =>
        o.setName("stake").setDescription("Stake amount").setRequired(true).setMinValue(1)
      )
  );

// -------------------- BOOK / ADMIN COMMANDS --------------------

const bookmarket = new SlashCommandBuilder()
  .setName("bookmarket")
  .setDescription("Book tools: create/manage markets")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

  .addSubcommand((sc) =>
    sc
      .setName("create")
      .setDescription("Create a market")
      .addStringOption((o) =>
        o
          .setName("type")
          .setDescription("Market type")
          .setRequired(true)
          .addChoices(
            { name: "ML", value: "ML" },
            { name: "SPREAD", value: "SPREAD" },
            { name: "TOTAL", value: "TOTAL" },
            { name: "PROP", value: "PROP" },
            { name: "TEAMTOTAL", value: "TEAMTOTAL" }
          )
      )
      .addStringOption((o) => o.setName("title").setDescription("Market title").setRequired(true))
      .addNumberOption((o) => o.setName("line").setDescription("Line (spread/total/prop)"))
      .addStringOption((o) => o.setName("player").setDescription("PROP only: player name"))
      .addStringOption((o) =>
        o
          .setName("stat")
          .setDescription("PROP/TEAMTOTAL: stat type")
          .addChoices(
            { name: "GOALS", value: "GOALS" },
            { name: "PENALTIES", value: "PENALTIES" }
          )
      )
      .addStringOption((o) => o.setName("a_label").setDescription("Custom label for A side"))
      .addStringOption((o) => o.setName("b_label").setDescription("Custom label for B side"))
      .addIntegerOption((o) => o.setName("a_odds").setDescription("American odds for A (default -120)"))
      .addIntegerOption((o) => o.setName("b_odds").setDescription("American odds for B (default -120)"))
  )
  .addSubcommand((sc) =>
    sc
      .setName("lock")
      .setDescription("Lock a market (disable betting + freeze odds)")
      .addIntegerOption((o) => o.setName("market_id").setDescription("Market ID").setRequired(true))
  )
  .addSubcommand((sc) =>
    sc.setName("lockall").setDescription("Lock all OPEN markets (disable betting + freeze odds)")
  )
  .addSubcommand((sc) =>
    sc.setName("unlockall").setDescription("Unlock all LOCKED markets (allow betting again)")
  )
  .addSubcommand((sc) =>
    sc
      .setName("unlock")
      .setDescription("Unlock a market (allow betting)")
      .addIntegerOption((o) => o.setName("market_id").setDescription("Market ID").setRequired(true))
  )
  .addSubcommand((sc) =>
    sc
      .setName("odds")
      .setDescription("Freeze/unfreeze odds movement (betting still allowed if OPEN)")
      .addIntegerOption((o) => o.setName("market_id").setDescription("Market ID").setRequired(true))
      .addBooleanOption((o) =>
        o.setName("locked").setDescription("true = freeze, false = unfreeze").setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("nudge")
      .setDescription("Manually move odds")
      .addIntegerOption((o) => o.setName("market_id").setDescription("Market ID").setRequired(true))
      .addStringOption((o) =>
        o
          .setName("side")
          .setDescription("Side to hit")
          .setRequired(true)
          .addChoices({ name: "A", value: "A" }, { name: "B", value: "B" })
      )
      .addIntegerOption((o) => o.setName("steps").setDescription("Steps (default 1)"))
  )
  .addSubcommand((sc) =>
    sc
      .setName("settle")
      .setDescription("Settle a market (A/B/PUSH)")
      .addIntegerOption((o) => o.setName("market_id").setDescription("Market ID").setRequired(true))
      .addStringOption((o) =>
        o
          .setName("result")
          .setDescription("Result")
          .setRequired(true)
          .addChoices(
            { name: "A", value: "A" },
            { name: "B", value: "B" },
            { name: "PUSH", value: "PUSH" }
          )
      )
  )
  .addSubcommand((sc) =>
    sc.setName("risk").setDescription("Show operator risk dashboard — open exposure by market")
  );

const adminbank = new SlashCommandBuilder()
  .setName("adminbank")
  .setDescription("Admin: currency controls")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sc) =>
    sc
      .setName("give")
      .setDescription("Give currency to a user")
      .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
      .addIntegerOption((o) =>
        o.setName("amount").setDescription("Amount to give").setRequired(true).setMinValue(1)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("take")
      .setDescription("Deduct currency from a user")
      .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
      .addIntegerOption((o) =>
        o.setName("amount").setDescription("Amount to deduct").setRequired(true).setMinValue(1)
      )
  );

const adminhistory = new SlashCommandBuilder()
  .setName("adminhistory")
  .setDescription("Admin: history controls")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sc) =>
    sc
      .setName("clear")
      .setDescription("Clear a user's settled bet history")
      .addUserOption((o) => o.setName("user").setDescription("User to clear").setRequired(true))
  );

const book = new SlashCommandBuilder()
  .setName("book")
  .setDescription("Book operator tools")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sc) =>
    sc.setName("stats").setDescription("View overall settled stats / house net")
  );

// -------------------- Register --------------------
const commands = [
  ping, help, open, history, bank, market, bet, parlay, leaderboard,
  bookmarket, adminbank, adminhistory, book,
].map((c) => c.toJSON());

const rest = new REST({ version: "10" }).setToken(token);

(async () => {
  try {
    console.log("🔁 Registering slash commands...");
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log("✅ Slash commands registered.");
  } catch (err) {
    console.error("❌ Failed to register commands:", err);
  }
})();
