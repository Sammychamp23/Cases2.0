const coins      = new Map(); // userId -> number
const xpStore    = new Map(); // userId -> { xp, level }
const warnings   = new Map(); // userId -> [{reason, ts, mod}]
const lastMsgXP  = new Map(); // userId -> timestamp  (1 min cooldown)
const lastMsgCoin= new Map(); // userId -> timestamp  (30 s cooldown)
const lastDaily  = new Map(); // userId -> timestamp  (24 h)
const lastWeekly = new Map(); // userId -> timestamp  (7 d)
const giveaways  = new Map(); // messageId -> giveaway data
const sessions   = new Map(); // messageId -> session data

module.exports = {
  coins,
  xpStore,
  warnings,
  lastMsgXP,
  lastMsgCoin,
  lastDaily,
  lastWeekly,
  giveaways,
  sessions,
};
