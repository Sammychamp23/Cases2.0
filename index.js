try { require("dotenv").config(); } catch (_) {}
const fs = require("fs");

const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  PermissionFlagsBits, ChannelType, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, MessageFlags, Partials,
} = require("discord.js");

const OpenAI = require("openai");
// Prefer Replit AI Integrations (no API key needed, billed to Replit credits)
// Falls back to standard OpenAI key if Replit AI env vars aren't present (e.g. on Railway)
const USE_REPLIT_AI = !!(process.env.AI_INTEGRATIONS_OPENAI_API_KEY && process.env.AI_INTEGRATIONS_OPENAI_BASE_URL);
const openai = USE_REPLIT_AI
  ? new OpenAI({
      apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
    })
  : (process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null);
const AI_MODEL = "gpt-4o-mini";
console.log(`[AI] Using ${USE_REPLIT_AI ? "Replit AI Integrations" : (openai ? "direct OpenAI" : "DISABLED — no API key")} (model: ${openai ? AI_MODEL : "n/a"})`);

// Per-user AI conversation history (kept for 30 minutes of inactivity)
const aiHistory   = new Map(); // userId -> { messages: [{role,content}], lastTs: number }
const AI_HISTORY_TTL  = 30 * 60 * 1000; // 30 minutes
const AI_HISTORY_MAX  = 12; // max messages kept (6 pairs)

process.on("unhandledRejection", (err) => {
  if (err?.code === 10062) return; // Unknown interaction — dual-instance race, safe to ignore
  console.error("Unhandled rejection:", err.message);
});
process.on("uncaughtException", (err) => {
  if (err?.code === 10062) return; // Unknown interaction — dual-instance race, safe to ignore
  console.error("Uncaught exception:", err.message);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildPresences,
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.Channel],
});

// ── Commands ───────────────────────────────────────────────────────────────────

const commands = [
  // Utility
  new SlashCommandBuilder().setName("ticket").setDescription("🎫 Open a support ticket"),

  // Economy
  new SlashCommandBuilder().setName("balance").setDescription("💵 Check your coin balance"),
  new SlashCommandBuilder().setName("daily").setDescription("🎁 Claim your daily coin reward"),
  new SlashCommandBuilder().setName("weekly").setDescription("📅 Claim your weekly coin reward"),

  // Shop
  new SlashCommandBuilder().setName("shop").setDescription("🛒 Browse the coin shop"),
  new SlashCommandBuilder().setName("buy").setDescription("🛍️ Buy an item from the shop")
    .addStringOption((o) => o.setName("item").setDescription("Item ID to buy (from /shop)").setRequired(true)),
  new SlashCommandBuilder().setName("inventory").setDescription("🎒 View your owned items"),
  new SlashCommandBuilder().setName("equip").setDescription("✨ Equip a role item from your inventory")
    .addStringOption((o) => o.setName("item").setDescription("Item ID to equip (from /inventory)").setRequired(true)),

  // Achievements
  new SlashCommandBuilder().setName("achievements").setDescription("🏆 View your achievement progress"),

  // XP
  new SlashCommandBuilder().setName("rank").setDescription("📊 Check your XP rank")
    .addUserOption((o) => o.setName("user").setDescription("User to check (defaults to you)")),
  new SlashCommandBuilder().setName("leaderboard").setDescription("🏅 View the top 10 XP leaderboard"),

  // Stats
  new SlashCommandBuilder().setName("serverstats").setDescription("📈 View server statistics"),
  new SlashCommandBuilder().setName("activity").setDescription("⚡ View a user's activity stats")
    .addUserOption((o) => o.setName("user").setDescription("User to check (defaults to you)")),
  new SlashCommandBuilder().setName("invites").setDescription("🔗 Check how many users you've invited"),

  // Challenges
  new SlashCommandBuilder().setName("challenges").setDescription("🎯 View your daily challenge progress"),

  // Moderation
  new SlashCommandBuilder().setName("resetlives").setDescription("❤️ Reset a member's lives back to 5 (Head Mod only)")
    .addUserOption((o) => o.setName("user").setDescription("The user to reset").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName("warn").setDescription("⚠️ Warn a member")
    .addUserOption((o) => o.setName("user").setDescription("The user to warn").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName("mute").setDescription("🔇 Timeout a member")
    .addUserOption((o) => o.setName("user").setDescription("The user to mute").setRequired(true))
    .addIntegerOption((o) => o.setName("duration").setDescription("Duration in minutes").setRequired(true).setMinValue(1).setMaxValue(40320))
    .addStringOption((o) => o.setName("reason").setDescription("Reason"))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName("kick").setDescription("👢 Kick a member")
    .addUserOption((o) => o.setName("user").setDescription("The user to kick").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason"))
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
  new SlashCommandBuilder().setName("ban").setDescription("🔨 Ban a member")
    .addUserOption((o) => o.setName("user").setDescription("The user to ban").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason"))
    .addStringOption((o) => o.setName("duration").setDescription("Ban duration (leave empty for permanent)")
      .addChoices(
        { name: "1 hour",   value: "1h"  },
        { name: "6 hours",  value: "6h"  },
        { name: "12 hours", value: "12h" },
        { name: "1 day",    value: "1d"  },
        { name: "3 days",   value: "3d"  },
        { name: "1 week",   value: "1w"  },
        { name: "2 weeks",  value: "2w"  },
        { name: "4 weeks",  value: "4w"  },
      ))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  new SlashCommandBuilder().setName("toggle-updates").setDescription("🔔 Enable or disable automatic game update announcements")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // Events
  new SlashCommandBuilder().setName("giveaway").setDescription("🎊 Start a giveaway")
    .addStringOption((o) => o.setName("prize").setDescription("What are you giving away?").setRequired(true))
    .addIntegerOption((o) => o.setName("duration").setDescription("Duration in minutes").setRequired(true).setMinValue(1).setMaxValue(10080))
    .addIntegerOption((o) => o.setName("winners").setDescription("Number of winners (default 1)").setMinValue(1).setMaxValue(10))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // Sessions
  new SlashCommandBuilder().setName("session-start").setDescription("🎮 Start a gaming session")
    .addStringOption((o) => o.setName("name").setDescription("Session name").setRequired(true))
    .addStringOption((o) => o.setName("description").setDescription("What are you playing?"))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // Admin
  new SlashCommandBuilder().setName("boost").setDescription("⚡ Activate 2x XP & coins for everyone for 30 minutes")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("lock").setDescription("🔒 Lock a channel so members cannot send messages (head mods & owner only)")
    .addChannelOption((o) => o.setName("channel").setDescription("Channel to lock (defaults to current)"))
    .addStringOption((o) => o.setName("reason").setDescription("Reason for the lock"))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("unlock").setDescription("🔓 Unlock a previously locked channel")
    .addChannelOption((o) => o.setName("channel").setDescription("Channel to unlock (defaults to current)"))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("forcelock").setDescription("🔐 Force-lock a channel, overriding all role permissions (admin only)")
    .addChannelOption((o) => o.setName("channel").setDescription("Channel to force-lock (defaults to current)"))
    .addStringOption((o) => o.setName("reason").setDescription("Reason for the force-lock"))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("forceopen").setDescription("🔓 Force-open a channel, resetting all send permissions to default (admin only)")
    .addChannelOption((o) => o.setName("channel").setDescription("Channel to force-open (defaults to current)"))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("setup-server").setDescription("⚙️ Set up channels & categories — creates missing ones, renames & updates topics on existing")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("rules-agree").setDescription("📋 Post the rules agreement panel — members click I Agree to unlock the server")
    .addChannelOption((o) => o.setName("channel").setDescription("Channel to post in (defaults to current channel)").addChannelTypes(ChannelType.GuildText))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("cleanup-dupes").setDescription("🗑️ Delete duplicate channels created by a previous setup-server run")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("sync-permissions").setDescription("🔧 Apply correct read-only permissions to all existing channels")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("test-update").setDescription("📢 Send a test game update announcement")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("organize_server").setDescription("🔧 Auto-organise uncategorised channels and fix permissions")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("silence").setDescription("🤫 Toggle the bot's automated chat messages on/off (drop zones, surprise drops, hints, AI replies)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("exclude-2x").setDescription("🚫 Exclude or re-include a channel from being chosen for 2x XP/coin drop zone events")
    .addChannelOption((o) => o.setName("channel").setDescription("Channel to toggle exclusion for (defaults to current)"))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("post-verification").setDescription("🔐 Post (or refresh) the verification embed in the verification channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("post-rules").setDescription("📖 Post (or refresh) the rules embed in the rules-must-read channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("refresh-embeds").setDescription("🔄 Refresh & pin guide messages in ALL channels (welcome, rules, shop, rewards, commands, etc.)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("change-log-channel").setDescription("📋 Change which channel mod & event logs are sent to")
    .addChannelOption((o) => o.setName("channel").setDescription("Channel to send logs to (omit to reset to auto-detect)").addChannelTypes(ChannelType.GuildText))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("give-coins").setDescription("💰 [Head Admin] Give any amount of coins to yourself or another member")
    .addIntegerOption((o) => o.setName("amount").setDescription("Number of coins to give").setRequired(true).setMinValue(1))
    .addUserOption((o) => o.setName("user").setDescription("Member to give coins to (omit to give to yourself)").setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("remove-coins").setDescription("💸 [Head Admin] Remove any amount of coins from yourself or another member")
    .addIntegerOption((o) => o.setName("amount").setDescription("Number of coins to remove").setRequired(true).setMinValue(1))
    .addUserOption((o) => o.setName("user").setDescription("Member to remove coins from (omit for yourself)").setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("setcoins").setDescription("💰 [Head Admin] Set a user's exact coin balance")
    .addIntegerOption((o) => o.setName("amount").setDescription("New coin balance").setRequired(true).setMinValue(0))
    .addUserOption((o) => o.setName("user").setDescription("Target user (omit for yourself)"))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("givexp").setDescription("⭐ [Head Admin] Give XP to a user")
    .addIntegerOption((o) => o.setName("amount").setDescription("XP to give").setRequired(true).setMinValue(1))
    .addUserOption((o) => o.setName("user").setDescription("Target user (omit for yourself)"))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("removexp").setDescription("⭐ [Head Admin] Remove XP from a user")
    .addIntegerOption((o) => o.setName("amount").setDescription("XP to remove").setRequired(true).setMinValue(1))
    .addUserOption((o) => o.setName("user").setDescription("Target user (omit for yourself)"))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("setxp").setDescription("⭐ [Head Admin] Set a user's exact XP")
    .addIntegerOption((o) => o.setName("amount").setDescription("New XP value").setRequired(true).setMinValue(0))
    .addUserOption((o) => o.setName("user").setDescription("Target user (omit for yourself)"))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("resetxp").setDescription("⭐ [Head Admin] Reset a user's XP and level to zero")
    .addUserOption((o) => o.setName("user").setDescription("Target user (omit for yourself)"))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("pay").setDescription("💸 Transfer coins from your balance to another member")
    .addUserOption((o) => o.setName("user").setDescription("Member to pay").setRequired(true))
    .addIntegerOption((o) => o.setName("amount").setDescription("Amount of coins to send").setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName("streak").setDescription("🔥 View your current daily login streak and next reward"),
  new SlashCommandBuilder().setName("achievementprogress").setDescription("📊 See detailed progress toward every achievement"),
  new SlashCommandBuilder().setName("achievementleaderboard").setDescription("🏆 See who has the most achievements in this server"),
  new SlashCommandBuilder().setName("equip-all").setDescription("✨ Equip all role items from your inventory at once"),
  new SlashCommandBuilder().setName("buyall").setDescription("🛒 Buy all shop items you don't already own (shows cost & confirmation first)"),
  new SlashCommandBuilder().setName("joke").setDescription("😂 Get a random joke"),
  new SlashCommandBuilder().setName("8ball").setDescription("🎱 Ask the magic 8 ball a question")
    .addStringOption((o) => o.setName("question").setDescription("Your question for the 8 ball").setRequired(true)),
  new SlashCommandBuilder().setName("rps").setDescription("✂️ Play Rock Paper Scissors against the bot"),
  new SlashCommandBuilder().setName("roast").setDescription("🔥 Roast a member (lighthearted only!)")
    .addUserOption((o) => o.setName("user").setDescription("Member to roast").setRequired(true)),
  new SlashCommandBuilder().setName("hug").setDescription("🤗 Send a hug to a member")
    .addUserOption((o) => o.setName("user").setDescription("Member to hug").setRequired(true)),
  new SlashCommandBuilder().setName("coinflip").setDescription("🪙 Flip a coin — heads or tails?"),
  new SlashCommandBuilder().setName("trivia").setDescription("🧠 Answer a trivia question and win coins!"),
  new SlashCommandBuilder().setName("setupchannel").setDescription("📋 Post a channel info embed + ping role panel in this channel (safe — skips if already set up)"),
  new SlashCommandBuilder().setName("report").setDescription("🚨 Anonymously report a member to staff")
    .addUserOption((o) => o.setName("user").setDescription("The member you want to report").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Why are you reporting this member?").setRequired(true))
    .addStringOption((o) => o.setName("evidence").setDescription("Screenshot URL or extra details (optional)")),
].map((cmd) => cmd.toJSON());

// ── Command → required channel ─────────────────────────────────────────────────

const CMD_CHANNEL = {
  balance: "bot-commands", daily: "bot-commands", weekly: "bot-commands",
  rank: "bot-commands", leaderboard: "bot-commands", serverstats: "bot-commands",
  activity: "bot-commands", invites: "bot-commands", challenges: "bot-commands",
  shop: "bot-commands", buy: "bot-commands", buyall: "bot-commands",
  inventory: "bot-commands", equip: "bot-commands", achievements: "bot-commands",
  joke: "bot-commands", "8ball": "bot-commands", rps: "bot-commands",
  roast: "bot-commands", hug: "bot-commands", coinflip: "bot-commands", trivia: "bot-commands",
  "equip-all": "bot-commands", pay: "bot-commands", streak: "bot-commands",
  achievementprogress: "bot-commands", achievementleaderboard: "bot-commands",
  setcoins: "admin-commands", givexp: "admin-commands", removexp: "admin-commands",
  setxp: "admin-commands", resetxp: "admin-commands",
  warn: "admin-commands", mute: "admin-commands", kick: "admin-commands", ban: "admin-commands",
};

// ── In-memory stores ──────────────────────────────────────────────────────────

const coins          = new Map(); // userId -> number
const xpStore        = new Map(); // userId -> { xp, level }
const warnings       = new Map(); // userId -> [{reason, ts, mod}]
const msgCount       = new Map(); // userId -> number
const voiceJoined    = new Map(); // userId -> joinTimestamp
const lastMsgXP      = new Map(); // userId -> timestamp
const lastMsgCoin    = new Map(); // userId -> timestamp
const lastDaily      = new Map(); // userId -> timestamp
const lastWeekly     = new Map(); // userId -> timestamp
const inviteCache    = new Map(); // guildId -> Map<code, uses>
const inviteBy       = new Map(); // inviteeId -> inviterId
const inviteCount    = new Map(); // inviterId -> number
const giveaways      = new Map(); // messageId -> giveaway data
const sessions       = new Map(); // messageId -> session data
const tempVoiceChans  = new Set(); // temp VC channel IDs
const spamTracker     = new Map(); // userId -> [timestamps]
const lockedChannels  = new Map(); // channelId -> { prevOverwrites, reason }
const lives           = new Map(); // userId -> number (default 5, lose 1 per spam offense)
const kickedUsers     = new Set(); // userIds auto-kicked for 0 lives (next offense = ban)
const recentJoins     = [];        // join timestamps for raid detection
let   raidLocked      = false;     // true while server is in raid-lockdown
const setupChannels   = new Set(); // channelIds configured via /setupchannel (persisted)

// ── Permission bit mask used by lock/raid systems ──────────────────────────────
const LOCK_BITS = PermissionFlagsBits.SendMessages | PermissionFlagsBits.CreatePublicThreads | PermissionFlagsBits.SendMessagesInThreads;

// ── Channels that must NEVER be locked (members must be able to verify/ticket) ─
const SAFE_CHANNEL_KEYWORDS = ["verify", "verification", "ticket", "create-ticket", "welcome", "goodbye", "rules", "info", "announcement"];
function isSafeChannel(ch) {
  const n = ch.name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SAFE_CHANNEL_KEYWORDS.some(k => n.includes(k.replace(/-/g, "")));
}

// ── Life system helpers ────────────────────────────────────────────────────────
const MAX_LIVES = 5;
function getLives(userId) { return lives.has(userId) ? lives.get(userId) : MAX_LIVES; }
function setLives(userId, n) { lives.set(userId, Math.max(0, n)); }

// ── NEW: Adaptive & Smart Systems stores ──────────────────────────────────────

const lastSeen          = new Map(); // userId -> timestamp (for welcome-back detection)
const userProfiles      = new Map(); // userId -> { msgs, voiceMins, social, grinder, lurker }
const dailyChallenges   = new Map(); // userId -> { msgs, voiceMinutes, sessionJoin, done, lastReset }
const rewardDropZones   = new Map(); // channelId -> expiresAt (boosted channels)
const serverBoost       = { active: false, multiplier: 2, expiresAt: 0 }; // server-wide XP boost
const recentActivity    = []; // rolling window of message timestamps for activity sensing
const voiceEngageBonus  = new Map(); // userId -> lastBonusTs (3+ VC members bonus)

// ── Shop & Achievement stores ──────────────────────────────────────────────────

const userInventory     = new Map(); // userId -> Map<itemId, { quantity, acquiredAt }>
const userBoosts        = new Map(); // userId -> { xpBoost: expiresAt, coinBoost: expiresAt }
const shopStock         = new Map(); // itemId -> current stock (overrides catalog default)
const lastPurchase      = new Map(); // `${userId}:${itemId}` -> timestamp (purchase cooldown)
const achievementData   = new Map(); // userId -> { [achievementId]: { progress, earned } }
const loginStreak       = new Map(); // userId -> { lastDate: YYYY-MM-DD, streak: number }
const dailyRotation     = { date: "", items: [] }; // today's featured shop items

// Popular-item tracking: how many times each item has been purchased
const itemPopularity    = new Map(); // itemId -> purchase count

// ── Fun command stores ─────────────────────────────────────────────────────────
const funCooldowns      = new Map(); // `${userId}:${cmd}` -> timestamp
const triviaActive      = new Map(); // userId -> { correct, expiresAt, reward }
const buyallPending     = new Map(); // userId -> { items, total, expiresAt }

const verificationProcessing = new Set(); // loop guard: userId being processed for verify role switch

const BOOST_DURATION_MS  = 30 * 60 * 1000; // 30 min server boost
const DROP_ZONE_DURATION = () => (10 + Math.floor(Math.random() * 21)) * 60 * 1000; // 10–30 min
const WELCOME_BACK_DAYS  = 3; // days of absence before welcome-back bonus

// ── Level helpers ─────────────────────────────────────────────────────────────

const LEVEL_ROLES = { 5: "Active", 10: "Regular", 20: "Veteran", 50: "Elite" };

function getLevel(xp)    { return Math.floor(xp / 200); }
function xpForLevel(lvl) { return lvl * 200; }
function getXP(userId)   { return xpStore.get(userId) ?? { xp: 0, level: 0 }; }
function getCoins(userId){ return coins.get(userId) ?? 0; }

// Current reward multiplier (server boost + drop zone + user personal boost)
function getMultiplier(channelId, userId = null, type = "both") {
  const now = Date.now();
  let mult = 1;
  if (serverBoost.active && now < serverBoost.expiresAt) mult *= serverBoost.multiplier;
  if (channelId && rewardDropZones.has(channelId) && now < rewardDropZones.get(channelId)) mult *= 2;
  // Low activity bonus: if fewer than 5 messages in last 10 minutes, 1.5x
  const recent = recentActivity.filter((t) => now - t < 10 * 60 * 1000).length;
  if (recent < 5 && mult === 1) mult = 1.5;
  // Per-user personal boosts
  if (userId) {
    const { xpMult, coinMult } = getUserBoostMult(userId);
    if (type === "xp")   mult *= xpMult;
    if (type === "coin") mult *= coinMult;
    if (type === "both") mult *= Math.max(xpMult, coinMult);
  }
  return mult;
}

async function addXP(member, amount, channelId) {
  const mult = getMultiplier(channelId, member.id, "xp");
  const final = Math.round(amount * mult);
  const data = getXP(member.id);
  data.xp += final;
  const newLevel = getLevel(data.xp);
  const leveled = newLevel > data.level;
  data.level = newLevel;
  xpStore.set(member.id, data);
  if (leveled) await handleLevelUp(member, newLevel);
  return final;
}

function addCoins(userId, amount, channelId) {
  const mult = getMultiplier(channelId, userId, "coin");
  const final = Math.round(amount * mult);
  const newTotal = getCoins(userId) + final;
  coins.set(userId, newTotal);
  return final;
}

// ── Economy action logger ──────────────────────────────────────────────────────
async function logEconomyAction(guild, executor, targetUser, action, amount) {
  const ch = findChannel(guild, "economy-log") ?? findChannel(guild, "admin-log");
  if (!ch) return;
  const embed = new EmbedBuilder()
    .setTitle("📋 Economy Action Log")
    .addFields(
      { name: "Executor", value: `${executor.user?.tag ?? executor.tag} (${executor.id})`, inline: true },
      { name: "Target",   value: `${targetUser.tag ?? targetUser.username} (${targetUser.id})`, inline: true },
      { name: "Action",   value: action, inline: true },
      { name: "Amount",   value: String(amount),                                             inline: true },
    )
    .setColor(0xfee75c)
    .setTimestamp();
  ch.send({ embeds: [embed] }).catch(() => {});
}

async function handleLevelUp(member, newLevel) {
  const guild = member.guild;

  // Award ALL level roles earned up to newLevel (catches skipped milestones on big XP jumps)
  const newRoles = [];
  for (const [threshold, roleName] of Object.entries(LEVEL_ROLES)) {
    if (Number(threshold) <= newLevel) {
      let role = guild.roles.cache.find((r) => r.name === roleName);
      if (!role) {
        try { role = await guild.roles.create({ name: roleName, reason: "Level reward" }); } catch { /* ignore */ }
      }
      if (role && !member.roles.cache.has(role.id)) {
        try { await member.roles.add(role); newRoles.push(roleName); } catch { /* ignore */ }
      }
    }
  }

  const ch = findChannel(guild, "bot-commands");
  if (ch) {
    const roleText = newRoles.length ? ` You've earned: **${newRoles.join(", ")}**!` : "";
    const embed = new EmbedBuilder()
      .setTitle("🎉 Level Up!")
      .setDescription(`${member} reached **Level ${newLevel}**!${roleText}\n\nCheck your progress with \`/rank\``)
      .setColor(0xfee75c)
      .setThumbnail(member.user.displayAvatarURL())
      .setTimestamp();
    ch.send({ embeds: [embed] }).catch(() => {});
  }
}

// ── Challenge helpers ─────────────────────────────────────────────────────────

const CHALLENGE_GOALS = { msgs: 20, voiceMinutes: 15, sessionJoin: 1 };
const CHALLENGE_REWARD = { coins: 300, xp: 100 };

function getChallenge(userId) {
  const now = Date.now();
  let c = dailyChallenges.get(userId);
  // Reset if it's a new day
  if (!c || now - c.lastReset > 24 * 60 * 60 * 1000) {
    c = { msgs: 0, voiceMinutes: 0, sessionJoin: 0, done: false, lastReset: now };
    dailyChallenges.set(userId, c);
  }
  return c;
}

function updateChallenge(userId, field, amount = 1) {
  const c = getChallenge(userId);
  if (c.done) return false;
  c[field] = Math.min((c[field] ?? 0) + amount, CHALLENGE_GOALS[field]);
  dailyChallenges.set(userId, c);
  const complete = Object.keys(CHALLENGE_GOALS).every((k) => (c[k] ?? 0) >= CHALLENGE_GOALS[k]);
  if (complete && !c.done) { c.done = true; return true; }
  return false;
}

// ── Shop catalog ──────────────────────────────────────────────────────────────

const SHOP_CATALOG = [
  // ── Common ───────────────────────────────────────────────────────────────────
  { id: "chatter",      name: "Chatter",          rarity: "Common",    price: 500,   stock: 999, effect: "Cosmetic role — shows you're an active chatter.",         type: "role",  roleName: "Chatter",     restockAmt: 999,   cooldownH: 0  },
  { id: "lucky_coin",   name: "Lucky Coin Boost",  rarity: "Common",    price: 600,   stock: 999, effect: "+100 bonus coins on your next /daily claim.",             type: "boost", boostType: "lucky",      restockAmt: 999,   cooldownH: 1  },
  { id: "xp_surge_s",  name: "XP Surge (30min)",  rarity: "Common",    price: 750,   stock: 999, effect: "2× XP for 30 minutes.",                                   type: "boost", boostType: "xp",  boostMs: 30*60*1000,  restockAmt: 999, cooldownH: 1 },

  // ── Rare ─────────────────────────────────────────────────────────────────────
  { id: "coin_magnet_s",name: "Coin Magnet (30min)",rarity: "Rare",     price: 1200,  stock: 200, effect: "2× coins from chat & voice for 30 minutes.",              type: "boost", boostType: "coin", boostMs: 30*60*1000, restockAmt: 200, cooldownH: 2 },
  { id: "regular_plus", name: "Regular+",           rarity: "Rare",     price: 2500,  stock: 100, effect: "Cosmetic rank-up role — flex your grind.",                type: "role",  roleName: "Regular+",    restockAmt: 100,   cooldownH: 0  },
  { id: "xp_surge_m",  name: "XP Surge (1hr)",     rarity: "Rare",     price: 2000,  stock: 100, effect: "2× XP for 1 hour.",                                       type: "boost", boostType: "xp",  boostMs: 60*60*1000,  restockAmt: 100, cooldownH: 2 },

  // ── Epic ─────────────────────────────────────────────────────────────────────
  { id: "coin_magnet_m",name: "Coin Magnet (2hr)",  rarity: "Epic",     price: 4000,  stock: 50,  effect: "2× coins from chat & voice for 2 hours.",                 type: "boost", boostType: "coin", boostMs: 2*60*60*1000, restockAmt: 50, cooldownH: 4 },
  { id: "veteran_plus", name: "Veteran+",            rarity: "Epic",     price: 7500,  stock: 30,  effect: "Elite cosmetic role — only for the dedicated.",           type: "role",  roleName: "Veteran+",    restockAmt: 30,    cooldownH: 0  },
  { id: "xp_surge_l",  name: "XP Surge (3hr)",      rarity: "Epic",     price: 5000,  stock: 30,  effect: "2× XP for 3 hours.",                                      type: "boost", boostType: "xp",  boostMs: 3*60*60*1000, restockAmt: 30, cooldownH: 6 },

  // ── Legendary ────────────────────────────────────────────────────────────────
  { id: "server_legend",name: "Server Legend",      rarity: "Legendary", price: 25000, stock: 10,  effect: "Ultra-rare title role — only 10 exist. Flex forever.",    type: "role",  roleName: "Server Legend", restockAmt: 10,  cooldownH: 0  },
  { id: "mega_boost",  name: "Mega Boost (1hr)",    rarity: "Legendary", price: 15000, stock: 5,   effect: "3× XP AND 3× coins for 1 hour.",                          type: "boost", boostType: "mega", boostMs: 60*60*1000, restockAmt: 5, cooldownH: 24 },
  { id: "elite_plus",  name: "Elite+",              rarity: "Legendary", price: 30000, stock: 5,   effect: "The rarest cosmetic role in the server.",                  type: "role",  roleName: "Elite+",      restockAmt: 5,    cooldownH: 0  },
];

const RARITY_EMOJI  = { Common: "🟢", Rare: "🔵", Epic: "🟣", Legendary: "🔴" };
const RARITY_COLOR  = { Common: 0x57f287, Rare: 0x5865f2, Epic: 0xab47bc, Legendary: 0xff7043 };

function getStock(itemId) {
  const cat = SHOP_CATALOG.find((i) => i.id === itemId);
  if (!cat) return 0;
  return shopStock.has(itemId) ? shopStock.get(itemId) : cat.stock;
}

function getItemPrice(item) {
  // Slightly inflate price (+0-10%) for very popular items (demand-based pricing)
  const popularity = itemPopularity.get(item.id) ?? 0;
  const bump = popularity > 50 ? 1.1 : popularity > 20 ? 1.05 : 1;
  return Math.round(item.price * bump);
}

function getUserInventory(userId) {
  if (!userInventory.has(userId)) userInventory.set(userId, new Map());
  return userInventory.get(userId);
}

function getUserBoosts(userId) {
  if (!userBoosts.has(userId)) userBoosts.set(userId, {});
  return userBoosts.get(userId);
}

function hasActiveBoost(userId, type) {
  const boosts = getUserBoosts(userId);
  return boosts[type] && Date.now() < boosts[type];
}

// Returns combined multiplier for a user (stacks with server boost / drop zone)
function getUserBoostMult(userId) {
  const boosts = getUserBoosts(userId);
  const now = Date.now();
  let xpMult  = 1, coinMult = 1;
  if (boosts.xp   && now < boosts.xp)   xpMult   *= 2;
  if (boosts.coin && now < boosts.coin)  coinMult  *= 2;
  if (boosts.mega && now < boosts.mega)  { xpMult *= 3; coinMult *= 3; }
  return { xpMult, coinMult };
}

// ── Fun command content ────────────────────────────────────────────────────────

const JOKES = [
  "Why don't scientists trust atoms? Because they make up everything!",
  "I told my wife she was drawing her eyebrows too high. She looked surprised.",
  "Why can't you give Elsa a balloon? Because she'll let it go.",
  "What do you call a factory that makes okay products? A satisfactory.",
  "I used to hate facial hair, but then it grew on me.",
  "Why did the scarecrow win an award? He was outstanding in his field.",
  "I'm on a seafood diet. I see food and I eat it.",
  "What do you call a sleeping dinosaur? A dino-snore.",
  "Why do cows wear bells? Because their horns don't work.",
  "I told a joke about construction. I'm still working on it.",
  "What's brown and sticky? A stick.",
  "Why don't eggs tell jokes? They'd crack each other up.",
  "I asked the librarian for books about paranoia. She whispered: 'They're right behind you!'",
  "Why did the math book look so sad? It had too many problems.",
  "What do you call cheese that isn't yours? Nacho cheese.",
  "Why did the bicycle fall over? It was two-tired.",
  "I would tell a pizza joke but it's too cheesy.",
  "What do you call a man with a rubber toe? Roberto.",
  "Why did the golfer bring extra pants? In case he got a hole in one.",
  "I told my doctor I broke my arm in two places. He told me to stop going to those places.",
];

const EIGHTBALL = [
  "It is certain.", "It is decidedly so.", "Without a doubt.", "Yes, definitely.",
  "You may rely on it.", "As I see it, yes.", "Most likely.", "Outlook good.",
  "Signs point to yes.", "Yes.", "Reply hazy, try again.", "Ask again later.",
  "Better not tell you now.", "Cannot predict now.", "Concentrate and ask again.",
  "Don't count on it.", "My reply is no.", "My sources say no.",
  "Outlook not so good.", "Very doubtful.",
];

const ROASTS = [
  "You're not stupid — you just have bad luck thinking.",
  "I'd agree with you but then we'd both be wrong.",
  "If laughter is the best medicine, your face must be curing diseases.",
  "You bring everyone so much joy... when you leave the room.",
  "I'd explain it to you, but I left my crayons at home.",
  "You're like a cloud. When you disappear, it's a beautiful day.",
  "Your secrets are safe with me. I never even listen when you tell me them.",
  "I'd roast you harder but my mum said I'm not allowed to burn trash.",
  "You're not the dumbest person alive, but you better hope they don't die.",
  "If you were any more basic, you'd be pH 14.",
  "I'd say you're funny but I don't want to give you any ideas.",
  "Your WiFi password is probably 'password'.",
  "You must have been born on a highway — that's where most accidents happen.",
  "I'm not insulting you. I'm describing you.",
  "You're the human equivalent of a participation trophy.",
  "If laziness was a sport, you'd still come last — you wouldn't show up.",
  "You're not even wrong, you're just confidently incorrect.",
  "You have your whole life to be like this. Why not take today off?",
  "I've met smarter ideas in a fortune cookie.",
  "You're proof that even WiFi drops at the worst moments.",
];

const HUG_MSGS = [
  "wraps you in the warmest, fluffiest hug imaginable 🤗",
  "comes running from across the room just to squeeze you tight 💛",
  "gives you a big bear hug and won't let go 🐻",
  "sneaks up behind you and hugs you out of nowhere! 💖",
  "tackle-hugs you so hard you almost fall over 😂💕",
  "gives you the kind of hug that makes everything better ✨",
  "hugs you so tight the world feels okay again 🌸",
  "wraps you in a hug full of good vibes and great energy 💫",
  "gives you a super mega ultra hug 🎁",
  "holds on tight and whispers 'you're awesome' 🌟",
];

const TRIVIA_QUESTIONS = [
  { q: "What is the capital of France?",              choices: ["Berlin", "Paris", "Madrid"],              answer: 1, reward: 50 },
  { q: "How many sides does a hexagon have?",          choices: ["5", "6", "7"],                           answer: 1, reward: 50 },
  { q: "What planet is closest to the Sun?",           choices: ["Venus", "Earth", "Mercury"],             answer: 2, reward: 75 },
  { q: "What is 7 × 8?",                              choices: ["54", "56", "58"],                         answer: 1, reward: 50 },
  { q: "What gas do plants absorb from the air?",      choices: ["Oxygen", "Nitrogen", "Carbon Dioxide"],  answer: 2, reward: 75 },
  { q: "Who painted the Mona Lisa?",                   choices: ["Van Gogh", "Da Vinci", "Picasso"],        answer: 1, reward: 100 },
  { q: "What is the largest ocean on Earth?",          choices: ["Atlantic", "Indian", "Pacific"],          answer: 2, reward: 75 },
  { q: "How many continents are there?",               choices: ["6", "7", "8"],                           answer: 1, reward: 50 },
  { q: "What is the approximate speed of light?",      choices: ["300,000 km/s", "150,000 km/s", "3,000 km/s"], answer: 0, reward: 100 },
  { q: "Which element has the symbol 'Au'?",           choices: ["Silver", "Copper", "Gold"],              answer: 2, reward: 100 },
  { q: "In what year did World War II end?",            choices: ["1943", "1944", "1945"],                  answer: 2, reward: 100 },
  { q: "What is the tallest mountain in the world?",    choices: ["K2", "Mount Everest", "Kangchenjunga"],  answer: 1, reward: 75 },
  { q: "How many strings does a standard guitar have?", choices: ["4", "5", "6"],                          answer: 2, reward: 50 },
  { q: "What is the chemical formula for water?",       choices: ["H2O", "CO2", "NaCl"],                   answer: 0, reward: 50 },
  { q: "Which country invented pizza?",                 choices: ["USA", "Italy", "Greece"],                answer: 1, reward: 75 },
  { q: "What is the hardest natural substance?",        choices: ["Iron", "Diamond", "Titanium"],           answer: 1, reward: 100 },
  { q: "How many bones are in the adult human body?",   choices: ["186", "196", "206"],                    answer: 2, reward: 100 },
  { q: "Which planet has the most moons?",              choices: ["Jupiter", "Saturn", "Uranus"],           answer: 1, reward: 100 },
  { q: "What is the smallest prime number?",            choices: ["1", "2", "3"],                          answer: 1, reward: 75 },
  { q: "What language has the most native speakers?",   choices: ["English", "Spanish", "Mandarin"],       answer: 2, reward: 75 },
];

const FUN_COOLDOWN_MS = 30 * 1000; // 30s between fun commands

// ── Persistence (JSON file autosave) ──────────────────────────────────────────

const PERSIST_FILE = "./botdata.json";

function serializeMap(map) {
  const out = {};
  for (const [k, v] of map.entries()) {
    out[k] = v instanceof Map ? { __map: true, entries: [...v.entries()] } : v;
  }
  return out;
}

function deserializeMap(obj) {
  const map = new Map();
  for (const [k, v] of Object.entries(obj ?? {})) {
    map.set(k, v && v.__map ? new Map(v.entries) : v);
  }
  return map;
}

function saveData() {
  try {
    const payload = {
      coins:        serializeMap(coins),
      xpStore:      serializeMap(xpStore),
      loginStreak:  serializeMap(loginStreak),
      lastDaily:    serializeMap(lastDaily),
      lastWeekly:   serializeMap(lastWeekly),
      achievementData: serializeMap(achievementData),
      userInventory:   serializeMap(userInventory),
      userBoosts:      serializeMap(userBoosts),
      msgCount:        serializeMap(msgCount),
      inviteCount:     serializeMap(inviteCount),
    };
    payload.setupChannels = [...setupChannels];
    fs.writeFileSync(PERSIST_FILE, JSON.stringify(payload), "utf8");
  } catch (e) { console.error("[Persist] Save failed:", e.message); }
}

function loadData() {
  try {
    if (!fs.existsSync(PERSIST_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(PERSIST_FILE, "utf8"));
    if (raw.coins)        for (const [k,v] of Object.entries(raw.coins))        coins.set(k, v);
    if (raw.xpStore)      for (const [k,v] of Object.entries(raw.xpStore))      xpStore.set(k, v);
    if (raw.loginStreak)  for (const [k,v] of Object.entries(raw.loginStreak))  loginStreak.set(k, v);
    if (raw.lastDaily)    for (const [k,v] of Object.entries(raw.lastDaily))    lastDaily.set(k, v);
    if (raw.lastWeekly)   for (const [k,v] of Object.entries(raw.lastWeekly))   lastWeekly.set(k, v);
    if (raw.msgCount)     for (const [k,v] of Object.entries(raw.msgCount))     msgCount.set(k, v);
    if (raw.inviteCount)  for (const [k,v] of Object.entries(raw.inviteCount))  inviteCount.set(k, v);
    if (raw.userBoosts)   for (const [k,v] of Object.entries(raw.userBoosts))   userBoosts.set(k, v);
    if (raw.achievementData) for (const [k,v] of Object.entries(raw.achievementData)) achievementData.set(k, v);
    if (raw.userInventory)   for (const [k,v] of Object.entries(raw.userInventory)) {
      userInventory.set(k, v && v.__map ? new Map(v.entries) : new Map(Object.entries(v ?? {})));
    }
    if (raw.setupChannels)   for (const id of raw.setupChannels) setupChannels.add(id);
    console.log("[Persist] Data loaded from", PERSIST_FILE);
  } catch (e) { console.error("[Persist] Load failed:", e.message); }
}

// ── Ping Role System ──────────────────────────────────────────────────────────

const PING_BYPASS_ROLE = "No Pings";

const PING_ROLE_CONFIG = {
  events:       { roleName: "Events Ping",       emoji: "📅", label: "Events" },
  giveaways:    { roleName: "Giveaways Ping",    emoji: "🎉", label: "Giveaways" },
  changelog:    { roleName: "Changelog Ping",    emoji: "📋", label: "Changelog" },
  sneakpeek:    { roleName: "Sneak Peek Ping",   emoji: "👀", label: "Sneak Peek" },
  announcement: { roleName: "Announcement Ping", emoji: "📢", label: "Announcements" },
  devblog:      { roleName: "Dev Blog Ping",     emoji: "🛠️", label: "Dev Blog" },
};

function detectChannelType(channelName) {
  const n = channelName.toLowerCase().replace(/_/g, "-");
  if (/event/.test(n))                                      return "events";
  if (/giveaway/.test(n))                                   return "giveaways";
  if (/change-?log|changelog|updates/.test(n))              return "changelog";
  if (/sneak|preview/.test(n))                              return "sneakpeek";
  if (/announce/.test(n))                                   return "announcement";
  if (/\bdev\b|dev-blog|development|blog/.test(n))          return "devblog";
  return null;
}

async function findOrCreateRole(guild, name) {
  const existing = guild.roles.cache.find((r) => r.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  return guild.roles.create({ name, mentionable: true, reason: "Auto-created by /setupchannel" });
}

function buildSetupChannelEmbed(type, guild) {
  const cfg = PING_ROLE_CONFIG[type];
  const descriptions = {
    events:       `${cfg.emoji} **Events are announced here!**\n\nClick below to get pinged when a new event drops so you never miss out.\n\n🎮 Look out for tournaments, game nights, and community challenges!`,
    giveaways:    `${cfg.emoji} **Giveaways drop here!**\n\nReact 🎉 on any active giveaway post to enter.\n\nClick below to get pinged when a new giveaway starts — the more active you are, the more giveaways we host!`,
    changelog:    `${cfg.emoji} **Game updates & patch notes are posted here.**\n\nClick below to get pinged when new changes land.\n\n🛠️ Updates include bug fixes, new features, balance changes, and more.`,
    sneakpeek:    `${cfg.emoji} **Exclusive previews of upcoming content drop here.**\n\nClick below to get pinged when a new sneak peek is posted.\n\n🎮 Be the first to see what's coming to CASES Beta!`,
    announcement: `${cfg.emoji} **Important server & game announcements are posted here.**\n\nClick below to get pinged for major news.\n\n📌 Big updates, server changes, and game news drop here first.`,
    devblog:      `${cfg.emoji} **Behind-the-scenes dev updates from the team.**\n\nClick below to get pinged when a new dev post goes out.\n\n💡 See exactly how CASES Beta is being built and improved.`,
  };
  return new EmbedBuilder()
    .setTitle(`${cfg.emoji} ${cfg.label} Channel`)
    .setDescription(descriptions[type])
    .setColor(0x5865f2)
    .setFooter({ text: `${guild.name} • Ping roles are always optional` })
    .setTimestamp();
}

function buildPingRoleRow(type) {
  const cfg = PING_ROLE_CONFIG[type];
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`pingrole_${type}`)
      .setLabel(`${cfg.emoji} Toggle ${cfg.label} Pings`)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("pingrole_nopings")
      .setLabel("🚫 Silence All Pings")
      .setStyle(ButtonStyle.Secondary),
  );
}

// ── Auto-seed empty channels ───────────────────────────────────────────────────
// Scans all text channels in a guild and posts a starter message in any that
// have zero messages visible to the bot. Uses CHANNEL_MESSAGES when available,
// falls back to a generic channel-name-based embed.

const SEED_SKIP_KEYWORDS = ["log", "logs", "staff", "admin", "mod", "ticket", "tickets", "bot-log"];

function buildGenericChannelEmbed(ch) {
  const n = ch.name.toLowerCase().replace(/[-_]/g, " ");
  const topicLine = ch.topic ? `\n\n> ${ch.topic}` : "";
  return new EmbedBuilder()
    .setTitle(`💬 Welcome to #${ch.name}!`)
    .setDescription(`This is **#${ch.name}** — jump in and get the conversation started! 🚀${topicLine}`)
    .setColor(0x5865f2)
    .setFooter({ text: "Cases 2.0 • Auto-seeded channel starter" })
    .setTimestamp();
}

async function seedEmptyChannels(guild) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const textChannels = guild.channels.cache.filter(ch =>
    ch.type === ChannelType.GuildText &&
    !SEED_SKIP_KEYWORDS.some(kw => ch.name.toLowerCase().includes(kw))
  );
  for (const [, ch] of textChannels) {
    try {
      const me = guild.members.me;
      const perms = ch.permissionsFor(me);
      if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms?.has(PermissionFlagsBits.SendMessages)) continue;
      const msgs = await ch.messages.fetch({ limit: 1 }).catch(() => null);
      if (!msgs || msgs.size > 0) continue; // already has messages — skip
      const key = ch.name.toLowerCase();
      const msgDef = CHANNEL_MESSAGES[key];
      if (msgDef) {
        const built = msgDef(guild);
        if (built && typeof built === "object" && built.embed) {
          const msg = await ch.send({ embeds: [built.embed], components: built.components ? [built.components] : [] });
          await msg.pin().catch(() => {});
        } else if (built) {
          const msg = await ch.send({ embeds: [built] });
          await msg.pin().catch(() => {});
        }
      } else {
        await ch.send({ embeds: [buildGenericChannelEmbed(ch)] });
      }
      console.log(`[SeedChannels] Posted starter in #${ch.name}`);
      await sleep(800);
    } catch (e) {
      console.error(`[SeedChannels] Failed #${ch.name}:`, e.message);
    }
  }
}

// Save every 5 minutes + on shutdown
setInterval(saveData, 5 * 60 * 1000);
process.on("SIGTERM", () => { saveData(); process.exit(0); });
process.on("SIGINT",  () => { saveData(); process.exit(0); });

function checkFunCooldown(userId, cmd) {
  const key = `${userId}:${cmd}`;
  const last = funCooldowns.get(key) ?? 0;
  const remaining = FUN_COOLDOWN_MS - (Date.now() - last);
  if (remaining > 0) return Math.ceil(remaining / 1000);
  funCooldowns.set(key, Date.now());
  return 0;
}

// ── Required roles — auto-created on startup ───────────────────────────────────

const REQUIRED_ROLES = [
  // Access roles
  { name: "Unverified Member",  color: 0xed4245 },
  { name: "Member",             color: 0x5865f2 },
  // Level roles
  { name: "Active",             color: 0x57f287 },
  { name: "Regular",            color: 0x5865f2 },
  { name: "Veteran",            color: 0xab47bc },
  { name: "Elite",              color: 0xff7043 },
  // Achievement roles
  { name: "Achievement Hunter", color: 0xfee75c },
  { name: "Legendary Buyer",    color: 0xed4245 },
  { name: "Trivia Master",      color: 0x00b0f4 },
  { name: "Voice Master",       color: 0x1abc9c },
  { name: "Devoted",            color: 0xe67e22 },
  { name: "Legend",             color: 0xffd700 },
  { name: "Scout",              color: 0x3498db },
  // Shop roles
  { name: "Chatter",            color: 0x57f287 },
  { name: "Regular+",           color: 0x5865f2 },
  { name: "Veteran+",           color: 0xab47bc },
  { name: "Server Legend",      color: 0xff7043 },
  { name: "Elite+",             color: 0xffd700 },
];

// Daily shop rotation: pick 3 random non-legendary items at 20% discount each day
function getDailyRotation() {
  const today = new Date().toISOString().slice(0, 10);
  if (dailyRotation.date === today) return dailyRotation.items;
  const pool = SHOP_CATALOG.filter((i) => i.rarity !== "Legendary");
  const picked = [...pool].sort(() => 0.5 - Math.random()).slice(0, 3);
  dailyRotation.date  = today;
  dailyRotation.items = picked.map((i) => i.id);
  return dailyRotation.items;
}

function buildShopEmbed(page = 0) {
  const RARITY_ORDER = ["Common", "Rare", "Epic", "Legendary"];
  const dailyIds = getDailyRotation();
  const sorted = [...SHOP_CATALOG].sort(
    (a, b) => RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity)
  );
  const PAGE_SIZE = 6;
  const pages = Math.ceil(sorted.length / PAGE_SIZE);
  const clampedPage = Math.max(0, Math.min(page, pages - 1));
  const slice = sorted.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE);

  const fields = slice.map((item) => {
    const stock  = getStock(item.id);
    const price  = getItemPrice(item);
    const isDaily = dailyIds.includes(item.id);
    const displayPrice = isDaily ? Math.round(price * 0.8) : price;
    const pop    = itemPopularity.get(item.id) ?? 0;
    const hot    = pop > 10 ? " 🔥" : "";
    return {
      name: `${RARITY_EMOJI[item.rarity]} **${item.name}**${hot}${isDaily ? " ⭐ DAILY DEAL" : ""} — \`${item.id}\``,
      value: `${item.effect}\n💰 **${displayPrice.toLocaleString()} coins**${isDaily ? ` ~~${price.toLocaleString()}~~` : ""} · 📦 Stock: **${stock}** · ⏳ Tier: ${item.rarity}`,
    };
  });

  const embed = new EmbedBuilder()
    .setTitle("🛒 Coin Shop")
    .setDescription(
      `Spend your coins on roles, boosts, and perks!\n` +
      `Use \`/buy <item id>\` to purchase · \`/inventory\` to view owned items\n` +
      `⭐ **Daily Deals** rotate every 24h at 20% off!\n\n` +
      `Page **${clampedPage + 1}/${pages}**`
    )
    .addFields(fields)
    .setColor(0xfee75c)
    .setFooter({ text: `💡 Tip: Popular items may cost slightly more due to demand!` })
    .setTimestamp();

  return { embed, pages, page: clampedPage };
}

function buildShopRow(page, pages) {
  if (pages <= 1) return null;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`shop_page_${page - 1}`)
      .setLabel("◀ Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`shop_page_${page + 1}`)
      .setLabel("Next ▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pages - 1),
  );
}

// ── Achievement catalog ────────────────────────────────────────────────────────

const ACHIEVEMENTS = [
  { id: "chatterbox",   name: "Chatterbox",       emoji: "💬", desc: "Send 100 messages",               goal: 100,  field: "msgs",        reward: { coins: 300,  xp: 100 } },
  { id: "voice_vet",    name: "Voice Veteran",     emoji: "🎙️", desc: "Spend 60 minutes in voice",       goal: 60,   field: "voiceMins",   reward: { coins: 400,  xp: 150 } },
  { id: "big_chatter",  name: "Big Talker",        emoji: "📢", desc: "Send 500 messages",               goal: 500,  field: "msgs",        reward: { coins: 800,  xp: 300 } },
  { id: "voice_master", name: "Voice Master",      emoji: "🎧", desc: "Spend 300 minutes in voice",      goal: 300,  field: "voiceMins",   reward: { coins: 1200, xp: 500, role: "Voice Master" } },
  { id: "streak_3",     name: "On a Roll",         emoji: "🔥", desc: "Log in 3 days in a row",          goal: 3,    field: "streak",      reward: { coins: 200,  xp: 50  } },
  { id: "streak_7",     name: "Weekly Warrior",    emoji: "📅", desc: "Log in 7 days in a row",          goal: 7,    field: "streak",      reward: { coins: 600,  xp: 200, role: "Devoted" } },
  { id: "streak_30",    name: "Legendary Devotee", emoji: "👑", desc: "Log in 30 days in a row",         goal: 30,   field: "streak",      reward: { coins: 5000, xp: 1000, role: "Legend" } },
  { id: "inviter_1",    name: "Recruiter",         emoji: "📨", desc: "Invite 1 member to the server",   goal: 1,    field: "invites",     reward: { coins: 200,  xp: 75  } },
  { id: "inviter_5",    name: "Talent Scout",      emoji: "🌐", desc: "Invite 5 members to the server",  goal: 5,    field: "invites",     reward: { coins: 800,  xp: 300, role: "Scout" } },
  { id: "rich",         name: "High Roller",       emoji: "💰", desc: "Accumulate 10,000 coins total",   goal: 10000,field: "totalCoins",  reward: { coins: 500,  xp: 200 } },
];

function getAchievements(userId) {
  if (!achievementData.has(userId)) achievementData.set(userId, {});
  return achievementData.get(userId);
}

async function checkAchievements(member, field, value, guild) {
  const data = getAchievements(member.id);
  const relevant = ACHIEVEMENTS.filter((a) => a.field === field);
  for (const ach of relevant) {
    const entry = data[ach.id] ?? { progress: 0, earned: false };
    if (entry.earned) continue;
    entry.progress = Math.max(entry.progress, value);
    if (entry.progress >= ach.goal) {
      entry.earned = true;
      data[ach.id] = entry;
      // Grant rewards
      addCoins(member.id, ach.reward.coins, null);
      if (ach.reward.xp) await addXP(member, ach.reward.xp, null);
      if (ach.reward.role) {
        let role = guild.roles.cache.find((r) => r.name === ach.reward.role);
        if (!role) { try { role = await guild.roles.create({ name: ach.reward.role, reason: "Achievement reward" }); } catch { /* ignore */ } }
        if (role) { try { await member.roles.add(role); } catch { /* ignore */ } }
      }
      // Announce
      const ch = findChannel(guild, "bot-commands");
      if (ch) {
        const embed = new EmbedBuilder()
          .setTitle(`${ach.emoji} Achievement Unlocked!`)
          .setDescription(`${member} earned **${ach.name}**!\n> ${ach.desc}\n\n🎁 **Reward:** +${ach.reward.coins} coins, +${ach.reward.xp ?? 0} XP${ach.reward.role ? `, \`${ach.reward.role}\` role` : ""}`)
          .setColor(0xfee75c)
          .setThumbnail(member.user.displayAvatarURL())
          .setTimestamp();
        ch.send({ embeds: [embed] }).catch(() => {});
      }
    } else {
      data[ach.id] = entry;
    }
  }
  achievementData.set(member.id, data);
}

// ── Login streak tracker ───────────────────────────────────────────────────────

async function updateLoginStreak(member, guild) {
  const today = new Date().toISOString().slice(0, 10);
  const existing = loginStreak.get(member.id) ?? { lastDate: "", streak: 0 };
  if (existing.lastDate === today) return; // already tracked today

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const newStreak  = existing.lastDate === yesterday ? existing.streak + 1 : 1;
  loginStreak.set(member.id, { lastDate: today, streak: newStreak });
  await checkAchievements(member, "streak", newStreak, guild);
}

// ── Channel finder (fuzzy, strips emojis) ─────────────────────────────────────

function baseName(str) {
  return str
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
    .replace(/[\u{2000}-\u{3300}]/gu, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase();
}

function findChannel(guild, partialName, type = ChannelType.GuildText) {
  const base = baseName(partialName);
  // Prefer exact match so e.g. "chat" doesn't return "staff-chat"
  return (
    guild.channels.cache.find((c) => c.type === type && baseName(c.name) === base) ??
    guild.channels.cache.find((c) => c.type === type && baseName(c.name).includes(base))
  ) ?? null;
}

// ── Mod log helper ─────────────────────────────────────────────────────────────

// Per-guild override of the log channel (set via /change-log-channel). In-memory only.
const logChannelOverrides = new Map(); // guildId -> channelId

function getLogChannel(guild) {
  const overrideId = logChannelOverrides.get(guild.id);
  if (overrideId) {
    const ch = guild.channels.cache.get(overrideId);
    if (ch && ch.type === ChannelType.GuildText) return ch;
    // override channel was deleted/inaccessible — drop the stale entry
    logChannelOverrides.delete(guild.id);
  }
  return findChannel(guild, "log");
}

async function logMod(guild, embed) {
  const ch = getLogChannel(guild);
  if (ch) ch.send({ embeds: [embed] }).catch((err) => console.error("Log send failed:", err.message));
  else console.warn("logMod: no log channel found in", guild.name);
}

// ── User profile tracker ───────────────────────────────────────────────────────

function bumpProfile(userId, field) {
  const p = userProfiles.get(userId) ?? { msgs: 0, voiceMins: 0, social: 0, grinder: 0 };
  p[field] = (p[field] ?? 0) + 1;
  userProfiles.set(userId, p);
}

function getProfileType(userId) {
  const p = userProfiles.get(userId);
  if (!p) return "Newcomer";
  if (p.voiceMins > p.msgs) return "Social";
  if (p.grinder > 10) return "Grinder";
  if (p.msgs > 100) return "Regular";
  return "Explorer";
}

// ── Context-aware keyword suggestions ─────────────────────────────────────────

const KEYWORD_HINTS = [
  { test: /\bhow do i\b|\bhow to\b|\bi need help\b/i,           hint: "💡 Need help? Check #commands-guide or open a ticket in #create-ticket!" },
  { test: /\banyone wanna play\b|\blooking for (team|players)\b/i, hint: "🎮 Looking for teammates? Use `/session-start` to create a gaming session!" },
  { test: /\bhow do i get coins\b|\bhow do i earn\b/i,           hint: "💰 Earn coins by chatting, claiming `/daily`, and joining voice!" },
  { test: /\bwhat rank am i\b|\bwhat level am i\b/i,             hint: "📊 Check your rank with `/rank`!" },
];
// Per-channel cooldown: only fire once per 5 min per channel so it's not spammy
const hintCooldown = new Map(); // channelId -> lastHintTimestamp
const HINT_COOLDOWN_MS = 5 * 60 * 1000;
// Only suggest in community channels, never in staff/log/ticket/admin
const HINT_BLOCKED_NAMES = ["log", "admin", "staff", "ticket", "mod", "verify"];

// ── Game update tracker ────────────────────────────────────────────────────────

const UNIVERSE_ID = "9908688856";
let lastGameUpdated    = null;
let updateChannelId    = null;
let updateAnnouncements = true; // toggled by /toggle-updates

// ── Duration helpers ───────────────────────────────────────────────────────────

const DURATION_LABELS = {
  "1h":  "1 hour",   "6h":  "6 hours",  "12h": "12 hours",
  "1d":  "1 day",    "3d":  "3 days",
  "1w":  "1 week",   "2w":  "2 weeks",  "4w":  "4 weeks",
};
function parseDurationMs(str) {
  const map = { h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  const m   = str?.match(/^(\d+)([hdw])$/);
  return m ? parseInt(m[1]) * map[m[2]] : null;
}

// Pending timed bans: guildId+userId -> timeout handle (cleared on manual unban)
const timedBans = new Map();

async function checkGameUpdate() {
  try {
    const res = await fetch(`https://games.roblox.com/v1/games?universeIds=${UNIVERSE_ID}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return;
    const data = await res.json();
    const game = data.data?.[0];
    if (!game) return;
    const updated = game.updated;
    if (!lastGameUpdated) { lastGameUpdated = updated; console.log(`Game update tracker: baseline set (${updated})`); return; }
    if (updated !== lastGameUpdated) {
      lastGameUpdated = updated;
      console.log(`Game update detected: ${updated}`);
      if (!updateAnnouncements) { console.log("Update announcements are disabled — skipping."); return; }
      for (const guild of client.guilds.cache.values()) {
        const ch = (updateChannelId && guild.channels.cache.get(updateChannelId)) ||
          findChannel(guild, "announce") || findChannel(guild, "update") || findChannel(guild, "news");
        if (!ch) continue;
        const embed = new EmbedBuilder()
          .setTitle("🎮 CASES Beta — Game Update!")
          .setDescription("A new update has been pushed to **CASES Beta** on Roblox!\n\n🔗 [Play Now](https://www.roblox.com/games/106780119627121/CASES-Beta)")
          .setColor(0x5865f2).setFooter({ text: "CASES Beta Update Tracker" }).setTimestamp();
        await ch.send({ content: "@everyone", embeds: [embed] });
      }
    }
  } catch (err) { console.error("Game update check error:", err.message); }
}

// ── Daily highlights ───────────────────────────────────────────────────────────

async function postDailyHighlights() {
  for (const guild of client.guilds.cache.values()) {
    const ch = findChannel(guild, "announce") ?? findChannel(guild, "leaderboard");
    if (!ch) continue;

    const top = [...xpStore.entries()].sort((a, b) => b[1].xp - a[1].xp).slice(0, 5);
    if (top.length === 0) continue;

    const lines = top.map(([id, d], i) => `**${i + 1}.** <@${id}> — Level ${d.level} · ${d.xp} XP · ${getCoins(id).toLocaleString()} coins`).join("\n");

    const embed = new EmbedBuilder()
      .setTitle("🌟 Daily Highlights — Top Members")
      .setDescription(lines)
      .setColor(0xfee75c)
      .setFooter({ text: "Keep chatting to climb the ranks! Use /rank to see your progress." })
      .setTimestamp();

    ch.send({ embeds: [embed] }).catch(() => {});
  }
}

// ── Micro-engagement prompts ───────────────────────────────────────────────────

const ENGAGEMENT_PROMPTS = [
  "🎮 **Who's playing CASES Beta right now?** Drop your username below!",
  "📸 **Share your best clip this week!** Post it in #clips",
  "🏆 **Grinding XP?** Use `/rank` to see your level and `/daily` to claim free coins!",
  "🎉 **Want free coins?** Use `/daily` and `/weekly` to claim your rewards!",
  "👥 **Looking for teammates?** Use `/session-start` to start a session and invite others!",
  "💬 **Be active, earn rewards!** Every message earns you XP and coins.",
  "🎁 **Did you know?** The most active members get surprise coin drops!",
];

async function postEngagementPrompt() {
  for (const guild of client.guilds.cache.values()) {
    const ch = findChannel(guild, "chat") ?? findChannel(guild, "game-chat");
    if (!ch) continue;
    const prompt = ENGAGEMENT_PROMPTS[Math.floor(Math.random() * ENGAGEMENT_PROMPTS.length)];
    ch.send({ content: prompt }).catch(() => {});
  }
}

// ── Reward drop zone activation ────────────────────────────────────────────────

// Keywords that identify channels verified members can NOT type in (read-only or staff-only)
const DROP_ZONE_EXCLUDE = [
  "log", "admin", "staff", "mod", "ticket", "verify", "verification",
  "welcome", "goodbye", "rules", "announcements", "announcement", "updates", "news",
  "commands-guide", "shop", "bot-commands", "giveaway", "events", "rewards",
  "suggestions", "clan", "media", "art", "screenshot", "introductions",
];

// ── Runtime toggles (configurable via slash commands) ──────────────────────────
let botSilenced = false; // /silence — when true, bot stops sending automated chatty messages
const excludedDropChannels = new Set(); // channelIds excluded from /boost & 2x drop zone events

async function activateRandomDropZone() {
  if (botSilenced) return; // 🤫 silenced — skip auto drop zones
  for (const guild of client.guilds.cache.values()) {
    // Only pick community channels that verified members can actually type in
    const textChannels = guild.channels.cache.filter((c) => {
      if (c.type !== ChannelType.GuildText) return false;
      if (excludedDropChannels.has(c.id)) return false; // 🚫 admin-excluded
      const n = baseName(c.name);
      if (DROP_ZONE_EXCLUDE.some((kw) => n.includes(kw.replace(/-/g, "")))) return false;
      // Ensure the channel doesn't explicitly deny SendMessages to @everyone / verified
      const everyoneOw = c.permissionOverwrites?.cache?.get(guild.id);
      if (everyoneOw?.deny?.has(PermissionFlagsBits.ViewChannel)) return false;
      return true;
    });
    if (textChannels.size === 0) continue;
    const arr = [...textChannels.values()];
    const chosen = arr[Math.floor(Math.random() * arr.length)];
    const duration = DROP_ZONE_DURATION();
    const expiresAt = Date.now() + duration;
    rewardDropZones.set(chosen.id, expiresAt);

    const mins = Math.round(duration / 60000);
    const embed = new EmbedBuilder()
      .setTitle("💰 Reward Drop Zone Active!")
      .setDescription(`This channel is now a **2x XP & Coins zone** for the next **${mins} minutes**!\n\nChat here to earn double rewards!`)
      .setColor(0xfee75c)
      .setTimestamp();
    chosen.send({ embeds: [embed] }).catch(() => {});

    setTimeout(() => {
      rewardDropZones.delete(chosen.id);
      chosen.send({ content: "⏰ The 2x reward boost in this channel has ended. Keep an eye out for the next drop zone!" }).catch(() => {});
    }, duration);
  }
}

// ── Server structure ───────────────────────────────────────────────────────────

const SERVER_STRUCTURE = [
  {
    name: "📋 INFORMATION",
    channels: [
      { name: "welcome",  topic: "👋 Welcome to the server! Read the rules & verify to unlock everything.", readOnly: true },
      { name: "goodbye",  topic: "👋 See who has left the server. We hope to see you again soon! 💙", readOnly: true },
    ],
  },
  {
    name: "💬 COMMUNITY",
    channels: [
      { name: "chat",  topic: "💬 General chat — keep it friendly, respectful & fun! 🎉" },
      { name: "media", topic: "🖼️ Share images, videos, screenshots & creative content. No NSFW." },
      { name: "memes", topic: "😂 Post your best memes. Keep it clean & community-friendly." },
    ],
  },
  {
    name: "🎮 GAMING",
    channels: [
      { name: "clan-recruitment", topic: "⚔️ Recruit or join clans here. Post your clan info using the pinned format!" },
      { name: "game-chat",        topic: "🎮 Talk about CASES Beta, Roblox & gaming in general. No spoilers!" },
      { name: "clips",            topic: "🎬 Share your best gameplay clips, highlights & wins. Go crazy!" },
    ],
  },
  {
    name: "📈 PROGRESSION",
    channels: [
      { name: "bot-commands",   topic: "🤖 Use all bot commands here — /balance /daily /rank /shop /achievements" },
      { name: "leaderboards",   topic: "🏆 Top server members ranked by XP & level. Climb the board!", readOnly: true },
      { name: "rewards",        topic: "💰 See what rewards you can earn by levelling up & staying active!", readOnly: true },
      { name: "commands-guide", topic: "📋 Full guide to every bot command. Read before asking!", readOnly: true },
      { name: "shop",           topic: "🛒 Browse & buy items with /shop. Daily deals rotate every 24h!", readOnly: true },
    ],
  },
  {
    name: "🎊 EVENTS",
    channels: [
      { name: "announcements", topic: "📢 Official server announcements & CASES Beta updates. Stay tuned!", readOnly: true },
      { name: "giveaways",     topic: "🎉 Ongoing giveaways — react 🎉 to enter! Winners drawn randomly.", readOnly: true },
      { name: "events",        topic: "📅 Upcoming & active server events. Don't miss out on rewards!", readOnly: true },
    ],
  },
  {
    name: "🌐 SOCIAL",
    channels: [
      { name: "invites",     topic: "🔗 Check your invite stats with /invites. Top inviters get rewards!", readOnly: true },
      { name: "suggestions", topic: "💡 Suggest improvements for the server or CASES Beta. All ideas welcome!" },
    ],
  },
  {
    name: "🔊 VOICE",
    channels: [
      { name: "🔊 General",       voice: true },
      { name: "🎮 Gaming",        voice: true },
      { name: "🎵 Music",         voice: true },
      { name: "➕ Create a Room", voice: true },
    ],
  },
  {
    name: "🎫 TICKETS",
    channels: [
      { name: "create-ticket", topic: "🎫 Need help? Click the button below to open a private support ticket!", readOnly: true },
    ],
  },
  {
    name: "🎮 GAME RELATED",
    channels: [
      { name: "questions",     topic: "❓ Got questions about CASES Beta? Ask here and the community will help!" },
      { name: "trading",       topic: "🖥️ Trade items with other players. Post your offers and requests here!" },
      { name: "bug-reports",   topic: "💥 Found a bug in CASES Beta? Report it here with as much detail as possible." },
      { name: "your-wins",     topic: "⚔️ Share your best wins, highlights and victories from CASES Beta!" },
      { name: "win-or-lose",   topic: "🏆 Post your match results — wins and losses both welcome here!" },
      { name: "marketplace",   topic: "🏷️ Buy, sell and browse items. Check #limited-items for exclusive drops!" },
      { name: "limited-items", topic: "🔖 Limited & exclusive items only — rare drops, seasonal gear and special offers." },
    ],
  },
  {
    name: "👮 STAFF",
    channels: [
      { name: "staff-chat",     topic: "👮 Staff-only discussion. Keep things professional & on-topic.", staffOnly: true },
      { name: "logs",           topic: "📋 Moderation & event logs. All server activity is recorded here.", staffOnly: true },
      { name: "admin-commands", topic: "⚙️ Staff-only bot commands. Use /warn /mute /kick /ban & admin tools here.", staffOnly: true },
    ],
  },
];

// ── Channel messages (sent + pinned during setup-server) ───────────────────────

const CHANNEL_MESSAGES = {
  "welcome": (guild) => new EmbedBuilder()
    .setTitle(`🎉 Welcome to ${guild.name}!`)
    .setDescription(
      `**We're glad to have you here.**\n\n` +
      `**Getting started:**\n` +
      `**1.** Read the rules in <#${findChannel(guild, "rules")?.id ?? "rules"}>\n` +
      `**2.** Verify your account in <#${findChannel(guild, "verification")?.id ?? "verification"}> to unlock the server\n` +
      `**3.** Say hi in <#${(findChannel(guild, "general") ?? findChannel(guild, "chat"))?.id ?? "general-chat"}>\n` +
      `**4.** Chat to earn XP & coins — climb the leaderboard\n\n` +
      `🎮 **[Play CASES Beta on Roblox →](https://www.roblox.com/games/106780119627121/CASES-Beta)**`
    )
    .setColor(0x5865f2)
    .setFooter({ text: `${guild.name} • Glad you joined!` })
    .setTimestamp(),

  "goodbye": (guild, member) => new EmbedBuilder()
    .setTitle(`👋 See you later, ${member?.user?.username ?? "a member"}`)
    .setDescription(
      `**${member?.user?.username ?? "Someone"} has left the server.**\n\n` +
      `We hope to see you again sometime.\n\n` +
      `🎮 **[CASES Beta is always here →](https://www.roblox.com/games/106780119627121/CASES-Beta)**`
    )
    .setColor(0xed4245)
    .setThumbnail(member?.user?.displayAvatarURL() ?? null)
    .setFooter({ text: `${guild.name} • ${guild.memberCount} members remaining` })
    .setTimestamp(),

  "verification": (guild) => new EmbedBuilder()
    .setTitle("🔐 Account Verification")
    .setDescription(
      `**Welcome to ${guild.name}!**\n\n` +
      `To access the rest of the server, verify your Roblox account with **Rover**. It only takes a sec.\n\n` +
      `**How to verify:**\n` +
      `**1.** Link your Roblox account with **Rover**\n` +
      `**2.** Click the **"Update My Roles"** button (already in this channel by **Rover**)\n` +
      `**3.** Done — your **Verified** role unlocks the rest of the server\n\n` +
      `Need help? Open a ticket in <#${findChannel(guild, "create-ticket")?.id ?? "create-ticket"}> and staff will help you out.\n\n` +
      `🎮 **[Play CASES Beta on Roblox →](https://www.roblox.com/games/106780119627121/CASES-Beta)**`
    )
    .setColor(0x57f287)
    .setFooter({ text: `${guild.name} • Verified members get the full experience` })
    .setTimestamp(),

  "rules-must-read": () => new EmbedBuilder()
    .setTitle("📖 Server Rules")
    .setDescription(
      `**Follow these rules to keep the server clean, fun, and welcoming for everyone.**\n\n` +
      `**1. Respect Everyone** — No hate speech, harassment, slurs, or toxicity.\n` +
      `**2. No Spam** — Don't flood chats with messages, emojis, caps-lock, or pings.\n` +
      `**3. No NSFW Content** — Keep everything appropriate for all ages. No gore or sexual content.\n` +
      `**4. No Advertising** — Don't promote other servers, channels, or socials without staff approval.\n` +
      `**5. Use the Right Channels** — Memes in #memes, clips in #media, suggestions in #suggestions, etc.\n` +
      `**6. No Cheating, Scamming, or Exploiting** — Exploiting CASES Beta or scamming members = **instant ban**.\n` +
      `**7. Follow Discord ToS & Community Guidelines** — [discord.com/terms](https://discord.com/terms)\n` +
      `**8. No Bot Abuse** — Don't farm XP/coins via spam, alts, or self-bots. Caught = wiped + banned.\n` +
      `**9. Voice Chat Etiquette** — No earrape, harassment via voice changers, or mic spam.\n` +
      `**10. Listen to Staff** — Staff have final say. Take disputes to a ticket, not public chat.\n\n` +
      `> **Punishment ladder:** warning → mute → kick → ban\n\n` +
      `**Auto-Mod is active.** Sending **10+ messages within 5 seconds** is auto-detected as spam and will:\n` +
      `• Delete your messages\n` +
      `• Time you out for 5 minutes\n` +
      `• Issue a warning & cost you a ❤️ life\n\n` +
      `At **0 lives** you get auto-kicked. Repeat offenders are **banned permanently**. Staff can restore lives with \`/resetlives\`.\n\n` +
      `**Need help or want to report someone?** Open a ticket in <#create-ticket>.`
    )
    .setColor(0xed4245)
    .setFooter({ text: "Violations handled by staff • Stay safe & have fun" })
    .setTimestamp(),

  "commands-guide": () => new EmbedBuilder()
    .setTitle("📋 Commands Guide")
    .setDescription(
      `**💰 Economy** *(use in #bot-commands)*\n` +
      `\`/balance\` — 💵 Check coins · \`/daily\` — 🎁 200 coins · \`/weekly\` — 📅 1,000 coins\n\n` +
      `**🛒 Shop** *(use in #bot-commands)*\n` +
      `\`/shop\` — Browse items · \`/buy <id>\` — Purchase · \`/inventory\` — View owned · \`/equip <id>\` — Equip roles\n\n` +
      `**🏆 Achievements** *(use in #bot-commands)*\n` +
      `\`/achievements\` — View all achievements & progress\n\n` +
      `**📈 XP & Progress** *(use in #bot-commands)*\n` +
      `\`/rank\` — 🃏 Rank card · \`/leaderboard\` — 🏅 Top 10 · \`/challenges\` — 🎯 Daily goals\n\n` +
      `**📊 Stats** *(use in #bot-commands)*\n` +
      `\`/serverstats\` — 📊 Server info · \`/activity\` — 📈 Your stats · \`/invites\` — 🔗 Invite count\n\n` +
      `**🛡️ Moderation** *(staff only • #admin-commands)*\n` +
      `\`/warn\` ⚠️ · \`/mute\` 🔇 · \`/kick\` 👢 · \`/ban [duration]\` 🔨 · \`/boost\` ⚡ 2x XP 30 min\n` +
      `> \`/ban\` supports optional durations: 1h · 6h · 12h · 1d · 3d · 1w · 2w · 4w · or leave empty for permanent\n\n` +
      `**👑 Head Admin Only**\n` +
      `\`/organize_server\` 🔧 · \`/setup-server\` ⚙️ · \`/resetlives\` ❤️ · \`/test-update\` 🎮 · \`/toggle-updates\` 🔔\n` +
      `\`/silence\` 🤫 · \`/exclude-2x\` 🚫 · \`/post-verification\` 🔐 · \`/post-rules\` 📖\n` +
      `> \`/toggle-updates\` — pause/resume automatic game update announcements\n` +
      `> \`/silence\` — stop the bot from posting auto chat messages (drop zones, hints, AI replies)\n` +
      `> \`/exclude-2x\` — block a channel from ever being chosen as a 2x drop zone\n\n` +
      `**🎉 Events**\n` +
      `\`/giveaway\` 🎊 · \`/session-start\` 🎮\n\n` +
      `**🎫 Support**\n` +
      `Click **🎫 Open a Ticket** in #create-ticket or use \`/ticket\` anywhere`
    )
    .setColor(0x57f287)
    .setFooter({ text: "All commands work in #bot-commands • Staff commands in #admin-commands" })
    .setTimestamp(),

  "shop": () => new EmbedBuilder()
    .setTitle("🛒 Coin Shop — Spend Big, Flex Bigger!")
    .setDescription(
      `💸 **Blow your coins on exclusive roles, boosts & perks!**\n\n` +
      `**📌 How to use:**\n` +
      `\`/shop\` — 👀 Browse all items with prices, stock & rarity\n` +
      `\`/buy <item id>\` — 🛍️ Purchase (e.g. \`/buy xp_surge_s\`)\n` +
      `\`/inventory\` — 🎒 View everything you own\n` +
      `\`/equip <item id>\` — ✨ Equip a role item from your inventory\n\n` +
      `**🎯 Item Tiers:**\n` +
      `🟢 **Common** — Affordable basics for everyone\n` +
      `🔵 **Rare** — Mid-tier boosts & cool roles\n` +
      `🟣 **Epic** — High-value upgrades, worth grinding for\n` +
      `🔴 **Legendary** — Ultra-rare, extremely limited stock 🔥\n\n` +
      `**⭐ Daily Deals** — 3 items rotate every 24h at 20% off!\n` +
      `**🔥 Hot items** may cost a bit more due to high demand.\n\n` +
      `> Use \`/bot-commands\` only here — no chatting!`
    )
    .setColor(0xfee75c)
    .setFooter({ text: "Coins earned by chatting, voice, daily rewards & more 💰" })
    .setTimestamp(),

  "rewards": () => new EmbedBuilder()
    .setTitle("🏆 Reward System — Get Active, Get Paid!")
    .setDescription(
      `**The more you chat & chill, the more you earn. Simple. 💪**\n\n` +
      `**📈 XP Level-Up Roles**\n` +
      `🟢 Level 5 → \`Active\` role ⚡\n` +
      `🔵 Level 10 → \`Regular\` role 🎯\n` +
      `🟣 Level 20 → \`Veteran\` role 👑\n` +
      `🔴 Level 50 → \`Elite\` role 💎\n\n` +
      `**💰 How to earn coins & XP:**\n` +
      `💬 **Chatting** — up to 20 XP + 5 coins / min\n` +
      `🎙️ **Voice** — 15 XP + 10 coins every 5 min\n` +
      `🎁 **Daily** — 200 coins · 📅 **Weekly** — 1,000 coins\n` +
      `🎯 **Daily Challenges** — 300 coins + 100 XP on completion\n` +
      `💥 **Surprise Drops** — random bonus coins any time!\n` +
      `🏆 **Achievements** — unlock milestones for big rewards\n\n` +
      `**⚡ Boost Events**\n` +
      `🔥 Drop zones & server events = 2×–4× rewards! Keep your eyes peeled.`
    )
    .setColor(0xfee75c)
    .setFooter({ text: "Use /rank • /leaderboard • /challenges to track your progress!" })
    .setTimestamp(),

  "giveaways": () => new EmbedBuilder()
    .setTitle("🎊 Giveaways — Free Stuff? Say Less!")
    .setDescription(
      `Active and upcoming giveaways drop here! 👀\n\n` +
      `**🎉 How to enter:**\n` +
      `React with 🎉 on any active giveaway post — that's it!\n\n` +
      `**📋 Rules:**\n` +
      `- Winners drawn randomly from all 🎉 reactors\n` +
      `- You must still be in the server when it ends\n` +
      `- Results posted here when the giveaway closes\n\n` +
      `> 👀 Stay active — more activity = more giveaway entries!`
    )
    .setColor(0xeb459e)
    .setFooter({ text: "Good luck to all entrants 🍀" })
    .setTimestamp(),

  "clan-recruitment": () => new EmbedBuilder()
    .setTitle("⚔️ Clan Recruitment — Find Your Squad!")
    .setDescription(
      `Looking for a clan or recruiting players? This is the place! 🔥\n\n` +
      `**📋 Post format:**\n` +
      `\`\`\`\n🏷️ Clan Name:\n🎯 Focus: [PvP / Trading / Casual]\n👥 Size:\n📋 Requirements:\n📩 How to Join:\n\`\`\`\n\n` +
      `> ⚔️ Build something legendary. CASES Beta clans start here.`
    )
    .setColor(0xed4245)
    .setFooter({ text: "Be respectful — no flame wars in this channel!" })
    .setTimestamp(),

  "suggestions": () => new EmbedBuilder()
    .setTitle("💡 Suggestions — Your Voice Matters!")
    .setDescription(
      `Got an idea to make the server or CASES Beta better? Drop it here! 🔥\n\n` +
      `**✅ Tips for a great suggestion:**\n` +
      `- Be specific and clear about what you want\n` +
      `- Explain **why** it would help the community\n` +
      `- Keep it constructive — no complaints, only solutions\n\n` +
      `> 📬 Staff reads every suggestion. Best ones get added! 🎯`
    )
    .setColor(0x5865f2)
    .setFooter({ text: "Drop your idea below 👇" })
    .setTimestamp(),

  "trading": () => new EmbedBuilder()
    .setTitle("🖥️ Trading — Buy, Sell & Swap!")
    .setDescription(
      `Welcome to the trading channel! Post your offers and find deals. 🤝\n\n` +
      `**📋 Trade post format:**\n` +
      `\`\`\`\n🔄 Offering:\n🔍 Looking For:\n📩 DM me or reply below!\n\`\`\`\n\n` +
      `**✅ Rules:**\n` +
      `- Be honest about what you're trading\n` +
      `- No scamming — report suspicious offers to staff\n` +
      `- Keep it civil and respect others\n\n` +
      `> 💡 Check \`#marketplace\` for listed items & \`#limited-items\` for rare drops!`
    )
    .setColor(0x5865f2)
    .setFooter({ text: "Trade smart — no scams allowed 🤝" })
    .setTimestamp(),

  "bug-reports": () => new EmbedBuilder()
    .setTitle("💥 Bug Reports — Help Us Fix CASES Beta!")
    .setDescription(
      `Found something broken? Report it here so we can squash it! 🐛\n\n` +
      `**📋 Bug report format:**\n` +
      `\`\`\`\n🐛 Bug Description:\n📍 Where it happened:\n🔁 How to reproduce:\n📸 Screenshot/Video (if possible):\n\`\`\`\n\n` +
      `**✅ Good reports get fixed fast. Include as much detail as possible!**\n\n` +
      `> ⚠️ Please check if the bug is already reported before posting a duplicate.`
    )
    .setColor(0xed4245)
    .setFooter({ text: "Your reports make CASES Beta better 🔧" })
    .setTimestamp(),

  "your-wins": () => new EmbedBuilder()
    .setTitle("⚔️ Your Wins — Show Off Your Best Moments!")
    .setDescription(
      `This is your place to flex! Post your best wins, clutch plays and highlights. 🔥\n\n` +
      `**📸 What to share:**\n` +
      `- Screenshots of big wins\n` +
      `- Clips of clutch moments\n` +
      `- Rare drops & epic loot\n` +
      `- Personal records & milestones\n\n` +
      `> 🏆 Hype each other up — good vibes only in here!`
    )
    .setColor(0xfee75c)
    .setFooter({ text: "Keep winning 👑" })
    .setTimestamp(),

  "win-or-lose": () => new EmbedBuilder()
    .setTitle("🏆 Win or Lose — Post Your Results!")
    .setDescription(
      `Share how your matches went — wins AND losses welcome here. No shame! 💪\n\n` +
      `**📋 How to post:**\n` +
      `\`\`\`\n✅/❌ Result:\n🎮 Mode / Map:\n📊 Score / Stats:\n💬 Quick thoughts:\n\`\`\`\n\n` +
      `> 🤝 Win with grace, lose with dignity — respect everyone's results!`
    )
    .setColor(0x57f287)
    .setFooter({ text: "Every game is a learning experience 🎮" })
    .setTimestamp(),

  "marketplace": () => new EmbedBuilder()
    .setTitle("🏷️ Marketplace — Trade & Browse Items!")
    .setDescription(
      `The CASES Beta marketplace — list items, find deals, and browse what's available. 🛒\n\n` +
      `**📋 Listing format:**\n` +
      `\`\`\`\n🏷️ Item(s):\n💰 Price / Trade:\n📦 Quantity:\n📩 Contact:\n\`\`\`\n\n` +
      `**🔖 Check \`#limited-items\` for exclusive & seasonal drops!**\n\n` +
      `> ⚠️ Staff do not mediate trades — deal at your own risk. Report scammers to staff.`
    )
    .setColor(0xf1c40f)
    .setFooter({ text: "Buy smart, sell smart 💰" })
    .setTimestamp(),

  "limited-items": () => new EmbedBuilder()
    .setTitle("🔖 Limited Items — Exclusive & Rare Drops!")
    .setDescription(
      `This channel is for **limited, seasonal and exclusive items only**. 🌟\n\n` +
      `**What gets posted here:**\n` +
      `🎃 Seasonal & event items\n` +
      `💎 Rare and one-of-a-kind drops\n` +
      `⭐ Staff-featured special offers\n` +
      `🎁 Giveaway prizes & reward items\n\n` +
      `**⏳ These items won't be around forever — grab them while you can!**\n\n` +
      `> 📢 Watch this channel and \`#announcements\` so you never miss a drop!`
    )
    .setColor(0xe91e8c)
    .setFooter({ text: "Limited stock — first come, first served 🔥" })
    .setTimestamp(),

  "game-questions": () => new EmbedBuilder()
    .setTitle("❓ Questions — Ask Anything About CASES Beta!")
    .setDescription(
      `Got a question about CASES Beta, the server or how things work? Ask here! 🙋\n\n` +
      `**💡 Tips for asking a good question:**\n` +
      `- Be specific about what you need help with\n` +
      `- Include screenshots if relevant\n` +
      `- Check if it's already been answered above\n\n` +
      `> 🤝 Community members and staff are here to help — no dumb questions!`
    )
    .setColor(0x3498db)
    .setFooter({ text: "If you're unsure, just ask! 💬" })
    .setTimestamp(),

  "create-ticket": () => ({
    embed: new EmbedBuilder()
      .setTitle("🎫 Support Tickets — We Got You fr!")
      .setDescription(
        `Need help or got an issue? Open a private ticket and staff will sort you out! 🙏\n\n` +
        `**When to open a ticket:**\n` +
        `🐛 Report a bug in CASES Beta\n` +
        `🚫 Appeal a ban or mute\n` +
        `⚠️ Report a member breaking rules\n` +
        `❓ Any question that needs staff attention\n\n` +
        `Click the button below to open your private ticket. Staff checks these deadass 💯`
      )
      .setColor(0x5865f2)
      .setFooter({ text: "One ticket per issue • Staff will respond ASAP 🔥" })
      .setTimestamp(),
    components: new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("open_ticket")
        .setLabel("Open a Ticket")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("🎫")
    ),
  }),
};

// ── Setup server ───────────────────────────────────────────────────────────────

async function setupServer(guild, interaction) {
  await interaction.editReply({ content: "🔧 Setting up server structure — renaming & updating existing channels, creating missing ones..." });

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let staffRole = guild.roles.cache.find((r) => r.permissions.has(PermissionFlagsBits.ManageGuild) && !r.managed && r.id !== guild.id);
  let created = 0, updated = 0, skipped = 0;
  const errors = [];

  for (const cat of SERVER_STRUCTURE) {
    let category = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && baseName(c.name) === baseName(cat.name)
    );
    if (!category) {
      // Attempt creation with one retry (handles transient rate limits)
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          category = await guild.channels.create({ name: cat.name, type: ChannelType.GuildCategory });
          created++;
          await sleep(600);
          break;
        } catch (err) {
          console.error(`Failed to create category ${cat.name} (attempt ${attempt}):`, err.message);
          if (attempt < 2) await sleep(3000);
          else { errors.push(`❌ Category \`${cat.name}\`: ${err.message}`); }
        }
      }
      if (!category) continue; // genuinely couldn't create — skip channels
    } else if (category.name !== cat.name) {
      try { await category.setName(cat.name); updated++; await sleep(400); }
      catch (err) { console.error("Failed to rename category", cat.name, err.message); }
    }

    for (const ch of cat.channels) {
      const chType = ch.voice ? ChannelType.GuildVoice : ChannelType.GuildText;
      const existing = guild.channels.cache.find(
        (c) => c.type === chType && baseName(c.name) === baseName(ch.name)
      );
      if (existing) {
        if (!ch.voice && ch.topic && existing.topic !== ch.topic) {
          try { await existing.setTopic(ch.topic); updated++; await sleep(300); } catch { /* ignore */ }
        }
        if (existing.parentId !== category.id) {
          try { await existing.setParent(category.id, { lockPermissions: false }); await sleep(300); } catch { /* ignore */ }
        }
        skipped++;
        continue;
      }

      const overwrites = [];
      if (ch.staffOnly) {
        overwrites.push({ id: guild.id, deny: [PermissionFlagsBits.ViewChannel] });
        if (staffRole) overwrites.push({ id: staffRole.id, allow: [PermissionFlagsBits.ViewChannel] });
        overwrites.push({ id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
      } else if (ch.readOnly) {
        overwrites.push({ id: guild.id, deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.SendMessagesInThreads] });
        overwrites.push({ id: client.user.id, allow: [PermissionFlagsBits.SendMessages] });
      }

      try {
        const newCh = await guild.channels.create({
          name: ch.name,
          type: chType,
          topic: ch.voice ? undefined : (ch.topic ?? undefined),
          parent: category.id,
          permissionOverwrites: overwrites,
        });
        created++;
        await sleep(500);

        if (!ch.voice) {
          const msgBuilder = CHANNEL_MESSAGES[ch.name];
          if (msgBuilder) {
            try {
              const built = msgBuilder(guild);
              const payload = built && built.embed
                ? { embeds: [built.embed], components: [built.components] }
                : { embeds: [built] };
              const msg = await newCh.send(payload);
              await msg.pin().catch(() => {});
              await sleep(400);
            } catch (e) { console.error("Channel message error:", ch.name, e.message); }
          }
        }
      } catch (err) {
        console.error("Failed to create channel", ch.name, err.message);
        errors.push(`❌ Channel \`#${ch.name}\`: ${err.message}`);
      }
    }
  }

  // Seed any remaining empty channels that didn't get a message above
  seedEmptyChannels(guild).catch(() => {});

  const errorBlock = errors.length ? `\n\n⚠️ **${errors.length} error(s):**\n${errors.slice(0, 5).join("\n")}` : "";
  await interaction.editReply({
    content: `✅ Server setup complete!\n• **${created}** channels/categories created\n• **${updated}** renamed or had topics updated\n• **${skipped}** already up to date${errorBlock}`,
  });
}

// ── Ticket panel sender (for existing create-ticket channels) ──────────────────

async function sendTicketPanel(channel) {
  const built = CHANNEL_MESSAGES["create-ticket"]();
  try {
    const msgs = await channel.messages.fetch({ limit: 100 });
    const existing = msgs.find((m) => m.author.id === client.user?.id && m.components?.length > 0);
    if (existing) {
      await existing.edit({ embeds: [built.embed], components: [built.components] }).catch(() => {});
      return;
    }
  } catch { /* ignore */ }
  await channel.send({ embeds: [built.embed], components: [built.components] }).catch(console.error);
}

// ── Bot ready ──────────────────────────────────────────────────────────────────

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
    for (const guild of client.guilds.cache.values()) {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: commands });
      console.log(`Slash commands registered for guild: ${guild.name}`);

      // Cache invites
      try {
        const invites = await guild.invites.fetch();
        const map = new Map();
        invites.forEach((inv) => map.set(inv.code, inv.uses));
        inviteCache.set(guild.id, map);
      } catch { /* missing permissions */ }

      // Send ticket panel to create-ticket channel if not already posted
      const ticketCh = findChannel(guild, "create-ticket");
      if (ticketCh) await sendTicketPanel(ticketCh);
    }
  } catch (err) { console.error("Failed to register commands:", err.message); }

  await checkGameUpdate();
  setInterval(checkGameUpdate, 5 * 60 * 1000);

  // Voice XP ticker — every 5 minutes
  setInterval(async () => {
    const now = Date.now();
    for (const [userId, joinedAt] of voiceJoined.entries()) {
      if (now - joinedAt >= 5 * 60 * 1000) {
        addCoins(userId, 10, null);
        voiceJoined.set(userId, now);
        const xpGain = Math.round(15 * getMultiplier(null, userId, "xp"));
        const data = getXP(userId);
        data.xp += xpGain;
        data.level = getLevel(data.xp);
        xpStore.set(userId, data);
        updateChallenge(userId, "voiceMinutes", 5);
        bumpProfile(userId, "voiceMins");

        // Achievement tracking for voice minutes
        const p = userProfiles.get(userId);
        const totalVoiceMins = p?.voiceMins ?? 0;
        // Find the member object from any guild
        for (const guild of client.guilds.cache.values()) {
          const member = guild.members.cache.get(userId);
          if (member) {
            await checkAchievements(member, "voiceMins", totalVoiceMins, guild);
            break;
          }
        }
      }
    }
  }, 60 * 1000);

  // Voice engagement bonus: every 2 mins check if 3+ members are in same VC
  setInterval(async () => {
    const now = Date.now();
    for (const guild of client.guilds.cache.values()) {
      const voiceChannels = guild.channels.cache.filter((c) => c.type === ChannelType.GuildVoice);
      for (const [, vc] of voiceChannels) {
        const human = vc.members.filter((m) => !m.user.bot);
        if (human.size >= 3) {
          for (const [, member] of human) {
            const last = voiceEngageBonus.get(member.id) ?? 0;
            if (now - last > 10 * 60 * 1000) { // max once per 10 min
              voiceEngageBonus.set(member.id, now);
              addCoins(member.id, 25);
              const data = getXP(member.id);
              data.xp += 30;
              data.level = getLevel(data.xp);
              xpStore.set(member.id, data);
            }
          }
        }
      }
    }
  }, 2 * 60 * 1000);

  // Daily highlights — 24 hours
  setInterval(postDailyHighlights, 24 * 60 * 60 * 1000);

  // Shop auto-restock — every 24 hours
  setInterval(() => {
    for (const item of SHOP_CATALOG) {
      const current = getStock(item.id);
      if (current < item.restockAmt) {
        shopStock.set(item.id, item.restockAmt);
        console.log(`[Shop] Restocked ${item.name} to ${item.restockAmt}`);
      }
    }
  }, 24 * 60 * 60 * 1000);

  // Micro-engagement prompts — every 4 hours
  setInterval(postEngagementPrompt, 4 * 60 * 60 * 1000);

  // Reward drop zone — every 2 hours activate a random channel
  setInterval(activateRandomDropZone, 2 * 60 * 60 * 1000);

  // Auto-create missing required roles in every guild
  for (const guild of client.guilds.cache.values()) {
    for (const roleDef of REQUIRED_ROLES) {
      const exists = guild.roles.cache.find((r) => r.name === roleDef.name);
      if (!exists) {
        try {
          await guild.roles.create({ name: roleDef.name, color: roleDef.color, reason: "Auto-created by Cases 2.0" });
          console.log(`[AutoRole] Created: ${roleDef.name} in ${guild.name}`);
        } catch (e) { console.error(`[AutoRole] Failed ${roleDef.name}:`, e.message); }
      }
    }
  }

  // Load persisted data on startup
  loadData();

  // Seed any empty channels with a starter message
  for (const [, guild] of client.guilds.cache) {
    seedEmptyChannels(guild).catch(() => {});
  }

  console.log("All systems online.");
});

// ── Messages → XP + coins + smart systems ─────────────────────────────────────

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  const userId  = message.author.id;
  const now     = Date.now();
  const content = message.content;

  // Track activity for adaptive rewards
  recentActivity.push(now);
  while (recentActivity.length > 0 && now - recentActivity[0] > 60 * 60 * 1000) recentActivity.shift();

  // ── Auto-mod: spam detection (10 msgs in 5 seconds) ────────────────────────
  const spamTimes = (spamTracker.get(userId) ?? []).filter((t) => now - t < 5000);
  spamTimes.push(now);
  spamTracker.set(userId, spamTimes);
  if (spamTimes.length >= 10) {
    spamTracker.set(userId, []);
    try {
      // Delete spam messages
      const msgs = await message.channel.messages.fetch({ limit: 10 });
      const toDelete = msgs.filter((m) => m.author.id === userId && now - m.createdTimestamp < 6000);
      await message.channel.bulkDelete(toDelete, true).catch(() => {});

      const member = message.member ?? await message.guild.members.fetch(userId).catch(() => null);
      if (!member) return;

      // ── Life system ──────────────────────────────────────────────────────────
      const prevLives = getLives(userId);
      const newLives  = prevLives - 1;
      setLives(userId, newLives);

      // Add a warning entry
      const warnList = warnings.get(userId) ?? [];
      warnList.push({ reason: "Auto-mod: spam detected", ts: now, mod: "CASES | BETA (Auto)" });
      warnings.set(userId, warnList);

      // DM the user
      member.user.send(
        `⚠️ **You have been warned for spamming in ${message.guild.name}.**\n` +
        `❤️ You now have **${newLives} / ${MAX_LIVES} lives** remaining.\n` +
        (newLives === 1 ? `🚨 **Warning: 1 life left! Next offense will result in a kick.**` :
         newLives === 0 ? `🚨 **You have 0 lives remaining and will be kicked.**` :
         `Continued behaviour will result in further punishment.`)
      ).catch(() => {});

      // Timeout (5 minutes)
      if (member.moderatable) {
        await member.timeout(5 * 60 * 1000, "Auto-mod: spam detected").catch(() => {});
      }

      // Log embed
      const logEmbed = new EmbedBuilder()
        .setTitle("⚫ Auto-Mod: Spam Detected")
        .setColor(0x99aab5)
        .addFields(
          { name: "👤 User",      value: `${member} — \`${member.user.tag}\`\nID: \`${member.id}\``, inline: false },
          { name: "📍 Channel",   value: `${message.channel}`,                                         inline: true },
          { name: "⏱️ Timeout",  value: "5 minutes",                                                   inline: true },
          { name: "❤️ Lives",    value: `${newLives} / ${MAX_LIVES} remaining`,                        inline: true },
          { name: "📄 Reason",   value: "Sending 10+ messages within 5 seconds",                       inline: false },
        )
        .setTimestamp();
      await logMod(message.guild, logEmbed);

      // Alert if 1 life left
      if (newLives === 1) {
        const alertEmbed = new EmbedBuilder()
          .setTitle("🚨 Life Alert: 1 Life Remaining")
          .setColor(0xff6600)
          .addFields(
            { name: "👤 User",   value: `${member} — \`${member.user.tag}\`\nID: \`${member.id}\``, inline: false },
            { name: "⚠️ Status", value: "This user has **1 life left**. Next spam offense = auto-kick.", inline: false },
          )
          .setTimestamp();
        await logMod(message.guild, alertEmbed);
      }

      // 0 lives → kick (or ban if they've been kicked before)
      if (newLives <= 0) {
        if (kickedUsers.has(userId)) {
          // Repeat offender — ban
          await message.guild.members.ban(userId, { reason: "Auto-mod: repeat spam offender (0 lives, previously kicked)" }).catch(() => {});
          kickedUsers.delete(userId);
          const banEmbed = new EmbedBuilder()
            .setTitle("🔨 Auto-Mod: Member Banned")
            .setColor(0xed4245)
            .addFields(
              { name: "👤 User",   value: `\`${member.user.tag}\`\nID: \`${userId}\``,               inline: false },
              { name: "📄 Reason", value: "Repeat spam offender — 0 lives after previous auto-kick.", inline: false },
            )
            .setTimestamp();
          await logMod(message.guild, banEmbed);
        } else {
          // First 0-lives offense — kick
          kickedUsers.add(userId);
          await member.kick("Auto-mod: 0 lives remaining").catch(() => {});
          const kickEmbed = new EmbedBuilder()
            .setTitle("👢 Auto-Mod: Member Kicked (0 Lives)")
            .setColor(0xed4245)
            .addFields(
              { name: "👤 User",   value: `\`${member.user.tag}\`\nID: \`${userId}\``,                      inline: false },
              { name: "📄 Reason", value: "Reached 0 lives from repeated spam. Rejoining and spamming = ban.", inline: false },
            )
            .setTimestamp();
          await logMod(message.guild, kickEmbed);
        }
      } else {
        message.channel.send({ content: `⚠️ ${member}, you've been timed out for spamming. ❤️ **${newLives}/${MAX_LIVES} lives** remaining.` })
          .then((m) => setTimeout(() => m.delete().catch(() => {}), 8000)).catch(() => {});
      }
    } catch (err) { console.error("Auto-mod error:", err.message); }
    return;
  }

  // ── Welcome back bonus (3+ days of absence) ────────────────────────────────
  const seenAt = lastSeen.get(userId) ?? 0;
  const daysSince = (now - seenAt) / (1000 * 60 * 60 * 24);
  if (seenAt > 0 && daysSince >= WELCOME_BACK_DAYS) {
    const bonus = Math.round(daysSince) * 50; // 50 coins per missed day, up to 500
    const finalBonus = Math.min(bonus, 500);
    addCoins(userId, finalBonus);
    message.channel.send({
      content: `👋 Welcome back, ${message.author}! You've been away for ${Math.round(daysSince)} days — here's **${finalBonus} bonus coins** to get you back in the game!`,
    }).then((m) => setTimeout(() => m.delete().catch(() => {}), 15000)).catch(() => {});
  }
  lastSeen.set(userId, now);

  // ── Coin earn (30s cooldown) ────────────────────────────────────────────────
  const lastCoin = lastMsgCoin.get(userId) ?? 0;
  if (now - lastCoin >= 30_000) {
    const base = Math.floor(Math.random() * 4) + 2; // 2–5
    addCoins(userId, base, message.channelId);
    lastMsgCoin.set(userId, now);
  }

  // ── XP earn (60s cooldown) ─────────────────────────────────────────────────
  const lastXP = lastMsgXP.get(userId) ?? 0;
  if (now - lastXP >= 60_000) {
    const base = Math.floor(Math.random() * 11) + 10; // 10–20
    const member = message.member || await message.guild.members.fetch(userId).catch(() => null);
    if (member) await addXP(member, base, message.channelId);
    lastMsgXP.set(userId, now);
  }

  // ── Surprise drop (3% chance per message) ──────────────────────────────────
  if (!botSilenced && Math.random() < 0.03) {
    const drop = Math.floor(Math.random() * 151) + 50; // 50–200
    addCoins(userId, drop);
    message.channel.send({
      content: `🎁✨🎉 **SURPRISE DROP!** 💰 ${message.author} just snagged **${drop} bonus coins** 🪙💸 — lucky duck! 🍀 Keep chatting to score more! 🔥💬`,
    }).then((m) => setTimeout(() => m.delete().catch(() => {}), 12000)).catch(() => {});
  }

  // ── Message count + challenge tracking + achievements ──────────────────────
  const newMsgCount = (msgCount.get(userId) ?? 0) + 1;
  msgCount.set(userId, newMsgCount);
  bumpProfile(userId, "msgs");
  const challengeComplete = updateChallenge(userId, "msgs");
  if (challengeComplete) {
    const member = message.member || await message.guild.members.fetch(userId).catch(() => null);
    addCoins(userId, CHALLENGE_REWARD.coins);
    if (member) await addXP(member, CHALLENGE_REWARD.xp);
    message.channel.send({
      content: `🎯 ${message.author} completed all **daily challenges** and earned **${CHALLENGE_REWARD.coins} coins + ${CHALLENGE_REWARD.xp} XP**!`,
    }).then((m) => setTimeout(() => m.delete().catch(() => {}), 15000)).catch(() => {});
  }
  // Achievement & streak checks
  {
    const member = message.member || await message.guild.members.fetch(userId).catch(() => null);
    if (member) {
      await checkAchievements(member, "msgs", newMsgCount, message.guild);
      await checkAchievements(member, "totalCoins", getCoins(userId), message.guild);
      await updateLoginStreak(member, message.guild);
    }
  }

  // ── Context-aware suggestions (strict patterns, 5-min cooldown per channel) ──
  const chName = baseName(message.channel.name ?? "");
  const blocked = HINT_BLOCKED_NAMES.some((n) => chName.includes(n));
  if (!blocked && !botSilenced) {
    const lastHint = hintCooldown.get(message.channelId) ?? 0;
    if (now - lastHint > HINT_COOLDOWN_MS) {
      for (const { test, hint } of KEYWORD_HINTS) {
        if (test.test(content)) {
          hintCooldown.set(message.channelId, now);
          message.channel.send({ content: hint })
            .then((m) => setTimeout(() => m.delete().catch(() => {}), 15000))
            .catch(() => {});
          break;
        }
      }
    }
  }

  // ── AI chat: reply when bot is @mentioned OR user replies to a bot message ───
  const isMention   = message.mentions.has(client.user);
  const isReplyToBot = message.reference?.messageId &&
    (await message.channel.messages.fetch(message.reference.messageId).catch(() => null))?.author?.id === client.user?.id;

  if (openai && !botSilenced && !message.author.bot && (isMention || isReplyToBot)) {
    // Only in channels verified members can access (not staff/mod/log/ticket/admin)
    const STAFF_KEYWORDS = ["staff", "mod", "admin", "log", "ticket", "verify", "welcome", "goodbye", "rules", "announcements", "updates"];
    const chBaseName = baseName(message.channel.name ?? "");
    if (STAFF_KEYWORDS.some(k => chBaseName.includes(k))) return;

    // Strip the bot mention from the prompt
    const prompt = content.replace(/<@!?\d+>/g, "").trim();
    if (!prompt) {
      message.reply({ content: "Yo! Tag me with a message and I'll vibe with you 🎮", allowedMentions: { repliedUser: false } }).catch(() => {});
      return;
    }

    // Load/update conversation history for this user
    let hist = aiHistory.get(userId);
    if (!hist || now - hist.lastTs > AI_HISTORY_TTL) {
      hist = { messages: [], lastTs: now };
    }
    hist.messages.push({ role: "user", content: prompt });
    // Trim to max length (keep most recent)
    if (hist.messages.length > AI_HISTORY_MAX) hist.messages = hist.messages.slice(-AI_HISTORY_MAX);
    hist.lastTs = now;
    aiHistory.set(userId, hist);

    const username = message.member?.displayName ?? message.author.username;

    try {
      await message.channel.sendTyping();
      const response = await openai.chat.completions.create({
        model: AI_MODEL,
        max_tokens: 500,
        temperature: 0.95,
        presence_penalty: 0.6,
        frequency_penalty: 0.4,
        messages: [
          {
            role: "system",
            content:
              `You are the CASES | Beta Discord bot — a chill, hype, super interactive Gen-Z friend hanging out in the CASES Beta Roblox game community. ` +
              `You're talking to **${username}** right now in #${message.channel.name}. ` +
              `\n\n## Personality\n` +
              `- Be playful, witty, a little sarcastic, and ENGAGED — react to what people say like a real friend would. ` +
              `Use slang naturally (fr, ngl, lowkey, bro, gg, W, L, bet, no cap, sheesh) but don't overdo it. ` +
              `Roast lightly when appropriate, hype people up when they share wins, sympathize when they're frustrated. ` +
              `\n- Match the user's energy — if they're hyped, be hyped; if they ask a serious question, answer seriously. ` +
              `Use 1-3 emojis per reply MAX (not flooded). ` +
              `\n- Ask follow-up questions sometimes to keep convos going. ` +
              `\n- Keep replies SHORT (1-3 sentences usually). Long answers only when really needed. ` +
              `\n\n## What you know\n` +
              `- The CASES Beta Roblox game (cases, drops, trading, grinding). ` +
              `- This Discord server's economy: /balance, /daily, /weekly, /shop, /buy, /inventory, /equip, /rank, /leaderboard, /achievements, /challenges, /serverstats, /invites, /ticket. ` +
              `- XP/coins are earned by chatting & voice. Drop zones give 2x rewards. /boost gives 30min server-wide 2x. ` +
              `- Level roles: 5=Active, 10=Regular, 20=Veteran, 50=Elite. ` +
              `\n\n## Rules\n` +
              `- NEVER make up game details, prices, items, or features you don't know. If unsure, say "ngl idk for sure, ask staff" or similar. ` +
              `- Don't be cringe or fake-deep. Don't lecture. ` +
              `- Don't break character — you're the server's bot, not "an AI assistant". ` +
              `- Remember the convo context — refer back to what was said earlier when relevant.`,
          },
          ...hist.messages,
        ],
      });
      const reply = response.choices[0]?.message?.content?.trim();
      if (!reply) {
        await message.reply({ content: "huh, blank reply from the AI — try rephrasing?", allowedMentions: { repliedUser: false } });
        return;
      }
      // Store assistant reply in history
      hist.messages.push({ role: "assistant", content: reply });
      if (hist.messages.length > AI_HISTORY_MAX) hist.messages = hist.messages.slice(-AI_HISTORY_MAX);
      aiHistory.set(userId, hist);
      await message.reply({ content: reply, allowedMentions: { repliedUser: false } });
    } catch (err) {
      console.error("[AI Chat] OpenAI error:", err.status, err.code, err.message);
      // Surface the real reason so you can actually fix it
      let reason = "something went wrong on OpenAI's end";
      if (err.status === 401) reason = "the OpenAI API key is invalid or missing — check `OPENAI_API_KEY` on Railway";
      else if (err.status === 429) reason = "rate limited or out of OpenAI credits — top up the OpenAI account";
      else if (err.status === 404) reason = "the AI model isn't available on this OpenAI account";
      else if (err.status >= 500) reason = "OpenAI's servers are having issues — try again in a min";
      else if (err.code === "insufficient_quota") reason = "the OpenAI account is out of credits — top it up at platform.openai.com/billing";
      message.reply({ content: `🤖 AI's down rn: **${reason}**.`, allowedMentions: { repliedUser: false } }).catch(() => {});
    }
    return;
  }
});

// ── Voice state → XP + Join-to-Create ─────────────────────────────────────────

client.on("voiceStateUpdate", async (oldState, newState) => {
  const member = newState.member ?? oldState.member;
  const userId = member?.id;
  if (!userId || member?.user.bot) return;

  const guild = newState.guild ?? oldState.guild;
  const joinedChannel   = !oldState.channelId && newState.channelId;
  const leftChannel     = oldState.channelId  && !newState.channelId;
  const switchedChannel = oldState.channelId  && newState.channelId && oldState.channelId !== newState.channelId;

  if (joinedChannel || switchedChannel) voiceJoined.set(userId, Date.now());
  if (leftChannel) voiceJoined.delete(userId);

  // Log voice activity
  const logCh = getLogChannel(guild);
  if (logCh) {
    if (joinedChannel) {
      const embed = new EmbedBuilder()
        .setTitle("🔵 Voice Joined")
        .setColor(0x5865f2)
        .addFields(
          { name: "👤 User",     value: `${member} — \`${member.user.tag}\``, inline: false },
          { name: "🔊 Channel",  value: `${newState.channel}`,                 inline: true },
        )
        .setTimestamp();
      logCh.send({ embeds: [embed] }).catch(() => {});
    } else if (leftChannel) {
      const embed = new EmbedBuilder()
        .setTitle("🔵 Voice Left")
        .setColor(0x5865f2)
        .addFields(
          { name: "👤 User",     value: `${member} — \`${member.user.tag}\``, inline: false },
          { name: "🔇 Channel",  value: `${oldState.channel}`,                 inline: true },
        )
        .setTimestamp();
      logCh.send({ embeds: [embed] }).catch(() => {});
    } else if (switchedChannel) {
      const embed = new EmbedBuilder()
        .setTitle("🔵 Voice Switched")
        .setColor(0x5865f2)
        .addFields(
          { name: "👤 User",    value: `${member} — \`${member.user.tag}\``, inline: false },
          { name: "🔇 From",    value: `${oldState.channel}`,                 inline: true },
          { name: "🔊 To",      value: `${newState.channel}`,                 inline: true },
        )
        .setTimestamp();
      logCh.send({ embeds: [embed] }).catch(() => {});
    }
  }

  // Join-to-Create
  if (newState.channel && baseName(newState.channel.name).includes("create a room")) {
    try {
      const newCh = await guild.channels.create({
        name: `🔊 ${member.displayName}'s Room`,
        type: ChannelType.GuildVoice,
        parent: newState.channel.parent?.id ?? null,
        userLimit: 10,
      });
      tempVoiceChans.add(newCh.id);
      await newState.setChannel(newCh);
      console.log(`Created temp VC "${newCh.name}" for ${member.displayName}`);
    } catch (err) { console.error("Join-to-Create error:", err.message); }
  }

  // Auto-delete empty temp VCs
  if (oldState.channelId && tempVoiceChans.has(oldState.channelId)) {
    const ch = guild.channels.cache.get(oldState.channelId);
    if (ch && ch.members.size === 0) {
      try { await ch.delete("Temp room empty"); tempVoiceChans.delete(oldState.channelId); }
      catch { /* already gone */ }
    }
  }
});

// ── Reactions → giveaways + sessions ─────────────────────────────────────────

client.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial)         { try { await reaction.fetch();         } catch { return; } }
  if (reaction.message.partial) { try { await reaction.message.fetch(); } catch { return; } }

  const channelName = reaction.message.channel?.name?.toLowerCase() ?? "";

  // Enforce reaction-only channels
  if (channelName.includes("verify") || channelName.includes("reaction-roles")) {
    try { await reaction.users.remove(user.id); } catch { /* ignore */ }
    return;
  }

  // Giveaway entry
  const gw = giveaways.get(reaction.message.id);
  if (gw && reaction.emoji.name === "🎉") {
    if (!gw.entrants.includes(user.id)) gw.entrants.push(user.id);
    return;
  }

  // Session join
  const session = sessions.get(reaction.message.id);
  if (session && reaction.emoji.name === "🎮") {
    if (!session.participants.includes(user.id)) {
      session.participants.push(user.id);
      addCoins(user.id, 20);
      updateChallenge(user.id, "sessionJoin");
      bumpProfile(user.id, "social");
    }
    return;
  }
});

// ── Member join → invite tracking + welcome ───────────────────────────────────

client.on("guildMemberAdd", async (member) => {
  const guild = member.guild;

  // ── Anti-raid detection (10+ joins in 30 seconds) ──────────────────────────
  const now = Date.now();
  recentJoins.push(now);
  while (recentJoins.length > 0 && now - recentJoins[0] > 30_000) recentJoins.shift();

  if (recentJoins.length >= 10 && !raidLocked) {
    raidLocked = true;
    try {
      // Lock all text channels except safe ones (verify, ticket, welcome, rules…)
      const textChannels = guild.channels.cache.filter(c =>
        c.type === ChannelType.GuildText && !lockedChannels.has(c.id) && !isSafeChannel(c)
      );
      for (const [, ch] of textChannels) {
        const current = ch.permissionOverwrites.cache.map(ow => ({
          id: ow.id, type: ow.type, allow: ow.allow.bitfield, deny: ow.deny.bitfield,
        }));
        const locked = current.map(ow =>
          ow.type === 0
            ? { id: ow.id, type: ow.type, allow: ow.allow & ~LOCK_BITS, deny: ow.deny | LOCK_BITS }
            : { id: ow.id, type: ow.type, allow: ow.allow, deny: ow.deny }
        );
        if (!locked.some(ow => ow.id === guild.id)) {
          locked.push({ id: guild.id, type: 0, allow: 0n, deny: LOCK_BITS });
        }
        lockedChannels.set(ch.id, { savedOverwrites: current, reason: "Anti-raid lockdown" });
        ch.permissionOverwrites.set(locked).catch(() => {});
      }

      // Find a staff/admin channel or log channel to send alert
      const alertCh = findChannel(guild, "staff") ?? findChannel(guild, "admin") ?? getLogChannel(guild);
      const staffRole = guild.roles.cache.find(r =>
        ["staff", "mod", "moderator", "admin"].some(k => r.name.toLowerCase().includes(k)) && !r.managed
      );
      const pingContent = staffRole ? `<@&${staffRole.id}> 🚨 RAID ALERT` : `🚨 RAID ALERT`;

      const raidEmbed = new EmbedBuilder()
        .setTitle("🚨 RAID DETECTED — Server Locked")
        .setColor(0xff0000)
        .addFields(
          { name: "⚠️ Trigger",   value: `${recentJoins.length} members joined within 30 seconds`, inline: false },
          { name: "🔒 Action",    value: "All text channels locked. Use `/unlock` or `/forceopen` per channel to restore.", inline: false },
          { name: "📋 Next Step", value: "Review new members, then run `/forceopen` on each channel when safe.",           inline: false },
        )
        .setTimestamp();
      if (alertCh) alertCh.send({ content: pingContent, embeds: [raidEmbed] }).catch(() => {});
      await logMod(guild, raidEmbed);

      // Auto-unlock after 10 minutes if still raid-locked
      setTimeout(async () => {
        if (!raidLocked) return;
        raidLocked = false;
        for (const [, ch] of textChannels) {
          const saved = lockedChannels.get(ch.id);
          if (saved?.reason === "Anti-raid lockdown") {
            ch.permissionOverwrites.set(saved.savedOverwrites).catch(() => {});
            lockedChannels.delete(ch.id);
          }
        }
        const unlockEmbed = new EmbedBuilder()
          .setTitle("🔓 Raid Lockdown Lifted (Auto)")
          .setColor(0x57f287)
          .setDescription("10 minutes have passed. Server channels automatically unlocked.")
          .setTimestamp();
        await logMod(guild, unlockEmbed);
      }, 10 * 60 * 1000);

    } catch (err) { console.error("Anti-raid error:", err.message); }
  }

  // Invite tracking
  try {
    const newInvites = await guild.invites.fetch();
    const cached = inviteCache.get(guild.id) ?? new Map();
    let inviter = null;
    for (const inv of newInvites.values()) {
      if ((inv.uses ?? 0) > (cached.get(inv.code) ?? 0)) {
        inviter = inv.inviter;
        const newInvCount = (inviteCount.get(inviter.id) ?? 0) + 1;
        inviteCount.set(inviter.id, newInvCount);
        inviteBy.set(member.id, inviter.id);
        // Achievement tracking for invites
        const inviterMember = guild.members.cache.get(inviter.id);
        if (inviterMember) await checkAchievements(inviterMember, "invites", newInvCount, guild).catch(() => {});
        break;
      }
    }
    const map = new Map();
    newInvites.forEach((i) => map.set(i.code, i.uses));
    inviteCache.set(guild.id, map);

    const logCh = getLogChannel(guild);
    if (logCh) {
      const embed = new EmbedBuilder()
        .setTitle("🟢 Member Joined")
        .setColor(0x57f287)
        .setThumbnail(member.user.displayAvatarURL())
        .addFields(
          { name: "👤 User",            value: `${member} — \`${member.user.tag}\`\nID: \`${member.id}\``, inline: false },
          { name: "📅 Account Created", value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:F>`, inline: true },
          { name: "📥 Joined At",       value: `<t:${Math.floor(Date.now() / 1000)}:F>`,                   inline: true },
          { name: "🔗 Invited By",      value: inviter ? `<@${inviter.id}> (${inviteCount.get(inviter.id) ?? 1} total invites)` : "Unknown", inline: false },
        )
        .setFooter({ text: `Member #${guild.memberCount}` })
        .setTimestamp();
      logCh.send({ embeds: [embed] }).catch(() => {});
    }
  } catch { /* missing permissions */ }

  // Welcome message
  const welcomeCh = findChannel(guild, "welcome");
  if (welcomeCh) {
    const verifyCh  = findChannel(guild, "verification") ?? findChannel(guild, "verify");
    const generalCh = guild.channels.cache.find(c =>
      c.type === ChannelType.GuildText && baseName(c.name) === "general"
    ) ?? guild.channels.cache.find(c =>
      c.type === ChannelType.GuildText && baseName(c.name) === "chat"
    );
    const rulesCh = findChannel(guild, "rules");
    const embed = new EmbedBuilder()
      .setTitle(`🎉 Welcome to ${guild.name}, ${member.user.username}!`)
      .setDescription(
        `Hey ${member}, glad you're here! You're member **#${guild.memberCount}**.\n\n` +
        `**Get started:**\n` +
        `**1.** Head to ${rulesCh ?? "**#rules**"} so you know what's good\n` +
        `**2.** Verify in ${verifyCh ?? "**#verification**"} to unlock the server\n` +
        `**3.** Say hi in ${generalCh ?? "**#general-chat**"}\n` +
        `**4.** Chat to earn XP & coins — climb the leaderboard\n\n` +
        `🎮 **[Play CASES Beta on Roblox →](https://www.roblox.com/games/106780119627121/CASES-Beta)**`
      )
      .setColor(0x5865f2)
      .setThumbnail(member.user.displayAvatarURL())
      .setFooter({ text: `${guild.name} • We're happy you're here!` })
      .setTimestamp();
    welcomeCh.send({ content: `${member}`, embeds: [embed] }).catch(() => {});

    // ── DM the new member a personal welcome ─────────────────────────────────
    const dmEmbed = new EmbedBuilder()
      .setTitle(`👋 Welcome to ${guild.name}!`)
      .setDescription(
        `Hey **${member.user.username}**, we're so glad you're here!\n\n` +
        `Here's how to get started:\n\n` +
        `**1. Read the rules** — Head to the #rules channel and click **I Agree** to unlock the server.\n` +
        `**2. Introduce yourself** — Say hi in #general-chat once you're verified!\n` +
        `**3. Earn coins & XP** — Just chat, join voice, and complete daily challenges to level up.\n` +
        `**4. Visit the shop** — Use \`/shop\` to browse roles and perks you can buy with your coins.\n\n` +
        `**Server Rules (quick summary):**\n` +
        `• Be respectful to everyone\n` +
        `• No spam, harassment, or slurs\n` +
        `• Keep content appropriate\n` +
        `• No advertising without permission\n` +
        `• Follow Discord's Terms of Service\n\n` +
        `🎮 We're the Cases community — enjoy your stay!\n` +
        `**[Play CASES Beta on Roblox →](https://www.roblox.com/games/106780119627121/CASES-Beta)**`
      )
      .setColor(0x5865f2)
      .setThumbnail(guild.iconURL() ?? member.user.displayAvatarURL())
      .setFooter({ text: `${guild.name} • DM a staff member if you need help!` })
      .setTimestamp();
    member.user.send({ embeds: [dmEmbed] }).catch(() => {}); // silently ignore if DMs are closed
  }

  // ── Auto-assign Unverified Member role ──────────────────────────────────────
  try {
    const unverifiedRole = guild.roles.cache.find(r =>
      ["unverified member", "unverified"].includes(r.name.toLowerCase())
    );
    if (unverifiedRole) {
      await member.roles.add(unverifiedRole, "🔴 Auto-assigned on join").catch(() => {});
    }
  } catch { /* ignore */ }

  // ── OG role: auto-give to the first 50 members only (Head Mod gives after) ──
  try {
    const ogRole = guild.roles.cache.find(r => baseName(r.name) === "og" || baseName(r.name) === "ogmember");
    if (ogRole) {
      await guild.members.fetch().catch(() => {});
      const ogCount = guild.members.cache.filter(m => m.roles.cache.has(ogRole.id)).size;
      if (ogCount < 50) {
        await member.roles.add(ogRole, "🌟 OG Member — one of the first 50!").catch(() => {});
      }
    }
  } catch { /* ignore */ }
});

// ── Member leave ───────────────────────────────────────────────────────────────

client.on("guildMemberRemove", async (member) => {
  const guild = member.guild;
  const verifiedRole = guild.roles.cache.find((r) => ["verified", "member"].includes(r.name.toLowerCase()));

  // Goodbye embed — send for all members (not just verified) so no one slips through silently
  const goodbyeCh = findChannel(guild, "goodbye");
  if (goodbyeCh) {
    const embed = CHANNEL_MESSAGES["goodbye"](guild, member);
    goodbyeCh.send({ embeds: [embed] }).catch(() => {});
  }

  // Staff log — only for verified members (skip unverified who never joined properly)
  if (verifiedRole && !member.roles.cache.has(verifiedRole.id)) return;

  const logCh = getLogChannel(guild);
  if (logCh) {
    const embed = new EmbedBuilder()
      .setTitle("🔴 Member Left")
      .setColor(0xed4245)
      .setThumbnail(member.user.displayAvatarURL())
      .addFields(
        { name: "👤 User",      value: `${member} — \`${member.user.tag}\`\nID: \`${member.id}\``, inline: false },
        { name: "📤 Left At",   value: `<t:${Math.floor(Date.now() / 1000)}:F>`,                    inline: true },
        { name: "🎭 Roles",     value: member.roles.cache.filter(r => r.id !== guild.id).map(r => r.name).join(", ") || "None", inline: false },
      )
      .setTimestamp();
    logCh.send({ embeds: [embed] }).catch(() => {});
  }
});

// ── Message deleted → log ──────────────────────────────────────────────────────

client.on("messageDelete", async (message) => {
  if (!message.guild || message.author?.bot) return;
  const logCh = getLogChannel(message.guild);
  if (!logCh) return;
  const content = message.content || "*No text content*";
  const embed = new EmbedBuilder()
    .setTitle("🔴 Message Deleted")
    .setColor(0xed4245)
    .addFields(
      { name: "👤 Author",   value: message.author ? `${message.author} — \`${message.author.tag}\`\nID: \`${message.author.id}\`` : "Unknown", inline: false },
      { name: "📍 Channel",  value: `${message.channel}`, inline: true },
      { name: "📝 Content",  value: content.length > 1024 ? content.slice(0, 1021) + "..." : content, inline: false },
    )
    .setTimestamp();
  logCh.send({ embeds: [embed] }).catch(() => {});
});

// ── Message edited → log ───────────────────────────────────────────────────────

client.on("messageUpdate", async (oldMessage, newMessage) => {
  if (!newMessage.guild || newMessage.author?.bot) return;
  if (oldMessage.content === newMessage.content) return;
  const logCh = getLogChannel(newMessage.guild);
  if (!logCh) return;
  const before = oldMessage.content || "*No content*";
  const after  = newMessage.content || "*No content*";
  const embed = new EmbedBuilder()
    .setTitle("🟡 Message Edited")
    .setColor(0xfee75c)
    .addFields(
      { name: "👤 Author",   value: `${newMessage.author} — \`${newMessage.author.tag}\`\nID: \`${newMessage.author.id}\``, inline: false },
      { name: "📍 Channel",  value: `${newMessage.channel}`,                                                                  inline: true },
      { name: "🔗 Jump",     value: `[View Message](${newMessage.url})`,                                                       inline: true },
      { name: "✏️ Before",   value: before.length > 512 ? before.slice(0, 509) + "..." : before,                              inline: false },
      { name: "✏️ After",    value: after.length  > 512 ? after.slice(0, 509)  + "..." : after,                               inline: false },
    )
    .setTimestamp();
  logCh.send({ embeds: [embed] }).catch(() => {});
});

// ── Role added / removed → log ─────────────────────────────────────────────────

client.on("guildMemberUpdate", async (oldMember, newMember) => {
  const guild  = newMember.guild;

  const addedRoles   = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id) && r.id !== guild.id);
  const removedRoles = oldMember.roles.cache.filter(r => !newMember.roles.cache.has(r.id) && r.id !== guild.id);
  if (addedRoles.size === 0 && removedRoles.size === 0) return;

  // ── OG role guard: if Verified was just added, restore OG if member qualifies ──
  const verifiedJustAdded = addedRoles.some(r => r.name.toLowerCase() === "verified");
  if (verifiedJustAdded) {
    const ogRole = guild.roles.cache.find(r => baseName(r.name) === "og" || baseName(r.name) === "ogmember");
    if (ogRole && !newMember.roles.cache.has(ogRole.id)) {
      try {
        await guild.members.fetch().catch(() => {});
        const sorted = [...guild.members.cache.values()]
          .filter(m => !m.user.bot && m.joinedTimestamp)
          .sort((a, b) => a.joinedTimestamp - b.joinedTimestamp);
        const isOG = sorted.slice(0, 50).some(m => m.id === newMember.id);
        if (isOG) await newMember.roles.add(ogRole, "🌟 OG role restored after verification").catch(() => {});
      } catch { /* ignore */ }
    }
  }

  // ── Auto-remove Unverified Member when Verified role is added ──────────────
  // Triggered by Rover, admin, or any external source — not just the agree_rules button.
  if (verifiedJustAdded && !verificationProcessing.has(newMember.id)) {
    const unverifiedRole = guild.roles.cache.find(r =>
      ["unverified member", "unverified"].includes(r.name.toLowerCase())
    );
    if (unverifiedRole && newMember.roles.cache.has(unverifiedRole.id)) {
      verificationProcessing.add(newMember.id);
      try {
        await newMember.roles.remove(unverifiedRole, "Auto-removed: Verified role was granted");
        console.log(`[Verification] Removed Unverified Member from ${newMember.user.tag}`);
      } catch (e) {
        console.error("[Verification] Failed to remove Unverified role:", e.message);
      } finally {
        setTimeout(() => verificationProcessing.delete(newMember.id), 5000);
      }
    }
  }

  // ── Single merged log embed per update ──────────────────────────────────────
  const logCh = getLogChannel(guild);
  if (!logCh) return;

  const fields = [
    { name: "👤 User", value: `${newMember} — \`${newMember.user.tag}\`\nID: \`${newMember.id}\``, inline: false },
  ];
  if (addedRoles.size > 0)   fields.push({ name: "✅ Role(s) Added",   value: addedRoles.map(r => `<@&${r.id}>`).join(", "),   inline: false });
  if (removedRoles.size > 0) fields.push({ name: "❌ Role(s) Removed", value: removedRoles.map(r => `<@&${r.id}>`).join(", "), inline: false });

  const embed = new EmbedBuilder()
    .setTitle("⚫ Member Roles Updated")
    .setColor(0x99aab5)
    .addFields(...fields)
    .setTimestamp();
  logCh.send({ embeds: [embed] }).catch(() => {});
});

// ── Guild create → cache invites ───────────────────────────────────────────────

client.on("guildCreate", async (guild) => {
  try {
    const invites = await guild.invites.fetch();
    const map = new Map();
    invites.forEach((inv) => map.set(inv.code, inv.uses));
    inviteCache.set(guild.id, map);
  } catch { /* ignore */ }
});

// ── Interactions ───────────────────────────────────────────────────────────────

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() && !interaction.isButton()) return;

  const commandName = interaction.isChatInputCommand() ? interaction.commandName : null;
  console.log(`[Interaction] ${commandName ?? `button:${interaction.customId}`} from ${interaction.user?.tag} in ${interaction.guild?.name}`);

  try {

  // ── Channel restriction check ────────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {
    const required = CMD_CHANNEL[commandName];
    if (required) {
      const correctChannel = findChannel(interaction.guild, required);
      if (correctChannel && interaction.channelId !== correctChannel.id) {
        return interaction.reply({ content: `❌ Use this command in ${correctChannel}.`, flags: MessageFlags.Ephemeral });
      }
    }
  }

  // ── Head Admin guard ─────────────────────────────────────────────────────────
  // Returns true if the member has a role whose name matches "head admin" (case-insensitive)
  function isHeadAdmin(member) {
    if (!member) return false;
    return member.roles.cache.some((r) =>
      r.name.toLowerCase().replace(/[\s_-]+/g, "") === "headadmin"
    );
  }
  const HEAD_ADMIN_COMMANDS = [
    "setup-server", "test-update", "organize_server",
    "give-coins", "remove-coins", "setcoins",
    "givexp", "removexp", "setxp", "resetxp",
  ];
  if (commandName && HEAD_ADMIN_COMMANDS.includes(commandName) && !isHeadAdmin(interaction.member)) {
    return interaction.reply({
      content: "🚫 This command is restricted to **Head Admins** only.",
      flags: MessageFlags.Ephemeral,
    });
  }

  // ── Button: agree_rules ──────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "agree_rules") {
    const guild  = interaction.guild;
    const member = interaction.member;
    let memberRole = guild.roles.cache.find((r) => r.name.toLowerCase() === "member");
    if (!memberRole) {
      try {
        memberRole = await guild.roles.create({ name: "Member", color: 0x5865F2, reason: "Created by rules-agree button" });
      } catch {
        return interaction.reply({ content: "❌ Couldn't find or create a **Member** role. Ask an admin to create a role named `Member`.", flags: MessageFlags.Ephemeral });
      }
    }
    if (member.roles.cache.has(memberRole.id)) {
      return interaction.reply({ content: "✅ You already have the **Member** role!", flags: MessageFlags.Ephemeral });
    }
    try {
      await member.roles.add(memberRole);
      // Auto-remove Unverified Member role now that they're verified
      const unverifiedRole = guild.roles.cache.find((r) =>
        ["unverified member", "unverified"].includes(r.name.toLowerCase())
      );
      if (unverifiedRole && member.roles.cache.has(unverifiedRole.id)) {
        await member.roles.remove(unverifiedRole).catch(() => {});
      }
      return interaction.reply({ content: "✅ Welcome! You've been given the **Member** role and now have full access to the server. Enjoy! 🎉", flags: MessageFlags.Ephemeral });
    } catch {
      return interaction.reply({ content: "❌ Failed to assign the **Member** role. Make sure the bot's role is above **Member** in Server Settings → Roles.", flags: MessageFlags.Ephemeral });
    }
  }

  // ── Button: open_ticket ──────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "open_ticket") {
    const guild  = interaction.guild;
    const member = interaction.member;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Find or create a tickets category — look for existing support/tickets category first
    let category = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory &&
        (baseName(c.name) === "tickets" || baseName(c.name) === "support")
    );
    if (!category) {
      try {
        category = await guild.channels.create({ name: "Tickets", type: ChannelType.GuildCategory });
        // Fetch fresh guild channel list so the new category is in cache
        await guild.channels.fetch();
      } catch (err) {
        console.error("Ticket category creation failed:", err.message);
        return interaction.editReply({ content: `❌ Could not create Tickets category: ${err.message}` });
      }
    }

    const existing = guild.channels.cache.find(
      (c) => c.name === `ticket-${member.user.username.toLowerCase()}`
    );
    if (existing) return interaction.editReply({ content: `You already have an open ticket: ${existing}` });

    const staffRoles = guild.roles.cache.filter(
      (r) => r.permissions.has(PermissionFlagsBits.ManageGuild) && !r.managed && r.id !== guild.id
    );
    const overwrites = [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
      { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] },
    ];
    for (const [, role] of staffRoles) {
      overwrites.push({ id: role.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] });
    }

    try {
      const ticketCh = await guild.channels.create({
        name: `ticket-${member.user.username.toLowerCase()}`,
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: overwrites,
      });

      console.log(`Ticket "${ticketCh.name}" created under category "${category.name}" (${category.id})`);

      const embed = new EmbedBuilder()
        .setTitle("🎫 Support Ticket")
        .setDescription(`Hello ${member}, welcome to your support ticket!\n\nDescribe your issue and a staff member will help shortly.`)
        .setColor(0x5865f2)
        .setFooter({ text: `Opened by ${member.user.username}` })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("close_ticket").setLabel("Close Ticket").setStyle(ButtonStyle.Danger).setEmoji("🔒")
      );

      await ticketCh.send({ embeds: [embed], components: [row] });
      await interaction.editReply({ content: `✅ Your ticket has been created: ${ticketCh}` });
    } catch (err) {
      console.error("Error creating ticket:", err.message);
      await interaction.editReply({ content: `❌ Something went wrong: ${err.message}` });
    }
    return;
  }

  // ── Button: close_ticket ─────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "close_ticket") {
    const channel  = interaction.channel;
    const category = channel.parent;
    const embed = new EmbedBuilder()
      .setDescription(`🔒 Ticket closed by **${interaction.user.username}**. Channel deletes in 5 seconds...`)
      .setColor(0xed4245);
    await interaction.reply({ embeds: [embed] });
    setTimeout(async () => {
      try {
        await channel.delete();
        if (category && category.children.cache.size === 0) await category.delete();
      } catch (err) { console.error("Error deleting ticket channel:", err.message); }
    }, 5000);
    return;
  }

  // ── /ticket (slash command fallback) ─────────────────────────────────────────
  if (commandName === "ticket") {
    const guild  = interaction.guild;
    const member = interaction.member;

    // Redirect to create-ticket if the user isn't already there
    const ticketCmdCh = findChannel(guild, "create-ticket") ?? findChannel(guild, "support");
    if (ticketCmdCh && interaction.channelId !== ticketCmdCh.id) {
      return interaction.reply({ content: `Please open tickets in ${ticketCmdCh} using the **Open Ticket** button.`, flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let category = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory &&
        (baseName(c.name) === "tickets" || baseName(c.name) === "support")
    );
    if (!category) {
      try { category = await guild.channels.create({ name: "Tickets", type: ChannelType.GuildCategory }); }
      catch (err) { return interaction.editReply({ content: `❌ Could not create Tickets category: ${err.message}` }); }
    }

    const existing = guild.channels.cache.find(
      (c) => c.name === `ticket-${member.user.username.toLowerCase()}`
    );
    if (existing) return interaction.editReply({ content: `You already have an open ticket: ${existing}` });

    const staffRoles = guild.roles.cache.filter(
      (r) => r.permissions.has(PermissionFlagsBits.ManageGuild) && !r.managed && r.id !== guild.id
    );
    const overwrites = [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
      { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] },
    ];
    for (const [, role] of staffRoles) {
      overwrites.push({ id: role.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] });
    }

    try {
      const ticketCh = await guild.channels.create({
        name: `ticket-${member.user.username.toLowerCase()}`,
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: overwrites,
      });
      const embed = new EmbedBuilder()
        .setTitle("🎫 Support Ticket")
        .setDescription(`Hello ${member}, welcome to your support ticket!\n\nDescribe your issue and a staff member will help shortly.`)
        .setColor(0x5865f2)
        .setFooter({ text: `Opened by ${member.user.username}` })
        .setTimestamp();
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("close_ticket").setLabel("Close Ticket").setStyle(ButtonStyle.Danger).setEmoji("🔒")
      );
      await ticketCh.send({ embeds: [embed], components: [row] });
      await interaction.editReply({ content: `✅ Your ticket has been created: ${ticketCh}` });
    } catch (err) {
      console.error("Error creating ticket:", err.message);
      await interaction.editReply({ content: `❌ Something went wrong: ${err.message}` });
    }
    return;
  }

  // ── /lock ─────────────────────────────────────────────────────────────────────
  if (commandName === "lock") {
    const isOwner   = interaction.user.id === interaction.guild.ownerId;
    const isHeadMod = interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);
    if (!isOwner && !isHeadMod) {
      return interaction.reply({ content: "❌ Only the server owner and head moderators can use this command.", flags: MessageFlags.Ephemeral });
    }

    const target = interaction.options.getChannel("channel") ?? interaction.channel;
    const reason = interaction.options.getString("reason") ?? "No reason provided";

    if (lockedChannels.has(target.id)) {
      return interaction.reply({ content: `🔒 ${target} is already locked.`, flags: MessageFlags.Ephemeral });
    }
    if (isSafeChannel(target)) {
      return interaction.reply({ content: `⚠️ **${target}** is a protected channel (verify/ticket/welcome/rules) and cannot be locked — members must always be able to access it.`, flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();

    try {
      // Save current overwrites as raw bitfields for perfect restore later
      const savedOverwrites = target.permissionOverwrites.cache.map(ow => ({
        id: ow.id, type: ow.type, allow: ow.allow.bitfield, deny: ow.deny.bitfield,
      }));
      lockedChannels.set(target.id, { savedOverwrites, reason });

      // Build the locked overwrite list — ONE bulk set() call instead of a loop
      const newOverwrites = savedOverwrites.map(ow =>
        ow.type === 0
          ? { id: ow.id, type: ow.type, allow: ow.allow & ~LOCK_BITS, deny: ow.deny | LOCK_BITS }
          : { id: ow.id, type: ow.type, allow: ow.allow, deny: ow.deny }
      );
      // Ensure @everyone is explicitly covered even if it had no overwrite
      if (!newOverwrites.some(ow => ow.id === interaction.guild.id)) {
        newOverwrites.push({ id: interaction.guild.id, type: 0, allow: 0n, deny: LOCK_BITS });
      }
      await target.permissionOverwrites.set(newOverwrites);

      const embed = new EmbedBuilder()
        .setTitle("🔒 Channel Locked")
        .setColor(0xed4245)
        .addFields(
          { name: "📍 Channel", value: `${target}`,                                             inline: true },
          { name: "🛠️ By",     value: `${interaction.user} — \`${interaction.user.tag}\``,      inline: true },
          { name: "📄 Reason",  value: reason,                                                   inline: false },
          { name: "📝 Action",  value: "Members can no longer send messages in this channel.",   inline: false },
        )
        .setTimestamp();

      await logMod(interaction.guild, embed);
      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      lockedChannels.delete(target.id);
      return interaction.editReply({ content: `❌ Failed to lock: ${err.message}` });
    }
  }

  // ── /unlock ───────────────────────────────────────────────────────────────────
  if (commandName === "unlock") {
    const isOwner   = interaction.user.id === interaction.guild.ownerId;
    const isHeadMod = interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);
    if (!isOwner && !isHeadMod) {
      return interaction.reply({ content: "❌ Only the server owner and head moderators can use this command.", flags: MessageFlags.Ephemeral });
    }

    const target = interaction.options.getChannel("channel") ?? interaction.channel;

    await interaction.deferReply();

    // If bot restarted and lost memory, force-reset in one bulk call
    if (!lockedChannels.has(target.id)) {
      try {
        const resetOverwrites = target.permissionOverwrites.cache.map(ow =>
          ow.type === 0
            ? { id: ow.id, type: ow.type, allow: ow.allow.bitfield & ~LOCK_BITS, deny: ow.deny.bitfield & ~LOCK_BITS }
            : { id: ow.id, type: ow.type, allow: ow.allow.bitfield, deny: ow.deny.bitfield }
        );
        await target.permissionOverwrites.set(resetOverwrites);
        return interaction.editReply({ content: `🔓 ${target} has been force-unlocked (send permissions reset to default).` });
      } catch (err) {
        return interaction.editReply({ content: `❌ Failed to force-unlock: ${err.message}` });
      }
    }

    try {
      const saved = lockedChannels.get(target.id);
      lockedChannels.delete(target.id);

      // Restore exactly — one bulk set() call
      await target.permissionOverwrites.set(
        saved.savedOverwrites.map(ow => ({ id: ow.id, type: ow.type, allow: ow.allow, deny: ow.deny }))
      );

      const embed = new EmbedBuilder()
        .setTitle("🔓 Channel Unlocked")
        .setColor(0x57f287)
        .addFields(
          { name: "📍 Channel", value: `${target}`,                                             inline: true },
          { name: "🛠️ By",     value: `${interaction.user} — \`${interaction.user.tag}\``,      inline: true },
          { name: "📄 Reason",  value: saved.reason,                                             inline: false },
          { name: "📝 Action",  value: "Members can send messages in this channel again.",       inline: false },
        )
        .setTimestamp();

      await logMod(interaction.guild, embed);
      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      return interaction.editReply({ content: `❌ Failed to unlock: ${err.message}` });
    }
  }

  // ── /forcelock ────────────────────────────────────────────────────────────────
  if (commandName === "forcelock") {
    const target = interaction.options.getChannel("channel") ?? interaction.channel;
    const reason = interaction.options.getString("reason") ?? "No reason provided";

    if (isSafeChannel(target)) {
      return interaction.reply({ content: `⚠️ **${target}** is a protected channel and cannot be force-locked — members must always be able to verify and create tickets.`, flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();

    try {
      // Build locked overwrites — deny LOCK_BITS for all role overwrites + ensure @everyone
      const current = target.permissionOverwrites.cache.map(ow => ({
        id: ow.id, type: ow.type, allow: ow.allow.bitfield, deny: ow.deny.bitfield,
      }));
      const newOverwrites = current.map(ow =>
        ow.type === 0
          ? { id: ow.id, type: ow.type, allow: ow.allow & ~LOCK_BITS, deny: ow.deny | LOCK_BITS }
          : { id: ow.id, type: ow.type, allow: ow.allow, deny: ow.deny }
      );
      if (!newOverwrites.some(ow => ow.id === interaction.guild.id)) {
        newOverwrites.push({ id: interaction.guild.id, type: 0, allow: 0n, deny: LOCK_BITS });
      }
      await target.permissionOverwrites.set(newOverwrites);
      lockedChannels.set(target.id, { savedOverwrites: current, reason });

      const embed = new EmbedBuilder()
        .setTitle("🔒 Channel Force-Locked")
        .setColor(0xed4245)
        .addFields(
          { name: "📍 Channel", value: `${target}`,                                                       inline: true },
          { name: "🛠️ Admin",  value: `${interaction.user} — \`${interaction.user.tag}\``,                 inline: true },
          { name: "📄 Reason",  value: reason,                                                               inline: false },
          { name: "📝 Action",  value: "All role send permissions force-denied. Use `/forceopen` to reset.", inline: false },
        )
        .setTimestamp();

      await logMod(interaction.guild, embed);
      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      return interaction.editReply({ content: `❌ Failed to force-lock: ${err.message}` });
    }
  }

  // ── /forceopen ────────────────────────────────────────────────────────────────
  if (commandName === "forceopen") {
    const target = interaction.options.getChannel("channel") ?? interaction.channel;

    await interaction.deferReply();

    try {
      // Strip LOCK_BITS from both allow and deny for every role overwrite — one bulk call
      const resetOverwrites = target.permissionOverwrites.cache.map(ow =>
        ow.type === 0
          ? { id: ow.id, type: ow.type, allow: ow.allow.bitfield & ~LOCK_BITS, deny: ow.deny.bitfield & ~LOCK_BITS }
          : { id: ow.id, type: ow.type, allow: ow.allow.bitfield, deny: ow.deny.bitfield }
      );
      await target.permissionOverwrites.set(resetOverwrites);
      lockedChannels.delete(target.id);

      const embed = new EmbedBuilder()
        .setTitle("🔓 Channel Force-Opened")
        .setColor(0x57f287)
        .addFields(
          { name: "📍 Channel", value: `${target}`,                                              inline: true },
          { name: "🛠️ Admin",  value: `${interaction.user} — \`${interaction.user.tag}\``,        inline: true },
          { name: "📝 Action",  value: "All send permissions removed from deny list (inherited).", inline: false },
        )
        .setTimestamp();

      await logMod(interaction.guild, embed);
      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      return interaction.editReply({ content: `❌ Failed to force-open: ${err.message}` });
    }
  }

  // ── /shop ─────────────────────────────────────────────────────────────────────
  if (commandName === "shop") {
    const page = 0;
    const { embed, pages } = buildShopEmbed(page);
    const row = buildShopRow(page, pages);
    return interaction.reply({ embeds: [embed], components: row ? [row] : [], flags: MessageFlags.Ephemeral });
  }

  // ── /buy ──────────────────────────────────────────────────────────────────────
  if (commandName === "buy") {
    const itemId = interaction.options.getString("item").toLowerCase().trim();
    const item   = SHOP_CATALOG.find((i) => i.id === itemId);
    if (!item) {
      return interaction.reply({ content: `❌ Unknown item \`${itemId}\`. Use \`/shop\` to see available items.`, flags: MessageFlags.Ephemeral });
    }

    const stock = getStock(itemId);
    if (stock <= 0) {
      return interaction.reply({ content: `❌ **${item.name}** is sold out! It will restock soon.`, flags: MessageFlags.Ephemeral });
    }

    // Purchase cooldown
    if (item.cooldownH > 0) {
      const key = `${interaction.user.id}:${itemId}`;
      const last = lastPurchase.get(key) ?? 0;
      const cooldownMs = item.cooldownH * 60 * 60 * 1000;
      if (Date.now() - last < cooldownMs) {
        const remainH = Math.ceil((cooldownMs - (Date.now() - last)) / 3600000);
        return interaction.reply({ content: `⏳ You need to wait **${remainH}h** before buying **${item.name}** again.`, flags: MessageFlags.Ephemeral });
      }
    }

    // Daily deal price
    const dailyIds = getDailyRotation();
    const isDaily  = dailyIds.includes(itemId);
    const price    = isDaily ? Math.round(getItemPrice(item) * 0.8) : getItemPrice(item);
    const bal      = getCoins(interaction.user.id);
    if (bal < price) {
      return interaction.reply({ content: `❌ Not enough coins! You need **${price.toLocaleString()}** but have **${bal.toLocaleString()}**.`, flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Deduct coins
    coins.set(interaction.user.id, bal - price);
    // Reduce stock
    shopStock.set(itemId, stock - 1);
    // Cooldown
    if (item.cooldownH > 0) lastPurchase.set(`${interaction.user.id}:${itemId}`, Date.now());
    // Track popularity
    itemPopularity.set(itemId, (itemPopularity.get(itemId) ?? 0) + 1);

    // Add to inventory
    const inv = getUserInventory(interaction.user.id);
    const existing = inv.get(itemId) ?? { quantity: 0, acquiredAt: Date.now() };
    existing.quantity++;
    inv.set(itemId, existing);

    // Apply boost immediately if boost item
    if (item.type === "boost" && item.boostType !== "lucky") {
      const boosts = getUserBoosts(interaction.user.id);
      const expiresAt = Date.now() + item.boostMs;
      if (item.boostType === "xp")   boosts.xp   = Math.max(boosts.xp   ?? 0, expiresAt);
      if (item.boostType === "coin") boosts.coin  = Math.max(boosts.coin ?? 0, expiresAt);
      if (item.boostType === "mega") { boosts.mega = Math.max(boosts.mega ?? 0, expiresAt); }
      userBoosts.set(interaction.user.id, boosts);
    }

    const embed = new EmbedBuilder()
      .setTitle(`✅ Purchase Successful!`)
      .setDescription(
        `You bought **${item.name}** for **${price.toLocaleString()} coins**!\n\n` +
        `${item.effect}\n\n` +
        (item.type === "role"
          ? `Use \`/equip ${item.id}\` to equip your new role.`
          : item.boostType === "lucky"
          ? `Your next \`/daily\` will give +100 bonus coins!`
          : `✨ Boost is **active now**!`) +
        `\n\n💰 Remaining balance: **${getCoins(interaction.user.id).toLocaleString()} coins**`
      )
      .setColor(RARITY_COLOR[item.rarity])
      .setFooter({ text: `${RARITY_EMOJI[item.rarity]} ${item.rarity}` })
      .setTimestamp();

    await checkAchievements(interaction.member, "totalCoins", getCoins(interaction.user.id), interaction.guild);
    return interaction.editReply({ embeds: [embed] });
  }

  // ── /inventory ────────────────────────────────────────────────────────────────
  if (commandName === "inventory") {
    const inv = getUserInventory(interaction.user.id);
    if (inv.size === 0) {
      return interaction.reply({ content: `🎒 Your inventory is empty! Use \`/shop\` to buy items.`, flags: MessageFlags.Ephemeral });
    }

    const boosts = getUserBoosts(interaction.user.id);
    const now = Date.now();
    const fields = [];
    for (const [itemId, entry] of inv.entries()) {
      const item = SHOP_CATALOG.find((i) => i.id === itemId);
      if (!item) continue;
      let statusLine = "";
      if (item.type === "boost") {
        const expiry = boosts[item.boostType];
        statusLine = expiry && now < expiry
          ? `\n⚡ **Active!** Expires <t:${Math.floor(expiry / 1000)}:R>`
          : `\n💤 Inactive — buy again to activate`;
      } else if (item.type === "role") {
        const hasRole = interaction.member.roles.cache.some((r) => r.name === item.roleName);
        statusLine = hasRole ? `\n✅ Role is equipped` : `\n📦 Not equipped — use \`/equip ${item.id}\``;
      }
      fields.push({
        name: `${RARITY_EMOJI[item.rarity]} **${item.name}** × ${entry.quantity}`,
        value: `${item.effect}${statusLine}`,
      });
    }

    const embed = new EmbedBuilder()
      .setTitle(`🎒 ${interaction.user.username}'s Inventory`)
      .setDescription(`You own **${inv.size}** item type(s). Use \`/equip <id>\` to equip role items.`)
      .addFields(fields.slice(0, 25))
      .setColor(0x5865f2)
      .setThumbnail(interaction.user.displayAvatarURL())
      .setTimestamp();
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  // ── /equip ────────────────────────────────────────────────────────────────────
  if (commandName === "equip") {
    const itemId = interaction.options.getString("item").toLowerCase().trim();
    const item   = SHOP_CATALOG.find((i) => i.id === itemId);
    if (!item) return interaction.reply({ content: `❌ Unknown item \`${itemId}\`.`, flags: MessageFlags.Ephemeral });
    if (item.type !== "role") return interaction.reply({ content: `❌ **${item.name}** is a boost item, not a role — it activates automatically on purchase.`, flags: MessageFlags.Ephemeral });

    const inv = getUserInventory(interaction.user.id);
    if (!inv.has(itemId) || inv.get(itemId).quantity < 1) {
      return interaction.reply({ content: `❌ You don't own **${item.name}**. Use \`/buy ${item.id}\` to purchase it first.`, flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let role = interaction.guild.roles.cache.find((r) => r.name === item.roleName);
    if (!role) {
      try { role = await interaction.guild.roles.create({ name: item.roleName, reason: "Shop item equipped" }); }
      catch (err) { return interaction.editReply({ content: `❌ Could not create role: ${err.message}` }); }
    }
    try {
      await interaction.member.roles.add(role);
      return interaction.editReply({ content: `✅ You've equipped the **${item.roleName}** role! ${RARITY_EMOJI[item.rarity]}` });
    } catch (err) {
      return interaction.editReply({ content: `❌ Could not assign role: ${err.message}` });
    }
  }

  // ── /achievements ─────────────────────────────────────────────────────────────
  if (commandName === "achievements") {
    const data     = getAchievements(interaction.user.id);
    const streak   = loginStreak.get(interaction.user.id) ?? { streak: 0 };
    const totalMsg = msgCount.get(interaction.user.id) ?? 0;
    const invites  = inviteCount.get(interaction.user.id) ?? 0;
    const totalCns = getCoins(interaction.user.id);
    const voiceMs  = userProfiles.get(interaction.user.id)?.voiceMins ?? 0;

    const liveProgress = { msgs: totalMsg, voiceMins: voiceMs, streak: streak.streak, invites, totalCoins: totalCns };

    const fields = ACHIEVEMENTS.map((ach) => {
      const entry    = data[ach.id] ?? { progress: 0, earned: false };
      const progress = Math.min(liveProgress[ach.field] ?? entry.progress, ach.goal);
      const pct      = Math.min(100, Math.round((progress / ach.goal) * 100));
      const bar      = "█".repeat(Math.floor(pct / 10)) + "░".repeat(10 - Math.floor(pct / 10));
      const status   = entry.earned ? "✅ **EARNED**" : `${bar} ${pct}%`;
      return {
        name: `${ach.emoji} ${ach.name}${entry.earned ? " ✅" : ""}`,
        value: `${ach.desc}\n${status}\n🎁 ${ach.reward.coins} coins + ${ach.reward.xp ?? 0} XP${ach.reward.role ? ` + \`${ach.reward.role}\` role` : ""}`,
        inline: true,
      };
    });

    const earned = ACHIEVEMENTS.filter((a) => data[a.id]?.earned).length;
    const embed = new EmbedBuilder()
      .setTitle(`🏆 ${interaction.user.username}'s Achievements`)
      .setDescription(`**${earned}/${ACHIEVEMENTS.length}** achievements unlocked\n🔥 Current streak: **${streak.streak} day${streak.streak !== 1 ? "s" : ""}**`)
      .addFields(fields.slice(0, 25))
      .setColor(0xfee75c)
      .setThumbnail(interaction.user.displayAvatarURL())
      .setTimestamp();
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  // ── /balance ──────────────────────────────────────────────────────────────────
  if (commandName === "balance") {
    const bal = getCoins(interaction.user.id);
    const boostActive = serverBoost.active && Date.now() < serverBoost.expiresAt;
    const embed = new EmbedBuilder()
      .setTitle("💰 Your Balance")
      .setDescription(
        `You have **${bal.toLocaleString()} coins**\n\n` +
        (boostActive ? `⚡ **Server boost active!** Earn ${serverBoost.multiplier}x rewards until <t:${Math.floor(serverBoost.expiresAt / 1000)}:R>` : "")
      )
      .setColor(0xfee75c)
      .setThumbnail(interaction.user.displayAvatarURL())
      .setTimestamp();
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  // ── /give-coins ───────────────────────────────────────────────────────────────
  if (commandName === "give-coins") {
    const target = interaction.options.getUser("user") ?? interaction.user;
    const amount  = interaction.options.getInteger("amount");
    const isSelf  = target.id === interaction.user.id;
    addCoins(target.id, amount, null);
    const newBal = getCoins(target.id);
    const embed = new EmbedBuilder()
      .setTitle("💰 Coins Given!")
      .setDescription(
        isSelf
          ? `✅ Added **${amount.toLocaleString()} coins** to your own balance.\n> New balance: **${newBal.toLocaleString()} coins**`
          : `✅ Added **${amount.toLocaleString()} coins** to ${target}'s balance.\n> Their new balance: **${newBal.toLocaleString()} coins**`
      )
      .setColor(0xfee75c)
      .setThumbnail(target.displayAvatarURL())
      .setFooter({ text: `Given by ${interaction.user.tag}` })
      .setTimestamp();
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  // ── /remove-coins ─────────────────────────────────────────────────────────────
  if (commandName === "remove-coins") {
    const target  = interaction.options.getUser("user") ?? interaction.user;
    const amount  = interaction.options.getInteger("amount");
    const isSelf  = target.id === interaction.user.id;
    const current = getCoins(target.id);
    const deduct  = Math.min(amount, current);
    coins.set(target.id, current - deduct);
    const newBal  = getCoins(target.id);
    const embed = new EmbedBuilder()
      .setTitle("💸 Coins Removed!")
      .setDescription(
        isSelf
          ? `✅ Removed **${deduct.toLocaleString()} coins** from your own balance.\n> New balance: **${newBal.toLocaleString()} coins**`
          : `✅ Removed **${deduct.toLocaleString()} coins** from ${target}'s balance.\n> Their new balance: **${newBal.toLocaleString()} coins**`
      )
      .setColor(0xed4245)
      .setThumbnail(target.displayAvatarURL())
      .setFooter({ text: `Removed by ${interaction.user.tag}` })
      .setTimestamp();
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  // ── /daily ────────────────────────────────────────────────────────────────────
  if (commandName === "daily") {
    const userId = interaction.user.id;
    const now = Date.now();
    const last = lastDaily.get(userId) ?? 0;
    const COOLDOWN = 24 * 60 * 60 * 1000;
    if (now - last < COOLDOWN) {
      const remaining = Math.ceil((COOLDOWN - (now - last)) / 3600000);
      return interaction.reply({ content: `⏳ Already claimed! Come back in **${remaining}h**.`, flags: MessageFlags.Ephemeral });
    }
    let earned = addCoins(userId, 200, interaction.channelId);
    lastDaily.set(userId, now);
    // Lucky Coin boost: check inventory for unused lucky_coin
    const luckyInv = getUserInventory(userId);
    const luckyEntry = luckyInv.get("lucky_coin");
    let luckyBonus = 0;
    if (luckyEntry && luckyEntry.quantity > 0) {
      luckyBonus = 100;
      earned += addCoins(userId, luckyBonus, null);
      luckyEntry.quantity--;
      if (luckyEntry.quantity <= 0) luckyInv.delete("lucky_coin");
      else luckyInv.set("lucky_coin", luckyEntry);
    }
    await updateLoginStreak(interaction.member, interaction.guild);
    const embed = new EmbedBuilder()
      .setTitle("🎁 Daily Reward Claimed!")
      .setDescription(
        `You received **${earned} coins**!${luckyBonus ? ` *(+${luckyBonus} Lucky Coin bonus!)*` : ""}\n` +
        `Balance: **${getCoins(userId).toLocaleString()} coins**\n\n` +
        `💡 Tip: Check \`/achievements\` or \`/shop\` for more rewards!`
      )
      .setColor(0x57f287).setTimestamp();
    return interaction.reply({ embeds: [embed] });
  }

  // ── /weekly ───────────────────────────────────────────────────────────────────
  if (commandName === "weekly") {
    const userId = interaction.user.id;
    const now = Date.now();
    const last = lastWeekly.get(userId) ?? 0;
    const COOLDOWN = 7 * 24 * 60 * 60 * 1000;
    if (now - last < COOLDOWN) {
      const remaining = Math.ceil((COOLDOWN - (now - last)) / 86400000);
      return interaction.reply({ content: `⏳ Already claimed! Come back in **${remaining}d**.`, flags: MessageFlags.Ephemeral });
    }
    const earned = addCoins(userId, 1000, interaction.channelId);
    lastWeekly.set(userId, now);
    const embed = new EmbedBuilder()
      .setTitle("📅 Weekly Reward Claimed!")
      .setDescription(`You received **${earned} coins**!\nBalance: **${getCoins(userId).toLocaleString()} coins**`)
      .setColor(0x57f287).setTimestamp();
    return interaction.reply({ embeds: [embed] });
  }

  // ── /rank ─────────────────────────────────────────────────────────────────────
  if (commandName === "rank") {
    const target = interaction.options.getUser("user") ?? interaction.user;
    const data = getXP(target.id);
    const lvl = data.level;
    const currentXP = data.xp - xpForLevel(lvl);
    const neededXP  = xpForLevel(lvl + 1) - xpForLevel(lvl);
    const pct = Math.floor((currentXP / neededXP) * 10);
    const bar = "█".repeat(pct) + "░".repeat(10 - pct);
    const nextRole = Object.entries(LEVEL_ROLES).find(([l]) => Number(l) > lvl);
    const profileType = getProfileType(target.id);
    const boostActive = serverBoost.active && Date.now() < serverBoost.expiresAt;

    const embed = new EmbedBuilder()
      .setTitle(`📊 ${target.username}'s Rank`)
      .addFields(
        { name: "Level",     value: `**${lvl}**`,                     inline: true },
        { name: "Total XP",  value: `**${data.xp.toLocaleString()}**`, inline: true },
        { name: "Coins",     value: `**${getCoins(target.id).toLocaleString()}**`, inline: true },
        { name: `Progress to Level ${lvl + 1}`, value: `\`[${bar}]\` ${currentXP}/${neededXP} XP`, inline: false },
        { name: "Player Type", value: profileType, inline: true },
        ...(nextRole ? [{ name: "Next Role Reward", value: `Level ${nextRole[0]} → **${nextRole[1]}**`, inline: true }] : []),
        ...(boostActive ? [{ name: "⚡ Boost Active", value: `${serverBoost.multiplier}x rewards!`, inline: true }] : []),
      )
      .setColor(0x5865f2)
      .setThumbnail(target.displayAvatarURL())
      .setTimestamp();
    return interaction.reply({ embeds: [embed] });
  }

  // ── /challenges ───────────────────────────────────────────────────────────────
  if (commandName === "challenges") {
    const userId = interaction.user.id;
    const c = getChallenge(userId);
    const bar = (val, goal) => {
      const filled = Math.floor((Math.min(val, goal) / goal) * 8);
      return `\`[${"█".repeat(filled)}${"░".repeat(8 - filled)}]\` ${val}/${goal}`;
    };
    const embed = new EmbedBuilder()
      .setTitle("🎯 Daily Challenges")
      .setDescription(
        c.done
          ? "✅ **All challenges complete today!** Come back tomorrow for new ones."
          : "Complete all three challenges to earn **300 coins + 100 XP**!"
      )
      .addFields(
        { name: "💬 Send 20 Messages",   value: bar(c.msgs, CHALLENGE_GOALS.msgs),                 inline: false },
        { name: "🎙️ 15 Voice Minutes",   value: bar(c.voiceMinutes, CHALLENGE_GOALS.voiceMinutes), inline: false },
        { name: "🎮 Join a Session",      value: bar(c.sessionJoin, CHALLENGE_GOALS.sessionJoin),   inline: false },
      )
      .setColor(c.done ? 0x57f287 : 0x5865f2)
      .setFooter({ text: "Challenges reset every 24 hours." })
      .setTimestamp();
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  // ── /leaderboard ──────────────────────────────────────────────────────────────
  if (commandName === "leaderboard") {
    const top = [...xpStore.entries()].sort((a, b) => b[1].xp - a[1].xp).slice(0, 10);
    const lines = top.length
      ? top.map(([id, d], i) => `**${i + 1}.** <@${id}> — Level ${d.level} · ${d.xp} XP · ${getCoins(id).toLocaleString()} coins`)
      : ["No one has earned XP yet!"];
    const embed = new EmbedBuilder()
      .setTitle("🏆 XP Leaderboard — Top 10")
      .setDescription(lines.join("\n"))
      .setColor(0xfee75c).setTimestamp();
    return interaction.reply({ embeds: [embed] });
  }

  // ── /serverstats ──────────────────────────────────────────────────────────────
  if (commandName === "serverstats") {
    const guild = interaction.guild;
    const boostActive = serverBoost.active && Date.now() < serverBoost.expiresAt;
    const dropZones = [...rewardDropZones.entries()].filter(([, exp]) => Date.now() < exp);
    const embed = new EmbedBuilder()
      .setTitle(`📊 ${guild.name} — Server Stats`)
      .setThumbnail(guild.iconURL())
      .addFields(
        { name: "👥 Members",     value: `**${guild.memberCount}**`,                                              inline: true },
        { name: "💬 Channels",    value: `**${guild.channels.cache.filter((c) => c.type === ChannelType.GuildText).size}**`, inline: true },
        { name: "🎭 Roles",       value: `**${guild.roles.cache.size}**`,                                        inline: true },
        { name: "📅 Created",     value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`,                   inline: true },
        { name: "⚡ Boost",       value: boostActive ? `${serverBoost.multiplier}x until <t:${Math.floor(serverBoost.expiresAt / 1000)}:R>` : "Inactive", inline: true },
        { name: "💰 Drop Zones",  value: dropZones.length > 0 ? `${dropZones.length} active` : "None active",   inline: true },
        { name: "🤖 Bot Systems", value: "XP · Coins · Challenges · Moderation · Invites · Sessions · Giveaways · Adaptive Rewards", inline: false },
      )
      .setColor(0x5865f2).setTimestamp();
    return interaction.reply({ embeds: [embed] });
  }

  // ── /activity ─────────────────────────────────────────────────────────────────
  if (commandName === "activity") {
    const target = interaction.options.getUser("user") ?? interaction.user;
    const data = getXP(target.id);
    const embed = new EmbedBuilder()
      .setTitle(`📈 ${target.username}'s Activity`)
      .addFields(
        { name: "💬 Messages",  value: `**${(msgCount.get(target.id) ?? 0).toLocaleString()}**`, inline: true },
        { name: "📧 Invites",   value: `**${inviteCount.get(target.id) ?? 0}**`,                  inline: true },
        { name: "📊 XP",        value: `**${data.xp.toLocaleString()}**`,                         inline: true },
        { name: "🏆 Level",     value: `**${data.level}**`,                                        inline: true },
        { name: "💰 Coins",     value: `**${getCoins(target.id).toLocaleString()}**`,              inline: true },
        { name: "🧬 Type",      value: `**${getProfileType(target.id)}**`,                         inline: true },
      )
      .setColor(0x57f287).setThumbnail(target.displayAvatarURL()).setTimestamp();
    return interaction.reply({ embeds: [embed] });
  }

  // ── /invites ──────────────────────────────────────────────────────────────────
  if (commandName === "invites") {
    const count = inviteCount.get(interaction.user.id) ?? 0;
    const embed = new EmbedBuilder()
      .setTitle("📧 Your Invites")
      .setDescription(`You've invited **${count}** member${count !== 1 ? "s" : ""} to the server!`)
      .setColor(0x5865f2).setTimestamp();
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  // ── /resetlives ───────────────────────────────────────────────────────────────
  if (commandName === "resetlives") {
    if (!isHeadAdmin(interaction.member)) {
      return interaction.reply({ content: "🚫 Only **Head Mods** can reset lives.", flags: MessageFlags.Ephemeral });
    }
    const target = interaction.options.getMember("user");
    if (!target) return interaction.reply({ content: "❌ User not found.", flags: MessageFlags.Ephemeral });

    const prevLives = getLives(target.id);
    setLives(target.id, MAX_LIVES);
    kickedUsers.delete(target.id); // clear ban-on-rejoin flag too

    const embed = new EmbedBuilder()
      .setTitle("❤️ Lives Reset")
      .setColor(0x57f287)
      .addFields(
        { name: "👤 User",       value: `${target} — \`${target.user.tag}\`\nID: \`${target.id}\``,            inline: false },
        { name: "🛠️ Reset By",  value: `${interaction.user} — \`${interaction.user.tag}\``,                    inline: true },
        { name: "❤️ Lives",     value: `${prevLives} → **${MAX_LIVES}** (fully restored)`,                     inline: true },
      )
      .setTimestamp();

    // DM the user so they know
    target.user.send(`✅ Your lives in **${interaction.guild.name}** have been reset to **${MAX_LIVES}/${MAX_LIVES}** by a Head Mod.`).catch(() => {});

    await logMod(interaction.guild, embed);
    return interaction.reply({ embeds: [embed] });
  }

  // ── /warn ─────────────────────────────────────────────────────────────────────
  if (commandName === "warn") {
    const target = interaction.options.getMember("user");
    const reason = interaction.options.getString("reason");
    if (!target) return interaction.reply({ content: "User not found.", flags: MessageFlags.Ephemeral });
    const list = warnings.get(target.id) ?? [];
    list.push({ reason, ts: Date.now(), mod: interaction.user.tag });
    warnings.set(target.id, list);
    const embed = new EmbedBuilder()
      .setTitle("🟡 Member Warned")
      .setColor(0xfee75c)
      .addFields(
        { name: "👤 User",       value: `${target} — \`${target.user.tag}\`\nID: \`${target.id}\``, inline: false },
        { name: "🛠️ Moderator", value: `${interaction.user} — \`${interaction.user.tag}\``,          inline: true },
        { name: "⚠️ Total Warns",value: `${list.length}`,                                             inline: true },
        { name: "📄 Reason",     value: reason,                                                        inline: false },
      )
      .setTimestamp();
    await logMod(interaction.guild, embed);
    return interaction.reply({ embeds: [embed] });
  }

  // ── /mute ─────────────────────────────────────────────────────────────────────
  if (commandName === "mute") {
    const target   = interaction.options.getMember("user");
    const duration = interaction.options.getInteger("duration");
    const reason   = interaction.options.getString("reason") ?? "No reason provided";
    if (!target) return interaction.reply({ content: "User not found.", flags: MessageFlags.Ephemeral });
    try {
      await target.timeout(duration * 60 * 1000, reason);
      const embed = new EmbedBuilder()
        .setTitle("🟡 Member Timed Out")
        .setColor(0xfee75c)
        .addFields(
          { name: "👤 User",       value: `${target} — \`${target.user.tag}\`\nID: \`${target.id}\``,    inline: false },
          { name: "🛠️ Moderator", value: `${interaction.user} — \`${interaction.user.tag}\``,             inline: true },
          { name: "⏱️ Duration",   value: `${duration} minute${duration !== 1 ? "s" : ""}`,               inline: true },
          { name: "📄 Reason",     value: reason,                                                           inline: false },
        )
        .setTimestamp();
      await logMod(interaction.guild, embed);
      return interaction.reply({ embeds: [embed] });
    } catch (err) {
      return interaction.reply({ content: `Failed to mute: ${err.message}`, flags: MessageFlags.Ephemeral });
    }
  }

  // ── /kick ─────────────────────────────────────────────────────────────────────
  if (commandName === "kick") {
    const target = interaction.options.getMember("user");
    const reason = interaction.options.getString("reason") ?? "No reason provided";
    if (!target) return interaction.reply({ content: "User not found.", flags: MessageFlags.Ephemeral });
    try {
      await target.kick(reason);
      const embed = new EmbedBuilder()
        .setTitle("🔴 Member Kicked")
        .setColor(0xed4245)
        .addFields(
          { name: "👤 User",       value: `\`${target.user.tag}\`\nID: \`${target.id}\``,            inline: false },
          { name: "🛠️ Moderator", value: `${interaction.user} — \`${interaction.user.tag}\``,         inline: true },
          { name: "📄 Reason",     value: reason,                                                       inline: false },
        )
        .setTimestamp();
      await logMod(interaction.guild, embed);
      return interaction.reply({ embeds: [embed] });
    } catch (err) {
      return interaction.reply({ content: `Failed to kick: ${err.message}`, flags: MessageFlags.Ephemeral });
    }
  }

  // ── /ban ──────────────────────────────────────────────────────────────────────
  if (commandName === "ban") {
    await interaction.deferReply();
    const target       = interaction.options.getMember("user");
    const reason       = interaction.options.getString("reason") ?? "No reason provided";
    const durationStr  = interaction.options.getString("duration");
    const durationMs   = durationStr ? parseDurationMs(durationStr) : null;
    const durationLabel = durationStr ? (DURATION_LABELS[durationStr] ?? durationStr) : "Permanent";

    if (!target) return interaction.editReply({ content: "User not found." });
    try {
      await target.ban({ reason });

      // Schedule unban if a duration was set
      if (durationMs) {
        const banKey = `${interaction.guild.id}:${target.id}`;
        const existingTimer = timedBans.get(banKey);
        if (existingTimer) clearTimeout(existingTimer);
        const timer = setTimeout(async () => {
          timedBans.delete(banKey);
          await interaction.guild.members.unban(target.id, "Timed ban expired").catch(() => {});
          const unbanEmbed = new EmbedBuilder()
            .setTitle("🟢 Timed Ban Expired — Member Unbanned")
            .setColor(0x57f287)
            .addFields(
              { name: "👤 User",     value: `\`${target.user.tag}\`\nID: \`${target.id}\``, inline: false },
              { name: "⏱️ Duration", value: durationLabel,                                   inline: true },
              { name: "📄 Reason",   value: reason,                                           inline: false },
            )
            .setTimestamp();
          await logMod(interaction.guild, unbanEmbed);
        }, durationMs);
        timedBans.set(banKey, timer);
      }

      const embed = new EmbedBuilder()
        .setTitle("🔨 Member Banned")
        .setColor(0xed4245)
        .addFields(
          { name: "👤 User",         value: `\`${target.user.tag}\`\nID: \`${target.id}\``,   inline: false },
          { name: "🛠️ Moderator",   value: `${interaction.user} — \`${interaction.user.tag}\``, inline: true },
          { name: "⏱️ Duration",     value: durationLabel,                                       inline: true },
          { name: "📄 Reason",       value: reason,                                               inline: false },
        )
        .setFooter({ text: durationMs ? `Will be automatically unbanned in ${durationLabel}` : "Permanent ban" })
        .setTimestamp();
      await logMod(interaction.guild, embed);
      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      return interaction.editReply({ content: `Failed to ban: ${err.message}` });
    }
  }

  // ── /boost ────────────────────────────────────────────────────────────────────
  if (commandName === "boost") {
    serverBoost.active    = true;
    serverBoost.expiresAt = Date.now() + BOOST_DURATION_MS;
    setTimeout(() => { serverBoost.active = false; }, BOOST_DURATION_MS);

    const embed = new EmbedBuilder()
      .setTitle("⚡ Server Boost Activated!")
      .setDescription(`Everyone earns **${serverBoost.multiplier}x XP & Coins** for the next **30 minutes**!\n\nActivated by ${interaction.user}`)
      .setColor(0xfee75c).setTimestamp();

    await interaction.reply({ embeds: [embed] });
    // Announce in chat channel
    const chatCh = findChannel(interaction.guild, "chat");
    if (chatCh && chatCh.id !== interaction.channelId) {
      chatCh.send({ content: "@everyone", embeds: [embed] }).catch(() => {});
    }
    return;
  }

  // ── /giveaway ─────────────────────────────────────────────────────────────────
  if (commandName === "giveaway") {
    const prize        = interaction.options.getString("prize");
    const duration     = interaction.options.getInteger("duration");
    const winnersCount = interaction.options.getInteger("winners") ?? 1;
    const endsAt       = Date.now() + duration * 60 * 1000;

    const embed = new EmbedBuilder()
      .setTitle("🎉 GIVEAWAY!")
      .setDescription(
        `**Prize:** ${prize}\n\nReact with 🎉 to enter!\n\n` +
        `**Ends:** <t:${Math.floor(endsAt / 1000)}:R>\n` +
        `**Winners:** ${winnersCount}\n**Hosted by:** ${interaction.user}`
      )
      .setColor(0xeb459e).setFooter({ text: "Ends at" }).setTimestamp(endsAt);

    await interaction.reply({ content: "🎉 Giveaway started!", flags: MessageFlags.Ephemeral });
    const msg = await interaction.channel.send({ embeds: [embed] });
    await msg.react("🎉");
    giveaways.set(msg.id, { prize, endsAt, winnersCount, channelId: interaction.channelId, guildId: interaction.guildId, entrants: [] });

    setTimeout(async () => {
      const gw = giveaways.get(msg.id);
      if (!gw) return;
      giveaways.delete(msg.id);
      const guild   = client.guilds.cache.get(gw.guildId);
      const channel = guild?.channels.cache.get(gw.channelId);
      if (!channel) return;
      if (gw.entrants.length === 0) {
        channel.send({ embeds: [new EmbedBuilder().setTitle("🎉 Giveaway Ended").setDescription(`**${gw.prize}** — No one entered.`).setColor(0xed4245).setTimestamp()] }).catch(() => {});
        return;
      }
      const shuffled = [...gw.entrants].sort(() => Math.random() - 0.5);
      const winners  = shuffled.slice(0, Math.min(gw.winnersCount, shuffled.length));
      const mentions = winners.map((id) => `<@${id}>`).join(", ");
      const endEmbed = new EmbedBuilder()
        .setTitle("🎉 Giveaway Ended!")
        .setDescription(`**Prize:** ${gw.prize}\n\n🏆 **Winner${winners.length > 1 ? "s" : ""}:** ${mentions}`)
        .setColor(0x57f287).setTimestamp();
      // Respect "No Pings" bypass role — don't @mention those users in content
      const noPingsRole = guild.roles.cache.find((r) => r.name.toLowerCase() === PING_BYPASS_ROLE.toLowerCase());
      const pingableWinners = noPingsRole
        ? winners.filter((id) => !guild.members.cache.get(id)?.roles.cache.has(noPingsRole.id))
        : winners;
      const pingContent = pingableWinners.length > 0
        ? `Congratulations ${pingableWinners.map((id) => `<@${id}>`).join(", ")}! 🎉`
        : null;
      channel.send({ content: pingContent, embeds: [endEmbed] }).catch(() => {});
    }, duration * 60 * 1000);
    return;
  }

  // ── /session-start ────────────────────────────────────────────────────────────
  if (commandName === "session-start") {
    const name        = interaction.options.getString("name");
    const description = interaction.options.getString("description") ?? "Join up and play!";

    const embed = new EmbedBuilder()
      .setTitle(`🎮 Gaming Session: ${name}`)
      .setDescription(
        `${description}\n\n` +
        `React with 🎮 to join!\n\n` +
        `**Host:** ${interaction.user}\n` +
        `**Reward:** 20 bonus coins for joining!`
      )
      .setColor(0x5865f2).setTimestamp();

    await interaction.reply({ content: "Session started!", flags: MessageFlags.Ephemeral });
    const msg = await interaction.channel.send({ embeds: [embed] });
    await msg.react("🎮");
    sessions.set(msg.id, { name, channelId: interaction.channelId, participants: [interaction.user.id] });

    // Auto-end session after 3 hours and ask for feedback
    setTimeout(async () => {
      if (!sessions.has(msg.id)) return;
      const session = sessions.get(msg.id);
      sessions.delete(msg.id);
      const endEmbed = new EmbedBuilder()
        .setTitle(`✅ Session Ended: ${session.name}`)
        .setDescription(`**Participants:** ${session.participants.map((id) => `<@${id}>`).join(", ") || "None"}\n\nHow was this session? Vote below!`)
        .setColor(0x57f287).setTimestamp();
      const feedbackRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`session_good_${msg.id}`).setLabel("Good Session").setStyle(ButtonStyle.Success).setEmoji("👍"),
        new ButtonBuilder().setCustomId(`session_bad_${msg.id}`).setLabel("Bad Session").setStyle(ButtonStyle.Danger).setEmoji("👎")
      );
      try { await msg.edit({ embeds: [endEmbed], components: [feedbackRow] }); } catch { /* message deleted */ }
    }, 3 * 60 * 60 * 1000);
    return;
  }

  // ── Button: session_good / session_bad ───────────────────────────────────────
  if (interaction.isButton() && (interaction.customId.startsWith("session_good_") || interaction.customId.startsWith("session_bad_"))) {
    const isGood = interaction.customId.startsWith("session_good_");
    await interaction.reply({
      content: isGood ? "👍 Thanks for the feedback! Glad you had fun!" : "👎 Thanks for the feedback — we'll work on improving sessions!",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // ── /setup-server ─────────────────────────────────────────────────────────────
  if (commandName === "setup-server") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await setupServer(interaction.guild, interaction);

    // After setup, send the ticket panel if not already posted
    const ticketCh = findChannel(interaction.guild, "create-ticket");
    if (ticketCh) await sendTicketPanel(ticketCh);
    return;
  }

  // ── /rules-agree ──────────────────────────────────────────────────────────────
  if (commandName === "rules-agree") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const targetChannel = interaction.options.getChannel("channel") ?? interaction.channel;

    const embed = new EmbedBuilder()
      .setTitle("📋 Server Rules")
      .setDescription(
        "Please read the rules carefully before joining the community.\n\n" +
        "**1.** 🤝 Be respectful — no harassment, hate speech, or personal attacks\n" +
        "**2.** 🚫 No spam, NSFW content, or offensive material\n" +
        "**3.** 📌 Keep topics in the correct channels\n" +
        "**4.** 📢 No advertising or unsolicited self-promotion\n" +
        "**5.** 🎮 Keep game discussions friendly and spoiler-free\n" +
        "**6.** ⚖️ Follow Discord's [Terms of Service](https://discord.com/terms) at all times\n\n" +
        "Breaking the rules may result in a **mute, kick, or ban**.\n\n" +
        "Click **I Agree** below to confirm you have read the rules and to unlock the server! 🔓"
      )
      .setColor(0x5865F2)
      .setFooter({ text: "Cases 2.0 • Click I Agree to get the Member role" })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("agree_rules")
        .setLabel("✅ I Agree to the Rules")
        .setStyle(ButtonStyle.Success)
    );

    await targetChannel.send({ embeds: [embed], components: [row] });
    await interaction.editReply({ content: `✅ Rules agreement panel posted in ${targetChannel}!` });
    return;
  }

  // ── /cleanup-dupes ────────────────────────────────────────────────────────────
  if (commandName === "cleanup-dupes") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = interaction.guild;
    let deleted = 0;

    const allCategories = guild.channels.cache.filter((c) => c.type === ChannelType.GuildCategory);
    const KNOWN_CAT_NAMES = new Set(SERVER_STRUCTURE.map(c => baseName(c.name)));
    const toDelete = [];
    for (const [, cat] of allCategories) {
      if (!KNOWN_CAT_NAMES.has(baseName(cat.name))) continue;
      const base = baseName(cat.name);
      const dupe = allCategories.find((c) => c.id !== cat.id && baseName(c.name) === base);
      if (dupe) toDelete.push(cat);
    }
    for (const cat of toDelete) {
      const children = cat.children?.cache ?? guild.channels.cache.filter((c) => c.parentId === cat.id);
      for (const [, ch] of children) { try { await ch.delete("Cleanup dupe"); deleted++; } catch { /* ignore */ } }
      try { await cat.delete("Cleanup dupe category"); deleted++; } catch { /* ignore */ }
    }

    // Standalone duplicate text/voice channels
    const seen = new Map();
    const allChans = guild.channels.cache.filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildVoice);
    for (const [, ch] of [...allChans.entries()].sort((a, b) => a[1].createdTimestamp - b[1].createdTimestamp)) {
      const key = `${ch.type}:${baseName(ch.name)}`;
      if (!seen.has(key)) seen.set(key, ch.id);
    }
    for (const [, ch] of allChans) {
      if (seen.get(`${ch.type}:${baseName(ch.name)}`) !== ch.id) {
        try { await ch.delete("Cleanup dupe channel"); deleted++; } catch { /* ignore */ }
      }
    }

    await interaction.editReply({
      content: deleted > 0 ? `✅ Cleaned up **${deleted}** duplicate channels/categories.` : "✅ No duplicates found!",
    });
    return;
  }

  // ── /sync-permissions ─────────────────────────────────────────────────────────
  if (commandName === "sync-permissions") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = interaction.guild;
    let fixed = 0;

    // Build a lookup: channel name → type (readOnly / staffOnly / writable)
    const channelDefs = {};
    for (const cat of SERVER_STRUCTURE) {
      for (const ch of cat.channels ?? []) {
        if (ch.voice) continue;
        channelDefs[ch.name] = { readOnly: !!ch.readOnly, staffOnly: !!ch.staffOnly };
      }
    }

    const staffRole = guild.roles.cache.find(
      (r) => r.permissions.has(PermissionFlagsBits.ManageGuild) && !r.managed && r.id !== guild.id
    );

    for (const [, channel] of guild.channels.cache) {
      if (channel.type !== ChannelType.GuildText) continue;
      const def = channelDefs[baseName(channel.name)] ?? channelDefs[channel.name];
      if (!def) continue;

      try {
        if (def.staffOnly) {
          await channel.permissionOverwrites.edit(guild.id, { ViewChannel: false, SendMessages: false });
          if (staffRole) await channel.permissionOverwrites.edit(staffRole.id, { ViewChannel: true, SendMessages: true });
          await channel.permissionOverwrites.edit(client.user.id, { ViewChannel: true, SendMessages: true });
        } else if (def.readOnly) {
          await channel.permissionOverwrites.edit(guild.id, {
            SendMessages: false,
            CreatePublicThreads: false,
            SendMessagesInThreads: false,
          });
          await channel.permissionOverwrites.edit(client.user.id, { SendMessages: true });
        } else {
          // Writable — clear any leftover SendMessages deny
          const everyoneOw = channel.permissionOverwrites.cache.get(guild.id);
          if (everyoneOw && everyoneOw.deny.has(PermissionFlagsBits.SendMessages)) {
            await channel.permissionOverwrites.edit(guild.id, { SendMessages: null });
          }
        }
        fixed++;
      } catch (e) {
        console.error(`sync-permissions: failed on #${channel.name}:`, e.message);
      }
    }

    await interaction.editReply({
      content: `✅ Permissions synced on **${fixed}** channels. Read-only channels now block typing, staff channels are staff-only, and chat channels are open.`,
    });
    return;
  }

  // ── /organize_server ──────────────────────────────────────────────────────────
  if (commandName === "organize_server") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = interaction.guild;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // ── Step 1: Ensure all required roles exist ────────────────────────────────
    async function ensureRole(candidates, color) {
      let role = guild.roles.cache.find((r) => candidates.includes(r.name.toLowerCase()));
      if (!role) {
        role = await guild.roles.create({ name: candidates[0].charAt(0).toUpperCase() + candidates[0].slice(1), color, reason: "Created by /organize_server" });
        console.log(`[organize_server] Created role: ${role.name}`);
        await sleep(500);
      }
      return role;
    }

    // ── Rename any old "Unverified" role → "Unverified Member" + set red colour ─
    {
      const old = guild.roles.cache.find(r => ["unverified"].includes(r.name.toLowerCase()));
      if (old && (old.name !== "Unverified Member" || old.color !== 0xed4245)) {
        await old.edit({ name: "Unverified Member", color: 0xed4245 }).catch(() => {});
        await sleep(400);
      }
    }

    const unverifiedRole = await ensureRole(["unverified member", "unverified"], 0xed4245);
    // Ensure display name is always "Unverified Member"
    if (unverifiedRole.name !== "Unverified Member") {
      await unverifiedRole.edit({ name: "Unverified Member", color: 0xed4245 }).catch(() => {});
      await sleep(300);
    }

    const memberRole     = await ensureRole(["member", "members"], 0x3498db);
    const verifiedRole   = await ensureRole(["verified"], 0x57f287);
    const ogRole         = await ensureRole(["og", "og member"], 0xffd700); // gold
    // Ensure OG role display name is "OG"
    if (ogRole.name.toLowerCase() !== "og") {
      await ogRole.edit({ name: "OG", color: 0xffd700 }).catch(() => {});
      await sleep(300);
    }
    const staffRole      = await ensureRole(["staff", "admin", "moderator"], 0xe74c3c)
      ?? guild.roles.cache.find((r) => r.permissions.has(PermissionFlagsBits.ManageGuild) && !r.managed && r.id !== guild.id);
    const botId = client.user.id;

    // ── Step 2: Lock down @everyone guild-level permissions ───────────────────
    try {
      const everyoneRole = guild.roles.everyone;
      await everyoneRole.setPermissions(
        everyoneRole.permissions
          .remove(PermissionFlagsBits.ViewChannel)
          .remove(PermissionFlagsBits.SendMessages)
          .remove(PermissionFlagsBits.Connect),
        "Lock down by /organize_server"
      );
      console.log("[organize_server] @everyone guild permissions locked");
      await sleep(500);
    } catch (e) {
      console.error("[organize_server] Failed to edit @everyone guild perms:", e.message);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    // Classify a category by its name
    function categoryType(name) {
      const n = name.toLowerCase().replace(/[^\w\s]/g, " ").trim();
      if (/(staff|admin|mod\b)/.test(n)) return "staff";
      if (/(info|information|verification|verify|ticket|welcome|rules|faq)/.test(n)) return "info";
      return "community"; // gaming, social, events, progression, voice, etc.
    }

    // Channels that must stay visible to everyone (verify/ticket)
    const OPEN_KEYWORDS = ["verify", "verification", "create-ticket", "ticket", "tickets", "open-ticket", "welcome", "rules"];
    function isOpenChannel(name) {
      const n = name.toLowerCase().replace(/[-_]/g, " ");
      return OPEN_KEYWORDS.some((k) => n.includes(k.replace(/-/g, " ")));
    }

    // Read-only channel patterns (no one should type here except staff/bot)
    const READONLY_KEYWORDS = ["announcements", "rewards", "commands-guide", "shop", "events", "giveaway", "rules", "welcome", "goodbye", "updates", "news"];
    function isReadOnly(name) {
      const n = name.toLowerCase().replace(/[-_]/g, " ");
      return READONLY_KEYWORDS.some((k) => n.includes(k.replace(/-/g, " ")));
    }

    // Build permission overwrites for a category
    // Rule: Unverified → only open channels | Verified → all non-staff | Staff → everything
    function catOverwrites(type) {
      if (type === "staff") {
        return [
          { id: guild.id,       deny:  [PermissionFlagsBits.ViewChannel] },
          { id: unverifiedRole, deny:  [PermissionFlagsBits.ViewChannel] },
          { id: verifiedRole,   deny:  [PermissionFlagsBits.ViewChannel] },
          { id: staffRole,      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.Connect] },
          { id: botId,          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        ];
      }
      if (type === "info") {
        // Info category: Unverified hidden at category level (open channels override per-channel),
        // Verified can read but not send, Staff full access
        return [
          { id: guild.id,       deny:  [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
          { id: unverifiedRole, deny:  [PermissionFlagsBits.ViewChannel] },
          { id: verifiedRole,   allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
          { id: staffRole,      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
          { id: botId,          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        ];
      }
      // community (gaming, social, events, progression, voice, etc.)
      // Unverified → hidden, Verified → full access including voice speak + VAD, Staff → everything
      return [
        { id: guild.id,       deny:  [PermissionFlagsBits.ViewChannel] },
        { id: unverifiedRole, deny:  [PermissionFlagsBits.ViewChannel] },
        { id: verifiedRole,   allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.UseVAD] },
        { id: staffRole,      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.UseVAD] },
        { id: botId,          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      ];
    }

    // Build permission overwrites for an individual channel
    function channelOverwrites(catType, ch) {
      const open    = isOpenChannel(ch.name);
      const rdOnly  = isReadOnly(ch.name);
      const isVoice = ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice;

      if (open) {
        // Verify / welcome / create-a-ticket — visible to EVERYONE including unverified, no typing
        return [
          { id: guild.id,       allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
          { id: unverifiedRole, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
          { id: verifiedRole,   allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
          { id: staffRole,      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
          { id: botId,          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        ];
      }

      if (isVoice) {
        // Voice: Unverified cannot see/connect/speak. Verified + Staff can fully participate with VAD (no push-to-talk).
        return [
          { id: guild.id,       deny:  [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.UseVAD] },
          { id: unverifiedRole, deny:  [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.UseVAD] },
          { id: verifiedRole,   allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.UseVAD] },
          { id: staffRole,      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.UseVAD] },
        ];
      }

      if (rdOnly) {
        // Read-only (announcements, rules, leaderboard, etc.) — Verified sees but cannot type
        return [
          { id: guild.id,       deny:  [PermissionFlagsBits.ViewChannel] },
          { id: unverifiedRole, deny:  [PermissionFlagsBits.ViewChannel] },
          { id: verifiedRole,   allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
          { id: staffRole,      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
          { id: botId,          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        ];
      }

      // Everything else — inherit from parent category
      return null;
    }

    // Apply overwrites to a channel or category
    async function applyOw(target, overwrites) {
      if (!overwrites) {
        // Sync to parent category
        try { await target.lockPermissions(); } catch { /* ignore */ }
        return;
      }
      await target.permissionOverwrites.set(overwrites);
    }

    // ── Step 3: Process every category in the server ──────────────────────────
    let permissionsFixed = 0;
    const allCats = guild.channels.cache.filter((c) => c.type === ChannelType.GuildCategory);

    for (const [, cat] of allCats) {
      const type = categoryType(cat.name);
      try {
        await applyOw(cat, catOverwrites(type));
        permissionsFixed++;
        console.log(`[organize_server] Category "${cat.name}" → type:${type}`);
        await sleep(400);
      } catch (e) {
        console.error(`[organize_server] Failed category ${cat.name}:`, e.message);
      }

      // Apply per-channel overwrites within this category
      const children = guild.channels.cache.filter((c) => c.parentId === cat.id);
      for (const [, ch] of children) {
        if (ch.type === ChannelType.GuildCategory) continue;
        try {
          const ow = channelOverwrites(type, ch);
          await applyOw(ch, ow);
          permissionsFixed++;
          await sleep(300);
        } catch (e) {
          console.error(`[organize_server] Failed channel #${ch.name}:`, e.message);
        }
      }
    }

    // ── Step 4: Fix uncategorised channels ────────────────────────────────────
    const uncatChannels = guild.channels.cache.filter(
      (c) => !c.parentId && c.type !== ChannelType.GuildCategory && c.id !== guild.id
    );
    for (const [, ch] of uncatChannels) {
      try {
        const isUncatVoice = ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice;
        const ow = isUncatVoice
          ? [
              // Voice (uncategorised): Unverified cannot see/connect, Verified+Staff can
              { id: guild.id,       deny:  [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
              { id: unverifiedRole, deny:  [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
              { id: verifiedRole,   allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
              { id: staffRole,      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
            ]
          : isOpenChannel(ch.name)
          ? [
              { id: guild.id,       allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
              { id: unverifiedRole, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
              { id: verifiedRole,   allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
              { id: staffRole,      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
              { id: botId,          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
            ]
          : [
              { id: guild.id,       deny:  [PermissionFlagsBits.ViewChannel] },
              { id: unverifiedRole, deny:  [PermissionFlagsBits.ViewChannel] },
              { id: verifiedRole,   allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
              { id: staffRole,      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
              { id: botId,          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
            ];
        await ch.permissionOverwrites.set(ow);
        permissionsFixed++;
        await sleep(300);
      } catch (e) {
        console.error(`[organize_server] Failed uncategorised #${ch.name}:`, e.message);
      }
    }

    // ── Step 5: Final force-unlock pass for verify/welcome/ticket channels ────
    // This runs after all category processing so nothing can accidentally re-lock them.
    const freshChannels = await guild.channels.fetch();
    for (const [, ch] of freshChannels) {
      if (!ch || ch.type === ChannelType.GuildCategory) continue;
      if (!isOpenChannel(ch.name)) continue;
      try {
        await ch.permissionOverwrites.set([
          { id: guild.id,       allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
          { id: unverifiedRole, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
          { id: verifiedRole,   allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
          { id: staffRole,      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
          { id: botId,          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        ]);
        console.log(`[organize_server] ✅ Force-unlocked: #${ch.name}`);
        await sleep(300);
      } catch (e) {
        console.error(`[organize_server] Failed to unlock #${ch.name}:`, e.message);
      }
    }

    // ── Step 6: Delete empty categories ──────────────────────────────────────
    let categoriesRemoved = 0;
    for (const [, cat] of freshChannels) {
      if (!cat || cat.type !== ChannelType.GuildCategory) continue;
      const childCount = freshChannels.filter((c) => c && c.parentId === cat.id).size;
      if (childCount === 0) {
        try {
          await cat.delete("Empty category — /organize_server");
          categoriesRemoved++;
          console.log(`[organize_server] Deleted empty category: ${cat.name}`);
          await sleep(500);
        } catch (e) {
          console.error(`[organize_server] Could not delete empty category ${cat.name}:`, e.message);
        }
      }
    }

    // ── Step 6b: Retroactively give OG role to the first 50 members by join date ─
    try {
      await guild.members.fetch().catch(() => {});
      const ogRetroRole = guild.roles.cache.find(r => baseName(r.name) === "og" || baseName(r.name) === "ogmember");
      if (ogRetroRole) {
        const sorted = [...guild.members.cache.values()]
          .filter(m => !m.user.bot)
          .sort((a, b) => (a.joinedTimestamp ?? 0) - (b.joinedTimestamp ?? 0))
          .slice(0, 50);
        for (const m of sorted) {
          if (!m.roles.cache.has(ogRetroRole.id)) {
            await m.roles.add(ogRetroRole, "🌟 OG — retroactive first-50 assignment").catch(() => {});
            await sleep(400);
          }
        }
        console.log(`[organize_server] ✅ OG role ensured for first ${sorted.length} members`);
      }
    } catch (e) {
      console.error("[organize_server] OG retroactive assignment failed:", e.message);
    }

    // ── Step 6c: Strip leftover "⭐ OG | " nickname tags from all members ────────
    try {
      await guild.members.fetch().catch(() => {});
      for (const [, m] of guild.members.cache) {
        if (m.user.bot) continue;
        const nick = m.nickname;
        if (nick && nick.startsWith("⭐")) {
          const cleaned = nick.replace(/^⭐\s*OG\s*\|\s*/i, "").trim();
          await m.setNickname(cleaned || null, "Remove OG nickname tag").catch(() => {});
          await sleep(300);
        }
      }
      console.log("[organize_server] ✅ OG nickname tags cleaned up");
    } catch (e) {
      console.error("[organize_server] OG nickname cleanup failed:", e.message);
    }

    // ── Step 7: Delete empty/meaningless roles ───────────────────────────────
    const KEEP_ROLE_NAMES = new Set([
      "og", "og member", "unverified member", "unverified", "member", "members", "verified",
      "staff", "admin", "moderator", "head mod", "head admin", "head moderator",
      "active", "regular", "regular+", "veteran", "veteran+", "elite", "elite+",
      "legend", "server legend", "devoted", "chatter",
      "booster", "nitro booster", "server booster",
    ]);
    let rolesRemoved = 0;
    await guild.members.fetch().catch(() => {}); // fetch all members so .size is accurate
    const freshRoles = await guild.roles.fetch();
    for (const [, r] of freshRoles) {
      if (r.managed) continue;                                   // skip bot/integration roles
      if (r.id === guild.id) continue;                           // skip @everyone
      if (KEEP_ROLE_NAMES.has(r.name.toLowerCase())) continue;  // skip required roles
      if (r.members.size > 0) continue;                         // skip roles with members
      if (r.permissions.bitfield !== 0n) continue;              // skip roles with permissions
      try {
        await r.delete("Unused role cleanup — /organize_server");
        rolesRemoved++;
        console.log(`[organize_server] Deleted empty role: ${r.name}`);
        await sleep(400);
      } catch (e) {
        console.warn(`[organize_server] Could not delete role ${r.name}:`, e.message);
      }
    }

    // ── Step 8: Reply ─────────────────────────────────────────────────────────
    const embed = new EmbedBuilder()
      .setTitle("✅ Server Organised")
      .setColor(0x57f287)
      .setDescription("Full permission system applied. Role structure is clean and secure.")
      .addFields(
        { name: "🔐 Permissions Fixed",         value: `${permissionsFixed}`, inline: true },
        { name: "🗑️ Empty Categories Removed",  value: `${categoriesRemoved}`, inline: true },
        { name: "🏷️ Empty Roles Removed",       value: `${rolesRemoved}`, inline: true },
        {
          name: "👥 Role Access Summary",
          value: [
            "🔴 **Unverified Member** — Verify, Welcome & Create-a-Ticket only",
            "🟢 **Verified** — All channels except staff/mod",
            "🟡 **OG** — Auto-given to the first 50 members",
            "🔴 **Staff** — Full server access",
          ].join("\n"),
        },
        {
          name: "🔊 Voice",
          value: "@everyone & Unverified cannot connect — Verified can",
        },
      )
      .setFooter({ text: `Ran by ${interaction.user.tag}` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── /test-update ──────────────────────────────────────────────────────────────
  if (commandName === "test-update") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const embed = new EmbedBuilder()
      .setTitle("🎮 CASES Beta — Game Update!")
      .setDescription("A new update has been pushed to **CASES Beta** on Roblox!\n\n🔗 [Play Now](https://www.roblox.com/games/106780119627121/CASES-Beta)")
      .setColor(0x5865f2).setFooter({ text: "CASES Beta Update Tracker • TEST" }).setTimestamp();
    updateChannelId = interaction.channelId;
    await interaction.channel.send({ content: "@everyone", embeds: [embed] });
    await interaction.editReply({ content: "✅ Test update posted! Real game updates will go here automatically." });
    return;
  }

  // ── /silence ─────────────────────────────────────────────────────────────────
  if (commandName === "silence") {
    botSilenced = !botSilenced;
    const state = botSilenced ? "🤫 **SILENCED**" : "🔊 **UNSILENCED**";
    return interaction.reply({
      content: `${state}\n` +
               (botSilenced
                 ? "🚫 The bot will **stop** posting drop zones, surprise drops, chat hints, and AI replies. Slash commands, mod logs, tickets, welcome/goodbye and level-up DMs still work."
                 : "✅ The bot is back to posting automated chat messages (drop zones, surprise drops, chat hints, AI replies)."),
      flags: MessageFlags.Ephemeral,
    });
  }

  // ── /exclude-2x ──────────────────────────────────────────────────────────────
  if (commandName === "exclude-2x") {
    const target = interaction.options.getChannel("channel") ?? interaction.channel;
    if (!target || target.type !== ChannelType.GuildText) {
      return interaction.reply({ content: "⚠️ Pick a text channel.", flags: MessageFlags.Ephemeral });
    }
    let action;
    if (excludedDropChannels.has(target.id)) {
      excludedDropChannels.delete(target.id);
      action = `✅ ${target} is **no longer excluded** — 2x drop zone events can now happen here again. 🎉`;
    } else {
      excludedDropChannels.add(target.id);
      // Also kill any active drop zone in that channel
      if (rewardDropZones.has(target.id)) rewardDropZones.delete(target.id);
      action = `🚫 ${target} is now **excluded** from 2x drop zone events. The bot won't host 2x XP/coin events here. 🛑`;
    }
    return interaction.reply({ content: action, flags: MessageFlags.Ephemeral });
  }

  // ── /post-verification ───────────────────────────────────────────────────────
  if (commandName === "post-verification") {
    const ch = findChannel(interaction.guild, "verification") ?? findChannel(interaction.guild, "verify");
    if (!ch) return interaction.reply({ content: "⚠️ No `#verification` channel found.", flags: MessageFlags.Ephemeral });
    const embed = CHANNEL_MESSAGES["verification"](interaction.guild);
    // Try to update the bot's existing pinned verification message; otherwise post a new one
    try {
      const pins = await ch.messages.fetchPinned();
      const existing = pins.find((m) => m.author.id === client.user?.id && m.embeds?.[0]?.title?.includes("Verification"));
      if (existing) {
        await existing.edit({ embeds: [embed] });
        return interaction.reply({ content: `✅ Verification message **updated** in ${ch}.`, flags: MessageFlags.Ephemeral });
      }
    } catch { /* ignore */ }
    const msg = await ch.send({ embeds: [embed] });
    await msg.pin().catch(() => {});
    return interaction.reply({ content: `✅ Verification message **posted & pinned** in ${ch}.`, flags: MessageFlags.Ephemeral });
  }

  // ── /post-rules ──────────────────────────────────────────────────────────────
  if (commandName === "post-rules") {
    const ch = findChannel(interaction.guild, "rules-must-read") ?? findChannel(interaction.guild, "rules");
    if (!ch) return interaction.reply({ content: "⚠️ No `#rules-must-read` channel found.", flags: MessageFlags.Ephemeral });
    const embed = CHANNEL_MESSAGES["rules-must-read"]();
    try {
      const pins = await ch.messages.fetchPinned();
      const existing = pins.find((m) => m.author.id === client.user?.id && m.embeds?.[0]?.title?.toUpperCase?.().includes("RULES"));
      if (existing) {
        await existing.edit({ embeds: [embed] });
        return interaction.reply({ content: `✅ Rules embed **updated** in ${ch}.`, flags: MessageFlags.Ephemeral });
      }
    } catch { /* ignore */ }
    const msg = await ch.send({ embeds: [embed] });
    await msg.pin().catch(() => {});
    return interaction.reply({ content: `✅ Rules embed **posted & pinned** in ${ch}.`, flags: MessageFlags.Ephemeral });
  }

  // ── /refresh-embeds ──────────────────────────────────────────────────────────
  if (commandName === "refresh-embeds") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = interaction.guild;
    const results = [];

    const targets = [
      { key: "welcome",          channelNames: ["welcome"],                        titleMatch: "welcome" },
      { key: "verification",     channelNames: ["verification", "verify"],         titleMatch: "verification" },
      { key: "rules-must-read",  channelNames: ["rules-must-read", "rules"],       titleMatch: "rules" },
      { key: "commands-guide",   channelNames: ["commands-guide"],                 titleMatch: "commands" },
      { key: "shop",             channelNames: ["shop"],                           titleMatch: "shop" },
      { key: "rewards",          channelNames: ["rewards"],                        titleMatch: "reward" },
      { key: "giveaways",        channelNames: ["giveaways"],                      titleMatch: "giveaway" },
      { key: "clan-recruitment", channelNames: ["clan-recruitment"],               titleMatch: "clan" },
      { key: "suggestions",      channelNames: ["suggestions"],                    titleMatch: "suggestion" },
    ];

    for (const t of targets) {
      const ch = t.channelNames.map(n => findChannel(guild, n)).find(Boolean);
      if (!ch) { results.push(`⚠️ \`#${t.channelNames[0]}\` — channel not found, skipped`); continue; }
      const embed = CHANNEL_MESSAGES[t.key](guild);
      try {
        // Check pinned messages first
        const pins = await ch.messages.fetchPinned();
        const existing = pins.find((m) =>
          m.author.id === client.user?.id &&
          m.embeds?.[0]?.title?.toLowerCase?.().includes(t.titleMatch)
        );
        if (existing) {
          await existing.edit({ embeds: [embed] });
          results.push(`✅ ${ch} — updated existing pinned embed`);
          continue;
        }
        // Also check recent messages if not pinned yet
        const recent = await ch.messages.fetch({ limit: 50 });
        const recentBot = recent.find((m) =>
          m.author.id === client.user?.id &&
          m.embeds?.[0]?.title?.toLowerCase?.().includes(t.titleMatch)
        );
        if (recentBot) {
          await recentBot.edit({ embeds: [embed] });
          await recentBot.pin().catch(() => {});
          results.push(`✅ ${ch} — updated & pinned existing embed`);
          continue;
        }
      } catch { /* ignore */ }
      try {
        const msg = await ch.send({ embeds: [embed] });
        await msg.pin().catch(() => {});
        results.push(`✅ ${ch} — posted & pinned new embed`);
      } catch (err) {
        results.push(`❌ ${ch} — failed: ${err.message}`);
      }
    }

    // Also refresh the ticket panel
    const ticketCh = findChannel(guild, "create-ticket");
    if (ticketCh) {
      try {
        await sendTicketPanel(ticketCh);
        results.push(`✅ ${ticketCh} — ticket panel refreshed`);
      } catch (err) {
        results.push(`❌ #create-ticket — failed: ${err.message}`);
      }
    } else {
      results.push(`⚠️ \`#create-ticket\` — channel not found, skipped`);
    }

    return interaction.editReply({ content: `🔄 **Refreshed embeds (${results.length} channels):**\n${results.join("\n")}\n\n_Note: goodbye & leaderboard messages post automatically — no pinned version to refresh._` });
  }

  // ── /toggle-updates ────────────────────────────────────────────────────────────
  if (commandName === "change-log-channel") {
    const channel = interaction.options.getChannel("channel");
    if (!channel) {
      const had = logChannelOverrides.delete(interaction.guild.id);
      const auto = findChannel(interaction.guild, "log");
      return interaction.reply({
        content: had
          ? `📋 Log channel override cleared. Logs will now go to the auto-detected channel${auto ? ` (${auto})` : " (none found — create a channel with \"log\" in its name)"}.`
          : `ℹ️ No override was set. Logs currently go to ${auto ? `${auto}` : "**no channel** — create one with \"log\" in its name, or run this command with a channel."}.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    if (channel.type !== ChannelType.GuildText) {
      return interaction.reply({ content: "❌ Pick a text channel.", flags: MessageFlags.Ephemeral });
    }
    const me = interaction.guild.members.me;
    const perms = channel.permissionsFor(me);
    if (!perms?.has(PermissionFlagsBits.SendMessages) || !perms?.has(PermissionFlagsBits.EmbedLinks)) {
      return interaction.reply({
        content: `❌ I can't post in ${channel} — I need **Send Messages** and **Embed Links** there.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    logChannelOverrides.set(interaction.guild.id, channel.id);
    return interaction.reply({
      content: `✅ Mod & event logs will now be sent to ${channel}.\n*(Override is in-memory and resets if the bot restarts — re-run this if needed.)*`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (commandName === "toggle-updates") {
    updateAnnouncements = !updateAnnouncements;
    const state = updateAnnouncements ? "🟢 **Enabled**" : "🔴 **Disabled**";
    return interaction.reply({
      content: `🔔 Game update announcements are now ${state}.\n` +
               (updateAnnouncements
                 ? "The bot will ping **@everyone** when CASES Beta updates on Roblox."
                 : "The bot will silently track updates but **won't post announcements** until re-enabled."),
      flags: MessageFlags.Ephemeral,
    });
  }

  // ── /setcoins ─────────────────────────────────────────────────────────────────
  if (commandName === "setcoins") {
    const target = interaction.options.getUser("user") ?? interaction.user;
    const amount = interaction.options.getInteger("amount");
    coins.set(target.id, amount);
    await logEconomyAction(interaction.guild, interaction.member, target, "Set Coins", amount);
    return interaction.reply({
      content: `✅ Set **${target.username}**'s coin balance to **${amount.toLocaleString()} coins**.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // ── /givexp ───────────────────────────────────────────────────────────────────
  if (commandName === "givexp") {
    const target = interaction.options.getUser("user") ?? interaction.user;
    const amount = interaction.options.getInteger("amount");
    const member = interaction.guild?.members.cache.get(target.id) ?? await interaction.guild?.members.fetch(target.id).catch(() => null);
    if (!member) return interaction.reply({ content: "❌ Member not found in this server.", flags: MessageFlags.Ephemeral });
    const data   = getXP(target.id);
    data.xp     += amount;
    const newLvl = getLevel(data.xp);
    const leveled = newLvl > data.level;
    data.level   = newLvl;
    xpStore.set(target.id, data);
    if (leveled) await handleLevelUp(member, newLvl);
    await logEconomyAction(interaction.guild, interaction.member, target, "Give XP", `+${amount}`);
    return interaction.reply({
      content: `✅ Gave **${amount.toLocaleString()} XP** to **${target.username}**. They are now level **${newLvl}** (${data.xp.toLocaleString()} XP total).`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // ── /removexp ─────────────────────────────────────────────────────────────────
  if (commandName === "removexp") {
    const target = interaction.options.getUser("user") ?? interaction.user;
    const amount = interaction.options.getInteger("amount");
    const data   = getXP(target.id);
    data.xp      = Math.max(0, data.xp - amount);
    data.level   = getLevel(data.xp);
    xpStore.set(target.id, data);
    await logEconomyAction(interaction.guild, interaction.member, target, "Remove XP", `-${amount}`);
    return interaction.reply({
      content: `✅ Removed **${amount.toLocaleString()} XP** from **${target.username}**. They are now level **${data.level}** (${data.xp.toLocaleString()} XP remaining).`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // ── /setxp ────────────────────────────────────────────────────────────────────
  if (commandName === "setxp") {
    const target = interaction.options.getUser("user") ?? interaction.user;
    const amount = interaction.options.getInteger("amount");
    const member = interaction.guild?.members.cache.get(target.id) ?? await interaction.guild?.members.fetch(target.id).catch(() => null);
    const newLvl = getLevel(amount);
    const old    = getXP(target.id);
    xpStore.set(target.id, { xp: amount, level: newLvl });
    if (member && newLvl > old.level) await handleLevelUp(member, newLvl);
    await logEconomyAction(interaction.guild, interaction.member, target, "Set XP", amount);
    return interaction.reply({
      content: `✅ Set **${target.username}**'s XP to **${amount.toLocaleString()}** (level **${newLvl}**).`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // ── /resetxp ──────────────────────────────────────────────────────────────────
  if (commandName === "resetxp") {
    const target = interaction.options.getUser("user") ?? interaction.user;
    xpStore.set(target.id, { xp: 0, level: 0 });
    await logEconomyAction(interaction.guild, interaction.member, target, "Reset XP", 0);
    return interaction.reply({
      content: `✅ Reset **${target.username}**'s XP and level back to **0**.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // ── /pay ──────────────────────────────────────────────────────────────────────
  if (commandName === "pay") {
    const target = interaction.options.getUser("user");
    const amount = interaction.options.getInteger("amount");
    const userId = interaction.user.id;
    if (target.id === userId) return interaction.reply({ content: "❌ You can't pay yourself.", flags: MessageFlags.Ephemeral });
    if (target.bot)           return interaction.reply({ content: "❌ You can't pay a bot.",    flags: MessageFlags.Ephemeral });
    const bal = getCoins(userId);
    if (bal < amount) {
      return interaction.reply({
        content: `❌ You only have **${bal.toLocaleString()} coins** and tried to send **${amount.toLocaleString()}**.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    coins.set(userId, bal - amount);
    addCoins(target.id, amount, null);
    return interaction.reply({ embeds: [
      new EmbedBuilder()
        .setTitle("💸 Coins Sent!")
        .setDescription(`**${interaction.user.username}** sent **${amount.toLocaleString()} coins** to ${target}!`)
        .addFields(
          { name: `${interaction.user.username}'s new balance`, value: `${getCoins(userId).toLocaleString()} coins`, inline: true },
          { name: `${target.username}'s new balance`,           value: `${getCoins(target.id).toLocaleString()} coins`, inline: true },
        )
        .setColor(0x57f287)
        .setTimestamp()
    ]});
  }

  // ── /streak ───────────────────────────────────────────────────────────────────
  if (commandName === "streak") {
    const userId = interaction.user.id;
    const s      = loginStreak.get(userId) ?? { lastDate: "", streak: 0 };
    const nextStreakAch = [3, 7, 30].find((goal) => s.streak < goal) ?? null;
    const embed = new EmbedBuilder()
      .setTitle("🔥 Your Daily Streak")
      .setDescription(
        `**Current streak:** ${s.streak} day${s.streak !== 1 ? "s" : ""} 🔥\n` +
        `**Last login:** ${s.lastDate || "Never"}\n\n` +
        (nextStreakAch
          ? `📈 **${nextStreakAch - s.streak} more day(s)** until your next streak achievement (${nextStreakAch}-day milestone)!`
          : "🏆 You've reached the highest streak milestone! Keep it up!")
      )
      .setColor(0xff7043)
      .setThumbnail(interaction.user.displayAvatarURL())
      .setFooter({ text: "Use /daily every day to keep your streak alive!" })
      .setTimestamp();
    return interaction.reply({ embeds: [embed] });
  }

  // ── /achievementprogress ──────────────────────────────────────────────────────
  if (commandName === "achievementprogress") {
    const userId = interaction.user.id;
    const data   = getAchievements(userId);
    const streak = loginStreak.get(userId)?.streak ?? 0;
    const liveProgress = {
      msgs:       activityData.get(userId)?.msgs ?? 0,
      voiceMins:  Math.floor((activityData.get(userId)?.voiceMs ?? 0) / 60000),
      streak,
      invites:    inviteMap.get(userId) ?? 0,
      totalCoins: getCoins(userId),
    };
    const lines = ACHIEVEMENTS.map((ach) => {
      const entry    = data[ach.id] ?? { progress: 0, earned: false };
      const progress = entry.earned ? ach.goal : Math.min(liveProgress[ach.field] ?? entry.progress, ach.goal);
      const pct      = Math.round((progress / ach.goal) * 100);
      const bar      = "█".repeat(Math.floor(pct / 10)) + "░".repeat(10 - Math.floor(pct / 10));
      const status   = entry.earned ? "✅" : "🔲";
      return `${status} ${ach.emoji} **${ach.name}** — ${progress}/${ach.goal}\n\`[${bar}]\` ${pct}%`;
    });
    const embed = new EmbedBuilder()
      .setTitle(`📊 ${interaction.user.username}'s Achievement Progress`)
      .setDescription(lines.join("\n\n"))
      .setColor(0x5865f2)
      .setThumbnail(interaction.user.displayAvatarURL())
      .setTimestamp();
    return interaction.reply({ embeds: [embed] });
  }

  // ── /achievementleaderboard ───────────────────────────────────────────────────
  if (commandName === "achievementleaderboard") {
    const scores = [...achievementData.entries()]
      .map(([uid, data]) => ({ uid, count: Object.values(data).filter((e) => e.earned).length }))
      .filter((e) => e.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    if (scores.length === 0) {
      return interaction.reply({ content: "😢 Nobody has earned any achievements yet! Be the first!", flags: MessageFlags.Ephemeral });
    }

    const medals = ["🥇","🥈","🥉"];
    const lines  = await Promise.all(scores.map(async (entry, i) => {
      const user = await client.users.fetch(entry.uid).catch(() => null);
      const name = user?.username ?? `User ${entry.uid}`;
      const icon = medals[i] ?? `**${i+1}.**`;
      return `${icon} **${name}** — ${entry.count}/${ACHIEVEMENTS.length} achievements`;
    }));

    return interaction.reply({ embeds: [
      new EmbedBuilder()
        .setTitle("🏆 Achievement Leaderboard")
        .setDescription(lines.join("\n"))
        .setColor(0xfee75c)
        .setFooter({ text: "Use /achievementprogress to see your own detailed progress" })
        .setTimestamp()
    ]});
  }

  // ── /buyall ───────────────────────────────────────────────────────────────────
  if (commandName === "buyall") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const userId = interaction.user.id;
    const inv    = getUserInventory(userId);
    const bal    = getCoins(userId);
    const dailyIds = getDailyRotation();

    const toBuy = SHOP_CATALOG.filter((item) => {
      if (inv.has(item.id) && item.type === "role") return false;
      if (getStock(item.id) <= 0) return false;
      return true;
    });

    if (toBuy.length === 0) {
      return interaction.editReply({ content: "✅ You already own everything in the shop!" });
    }

    let total = 0;
    const lines = [];
    for (const item of toBuy) {
      const isDaily = dailyIds.includes(item.id);
      const price   = isDaily ? Math.round(getItemPrice(item) * 0.8) : getItemPrice(item);
      total += price;
      lines.push(`${RARITY_EMOJI[item.rarity]} **${item.name}** — ${price.toLocaleString()} coins${isDaily ? " ⭐" : ""}`);
    }

    const canAfford = bal >= total;
    const embed = new EmbedBuilder()
      .setTitle("🛒 Buy All — Confirmation")
      .setDescription(
        `**${toBuy.length} items** ready to purchase:\n\n` +
        lines.join("\n") +
        `\n\n💰 **Total cost:** ${total.toLocaleString()} coins\n` +
        `💳 **Your balance:** ${bal.toLocaleString()} coins\n` +
        (canAfford
          ? `✅ You can afford this! Click **Confirm** to buy everything.`
          : `❌ You need **${(total - bal).toLocaleString()} more coins** to buy everything.`)
      )
      .setColor(canAfford ? 0x57f287 : 0xed4245)
      .setTimestamp();

    if (!canAfford) return interaction.editReply({ embeds: [embed] });

    buyallPending.set(userId, { items: toBuy, total, expiresAt: Date.now() + 60_000 });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("buyall_confirm").setLabel("✅ Confirm Purchase").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("buyall_cancel").setLabel("❌ Cancel").setStyle(ButtonStyle.Danger),
    );
    return interaction.editReply({ embeds: [embed], components: [row] });
  }

  // ── Button: buyall_confirm / buyall_cancel ────────────────────────────────────
  if (interaction.isButton() && (interaction.customId === "buyall_confirm" || interaction.customId === "buyall_cancel")) {
    const userId  = interaction.user.id;
    const pending = buyallPending.get(userId);
    if (!pending || Date.now() > pending.expiresAt) {
      return interaction.update({ content: "⏰ This purchase expired. Run `/buyall` again.", embeds: [], components: [] });
    }
    buyallPending.delete(userId);

    if (interaction.customId === "buyall_cancel") {
      return interaction.update({ content: "❌ Purchase cancelled.", embeds: [], components: [] });
    }

    const bal = getCoins(userId);
    if (bal < pending.total) {
      return interaction.update({ content: `❌ You no longer have enough coins (need ${pending.total.toLocaleString()}, have ${bal.toLocaleString()}).`, embeds: [], components: [] });
    }

    coins.set(userId, bal - pending.total);
    const purchased = [];
    const dailyIds = getDailyRotation();
    for (const item of pending.items) {
      if (getStock(item.id) <= 0) continue;
      shopStock.set(item.id, getStock(item.id) - 1);
      itemPopularity.set(item.id, (itemPopularity.get(item.id) ?? 0) + 1);
      const inv = getUserInventory(userId);
      const entry = inv.get(item.id) ?? { quantity: 0, acquiredAt: Date.now() };
      entry.quantity++;
      inv.set(item.id, entry);
      if (item.type === "boost" && item.boostType !== "lucky") {
        const boosts = getUserBoosts(userId);
        const expiresAt = Date.now() + item.boostMs;
        if (item.boostType === "xp")   boosts.xp   = Math.max(boosts.xp   ?? 0, expiresAt);
        if (item.boostType === "coin") boosts.coin  = Math.max(boosts.coin ?? 0, expiresAt);
        if (item.boostType === "mega") boosts.mega  = Math.max(boosts.mega ?? 0, expiresAt);
        userBoosts.set(userId, boosts);
      }
      if (item.rarity === "Legendary") {
        const legRole = interaction.guild?.roles.cache.find((r) => r.name === "Legendary Buyer");
        if (legRole && interaction.member) interaction.member.roles.add(legRole).catch(() => {});
      }
      purchased.push(`${RARITY_EMOJI[item.rarity]} **${item.name}**`);
    }

    const successEmbed = new EmbedBuilder()
      .setTitle("✅ Purchase Complete!")
      .setDescription(
        `You bought **${purchased.length} items** for **${pending.total.toLocaleString()} coins**!\n\n` +
        purchased.join("\n") +
        `\n\n💰 Remaining balance: **${getCoins(userId).toLocaleString()} coins**\n` +
        `Use \`/equip <id>\` to equip any role items.`
      )
      .setColor(0x57f287)
      .setTimestamp();
    return interaction.update({ embeds: [successEmbed], components: [] });
  }

  // ── /joke ─────────────────────────────────────────────────────────────────────
  if (commandName === "joke") {
    const cd = checkFunCooldown(interaction.user.id, "joke");
    if (cd) return interaction.reply({ content: `⏳ Cooldown! Try again in **${cd}s**.`, flags: MessageFlags.Ephemeral });
    const joke = JOKES[Math.floor(Math.random() * JOKES.length)];
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle("😂 Random Joke").setDescription(joke).setColor(0xfee75c).setFooter({ text: `Requested by ${interaction.user.username}` }).setTimestamp()] });
  }

  // ── /8ball ────────────────────────────────────────────────────────────────────
  if (commandName === "8ball") {
    const cd = checkFunCooldown(interaction.user.id, "8ball");
    if (cd) return interaction.reply({ content: `⏳ Cooldown! Try again in **${cd}s**.`, flags: MessageFlags.Ephemeral });
    const question = interaction.options.getString("question");
    const response = EIGHTBALL[Math.floor(Math.random() * EIGHTBALL.length)];
    const positive = ["certain","decidedly","doubt","definitely","rely","yes","likely","good","signs","yes."].some(w => response.toLowerCase().includes(w));
    return interaction.reply({ embeds: [
      new EmbedBuilder()
        .setTitle("🎱 Magic 8 Ball")
        .addFields(
          { name: "❓ Question", value: question },
          { name: "🎱 Answer",   value: `**${response}**` }
        )
        .setColor(positive ? 0x57f287 : 0xed4245)
        .setFooter({ text: `Asked by ${interaction.user.username}` })
        .setTimestamp()
    ]});
  }

  // ── /rps ──────────────────────────────────────────────────────────────────────
  if (commandName === "rps") {
    const cd = checkFunCooldown(interaction.user.id, "rps");
    if (cd) return interaction.reply({ content: `⏳ Cooldown! Try again in **${cd}s**.`, flags: MessageFlags.Ephemeral });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("rps_rock").setLabel("🪨 Rock").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("rps_paper").setLabel("📄 Paper").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("rps_scissors").setLabel("✂️ Scissors").setStyle(ButtonStyle.Secondary),
    );
    return interaction.reply({ embeds: [
      new EmbedBuilder().setTitle("✂️ Rock Paper Scissors").setDescription("Choose your move!").setColor(0x5865f2).setFooter({ text: "vs Cases 2.0" })
    ], components: [row] });
  }

  // ── Button: rps_rock / rps_paper / rps_scissors ───────────────────────────────
  if (interaction.isButton() && ["rps_rock","rps_paper","rps_scissors"].includes(interaction.customId)) {
    const moves   = ["rock","paper","scissors"];
    const emojis  = { rock: "🪨", paper: "📄", scissors: "✂️" };
    const player  = interaction.customId.replace("rps_","");
    const bot     = moves[Math.floor(Math.random() * 3)];
    let result, color;
    if (player === bot) { result = "🤝 It's a tie!"; color = 0xfee75c; }
    else if ((player==="rock"&&bot==="scissors")||(player==="paper"&&bot==="rock")||(player==="scissors"&&bot==="paper")) { result = "🎉 You win!"; color = 0x57f287; }
    else { result = "😂 Bot wins!"; color = 0xed4245; }
    return interaction.update({ embeds: [
      new EmbedBuilder()
        .setTitle("✂️ Rock Paper Scissors — Result")
        .addFields(
          { name: `${interaction.user.username}`, value: `${emojis[player]} **${player.charAt(0).toUpperCase()+player.slice(1)}**`, inline: true },
          { name: "Cases 2.0",                    value: `${emojis[bot]} **${bot.charAt(0).toUpperCase()+bot.slice(1)}**`, inline: true },
        )
        .setDescription(`\n**${result}**`)
        .setColor(color)
        .setTimestamp()
    ], components: [] });
  }

  // ── /roast ────────────────────────────────────────────────────────────────────
  if (commandName === "roast") {
    const cd = checkFunCooldown(interaction.user.id, "roast");
    if (cd) return interaction.reply({ content: `⏳ Cooldown! Try again in **${cd}s**.`, flags: MessageFlags.Ephemeral });
    const target = interaction.options.getUser("user");
    if (target.id === client.user.id) return interaction.reply({ content: "Nice try 😂 You can't roast me!", flags: MessageFlags.Ephemeral });
    const roast = ROASTS[Math.floor(Math.random() * ROASTS.length)];
    return interaction.reply({ embeds: [
      new EmbedBuilder()
        .setTitle("🔥 Roasted!")
        .setDescription(`${target} — ${roast}`)
        .setColor(0xed4245)
        .setFooter({ text: `Roasted by ${interaction.user.username} • All in good fun 😂` })
        .setThumbnail(target.displayAvatarURL())
        .setTimestamp()
    ]});
  }

  // ── /hug ──────────────────────────────────────────────────────────────────────
  if (commandName === "hug") {
    const cd = checkFunCooldown(interaction.user.id, "hug");
    if (cd) return interaction.reply({ content: `⏳ Cooldown! Try again in **${cd}s**.`, flags: MessageFlags.Ephemeral });
    const target = interaction.options.getUser("user");
    const msg    = HUG_MSGS[Math.floor(Math.random() * HUG_MSGS.length)];
    return interaction.reply({ embeds: [
      new EmbedBuilder()
        .setTitle("🤗 Hug!")
        .setDescription(`**${interaction.user.username}** ${msg} **${target.username}** 💛`)
        .setColor(0xfee75c)
        .setThumbnail(target.displayAvatarURL())
        .setTimestamp()
    ]});
  }

  // ── /coinflip ─────────────────────────────────────────────────────────────────
  if (commandName === "coinflip") {
    const cd = checkFunCooldown(interaction.user.id, "coinflip");
    if (cd) return interaction.reply({ content: `⏳ Cooldown! Try again in **${cd}s**.`, flags: MessageFlags.Ephemeral });
    const result = Math.random() < 0.5 ? "Heads" : "Tails";
    return interaction.reply({ embeds: [
      new EmbedBuilder()
        .setTitle("🪙 Coin Flip!")
        .setDescription(`The coin spins through the air...\n\n# ${result === "Heads" ? "🪙 HEADS" : "🔵 TAILS"}`)
        .setColor(result === "Heads" ? 0xfee75c : 0x5865f2)
        .setFooter({ text: `Flipped by ${interaction.user.username}` })
        .setTimestamp()
    ]});
  }

  // ── /trivia ───────────────────────────────────────────────────────────────────
  if (commandName === "trivia") {
    const cd = checkFunCooldown(interaction.user.id, "trivia");
    if (cd) return interaction.reply({ content: `⏳ Cooldown! Try again in **${cd}s**.`, flags: MessageFlags.Ephemeral });
    const userId = interaction.user.id;
    const q = TRIVIA_QUESTIONS[Math.floor(Math.random() * TRIVIA_QUESTIONS.length)];
    triviaActive.set(userId, { correct: q.answer, reward: q.reward, expiresAt: Date.now() + 30_000 });
    const letters = ["🇦", "🇧", "🇨"];
    const row = new ActionRowBuilder().addComponents(
      q.choices.map((c, i) =>
        new ButtonBuilder().setCustomId(`trivia_${i}`).setLabel(`${["A","B","C"][i]}: ${c}`).setStyle(ButtonStyle.Primary)
      )
    );
    return interaction.reply({ embeds: [
      new EmbedBuilder()
        .setTitle("🧠 Trivia Time!")
        .setDescription(`**${q.q}**\n\n${q.choices.map((c,i) => `${letters[i]} ${c}`).join("\n")}\n\n⏰ You have **30 seconds** to answer!\n🏆 Reward: **${q.reward} coins** if correct`)
        .setColor(0x5865f2)
        .setFooter({ text: `Requested by ${interaction.user.username}` })
        .setTimestamp()
    ], components: [row] });
  }

  // ── Button: shop_page_N ───────────────────────────────────────────────────────
  if (interaction.isButton() && /^shop_page_\d+$/.test(interaction.customId)) {
    const targetPage = parseInt(interaction.customId.replace("shop_page_", ""), 10);
    const { embed, pages, page } = buildShopEmbed(targetPage);
    const row = buildShopRow(page, pages);
    return interaction.update({ embeds: [embed], components: row ? [row] : [] });
  }

  // ── /equip-all ────────────────────────────────────────────────────────────────
  if (commandName === "equip-all") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const inv      = getUserInventory(interaction.user.id);
    const roleItems = SHOP_CATALOG.filter((item) => item.type === "role" && inv.has(item.id));

    if (roleItems.length === 0) {
      return interaction.editReply({ content: "📦 You don't own any role items yet. Use `/buy` to get some from the shop!" });
    }

    const equipped = [];
    const skipped  = [];
    const failed   = [];

    for (const item of roleItems) {
      let role = interaction.guild.roles.cache.find((r) => r.name === item.roleName);
      if (!role) {
        try { role = await interaction.guild.roles.create({ name: item.roleName, reason: "equip-all" }); }
        catch { failed.push(item.name); continue; }
      }
      if (interaction.member.roles.cache.has(role.id)) {
        skipped.push(item.name);
        continue;
      }
      try {
        await interaction.member.roles.add(role);
        equipped.push(`${RARITY_EMOJI[item.rarity]} **${item.name}** → \`${item.roleName}\``);
      } catch { failed.push(item.name); }
    }

    const lines = [];
    if (equipped.length) lines.push(`✅ **Equipped (${equipped.length}):**\n${equipped.join("\n")}`);
    if (skipped.length)  lines.push(`⏭️ **Already equipped (${skipped.length}):** ${skipped.join(", ")}`);
    if (failed.length)   lines.push(`❌ **Failed (${failed.length}):** ${failed.join(", ")}`);

    return interaction.editReply({ embeds: [
      new EmbedBuilder()
        .setTitle("✨ Equip All Complete")
        .setDescription(lines.join("\n\n") || "Nothing to do.")
        .setColor(equipped.length ? 0x57f287 : 0x99aab5)
        .setTimestamp()
    ]});
  }

  // ── /setupchannel ─────────────────────────────────────────────────────────────
  if (commandName === "setupchannel") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const ch = interaction.channel;

    // Guard: already set up
    if (setupChannels.has(ch.id)) {
      return interaction.editReply({ content: "✅ This channel already has a setup panel. Nothing was changed." });
    }

    // Detect type from channel name
    const type = detectChannelType(ch.name);
    if (!type) {
      return interaction.editReply({
        content: `❓ Couldn't auto-detect this channel's type from its name.\n\n**Recognised keywords:**\n• \`events\`, \`event\`\n• \`giveaway\`, \`giveaways\`\n• \`changelog\`, \`change-log\`, \`updates\`\n• \`sneak\`, \`sneak-peek\`, \`preview\`\n• \`announcement\`, \`announcements\`, \`announce\`\n• \`dev\`, \`dev-blog\`, \`development\`, \`blog\``,
      });
    }

    // Find or create the ping role and "No Pings" role
    let pingRole, bypassRole;
    try {
      pingRole   = await findOrCreateRole(interaction.guild, PING_ROLE_CONFIG[type].roleName);
      bypassRole = await findOrCreateRole(interaction.guild, PING_BYPASS_ROLE);
    } catch (err) {
      return interaction.editReply({ content: `❌ Couldn't create roles: ${err.message}` });
    }

    // Double-check: does a bot embed already exist in this channel?
    const recent = await ch.messages.fetch({ limit: 10 }).catch(() => null);
    const alreadyHasPanel = recent?.some(
      (m) => m.author.id === client.user.id && m.embeds.length > 0 && m.components.length > 0
    );
    if (alreadyHasPanel) {
      setupChannels.add(ch.id);
      saveData();
      return interaction.editReply({ content: "✅ A panel already exists in this channel. Marked as set up — nothing was changed." });
    }

    // Post the embed + button row
    const embed = buildSetupChannelEmbed(type, interaction.guild);
    const row   = buildPingRoleRow(type);
    await ch.send({ embeds: [embed], components: [row] });

    setupChannels.add(ch.id);
    saveData();

    const cfg = PING_ROLE_CONFIG[type];
    return interaction.editReply({
      content: `✅ **#${ch.name}** is set up!\n• Created/reused role: **${cfg.roleName}**\n• Created/reused bypass role: **${PING_BYPASS_ROLE}**\n\nMembers can click the buttons to opt in/out of pings.`,
    });
  }

  // ── Button: pingrole_* ────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("pingrole_")) {
    const key    = interaction.customId.replace("pingrole_", "");
    const member = interaction.member;

    if (key === "nopings") {
      const role = interaction.guild.roles.cache.find((r) => r.name.toLowerCase() === PING_BYPASS_ROLE.toLowerCase())
        ?? await findOrCreateRole(interaction.guild, PING_BYPASS_ROLE).catch(() => null);
      if (!role) return interaction.reply({ content: "❌ Could not find the No Pings role.", flags: MessageFlags.Ephemeral });

      const hasRole = member.roles.cache.has(role.id);
      if (hasRole) {
        await member.roles.remove(role);
        return interaction.reply({
          content: "🔔 **Pings re-enabled.** You'll receive pings from the roles you've opted into.",
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await member.roles.add(role);
        return interaction.reply({
          content: `🚫 **All pings silenced.** You have the **${PING_BYPASS_ROLE}** role — bot broadcast pings will skip you.\n\n💡 Tip: You can also mute individual ping roles in your server notification settings.`,
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    const cfg = PING_ROLE_CONFIG[key];
    if (!cfg) return interaction.reply({ content: "❌ Unknown role type.", flags: MessageFlags.Ephemeral });

    const role = interaction.guild.roles.cache.find((r) => r.name.toLowerCase() === cfg.roleName.toLowerCase())
      ?? await findOrCreateRole(interaction.guild, cfg.roleName).catch(() => null);
    if (!role) return interaction.reply({ content: "❌ Could not find the ping role.", flags: MessageFlags.Ephemeral });

    const hasRole = member.roles.cache.has(role.id);
    if (hasRole) {
      await member.roles.remove(role);
      return interaction.reply({
        content: `${cfg.emoji} **${cfg.label} pings removed.** You won't be notified for ${cfg.label.toLowerCase()} anymore.`,
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await member.roles.add(role);
      return interaction.reply({
        content: `${cfg.emoji} **${cfg.label} pings enabled!** You'll be notified when ${cfg.label.toLowerCase()} are posted.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  // ── /report ───────────────────────────────────────────────────────────────────
  if (commandName === "report") {
    const target   = interaction.options.getMember("user");
    const reason   = interaction.options.getString("reason");
    const evidence = interaction.options.getString("evidence") ?? null;

    if (!target) return interaction.reply({ content: "❌ Could not find that user.", flags: MessageFlags.Ephemeral });
    if (target.id === interaction.user.id) return interaction.reply({ content: "❌ You cannot report yourself.", flags: MessageFlags.Ephemeral });
    if (target.user.bot) return interaction.reply({ content: "❌ You cannot report a bot.", flags: MessageFlags.Ephemeral });

    const reportEmbed = new EmbedBuilder()
      .setTitle("🚨 Member Report")
      .setColor(0xed4245)
      .addFields(
        { name: "👤 Reported User",  value: `${target} — \`${target.user.tag}\`\nID: \`${target.id}\``, inline: false },
        { name: "🙋 Reported By",    value: `${interaction.user} — \`${interaction.user.tag}\`\nID: \`${interaction.user.id}\``, inline: false },
        { name: "📄 Reason",         value: reason, inline: false },
        { name: "🔗 Reported In",    value: `${interaction.channel} (\`#${interaction.channel.name}\`)`, inline: true },
      )
      .setThumbnail(target.user.displayAvatarURL({ dynamic: true }))
      .setFooter({ text: "Review this report and take action if needed." })
      .setTimestamp();

    if (evidence) reportEmbed.addFields({ name: "🖼️ Evidence", value: evidence, inline: false });

    const logCh = getLogChannel(interaction.guild);
    const staffCh = findChannel(interaction.guild, "staff-chat");
    const destination = logCh ?? staffCh;

    if (destination) {
      await destination.send({ embeds: [reportEmbed] });
    } else {
      console.warn("[Report] No log or staff-chat channel found to post report.");
    }

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("✅ Report Submitted")
          .setDescription(`Your report against **${target.user.username}** has been sent to staff.\n\nReports are anonymous — staff will not be told who submitted this.`)
          .setColor(0x57f287)
          .setTimestamp()
      ],
      flags: MessageFlags.Ephemeral,
    });
  }

  // ── Button: trivia_0 / trivia_1 / trivia_2 ────────────────────────────────────
  if (interaction.isButton() && /^trivia_[012]$/.test(interaction.customId)) {
    const userId  = interaction.user.id;
    const state   = triviaActive.get(userId);
    if (!state) return interaction.update({ content: "❓ No active trivia for you. Run `/trivia`!", embeds: [], components: [] });
    triviaActive.delete(userId);
    if (Date.now() > state.expiresAt) return interaction.update({ content: "⏰ Time's up! The question expired.", embeds: [], components: [] });
    const chosen = parseInt(interaction.customId.replace("trivia_",""), 10);
    if (chosen === state.correct) {
      addCoins(userId, state.reward, null);
      const triviaWins = (triviaActive.get(`${userId}_wins`) ?? 0) + 1;
      triviaActive.set(`${userId}_wins`, triviaWins);
      if (triviaWins >= 10) {
        const masterRole = interaction.guild?.roles.cache.find((r) => r.name === "Trivia Master");
        if (masterRole && interaction.member) interaction.member.roles.add(masterRole).catch(() => {});
      }
      return interaction.update({ embeds: [
        new EmbedBuilder().setTitle("✅ Correct!").setDescription(`Nice one! You earned **${state.reward} coins**!\n💰 Balance: **${getCoins(userId).toLocaleString()} coins**`).setColor(0x57f287).setTimestamp()
      ], components: [] });
    } else {
      return interaction.update({ embeds: [
        new EmbedBuilder().setTitle("❌ Wrong!").setDescription(`Not quite! Better luck next time. Use \`/trivia\` to try again!`).setColor(0xed4245).setTimestamp()
      ], components: [] });
    }
  }

  } catch (err) {
    console.error(`[Interaction Error] ${commandName ?? interaction.customId}:`, err.message, err.stack);
    try {
      const msg = { content: "❌ Something went wrong. Please try again.", flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) await interaction.editReply(msg);
      else await interaction.reply(msg);
    } catch (_) {}
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────

if (!process.env.DISCORD_TOKEN) {
  console.error("ERROR: DISCORD_TOKEN is not set. Add it in Railway → Variables.");
  process.exit(1);
}
client.login(process.env.DISCORD_TOKEN);
