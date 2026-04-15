/**
 * index.js — RFU Observer Bot
 * - HTTP health-check server (required by Railway to keep process alive)
 * - Whale movement alerts every 15 minutes
 * - /verify slash command for Observer Protocol NFT gating
 */

require('dotenv').config();

const http = require('http');
http.createServer((req, res) => res.end('OK')).listen(process.env.PORT || 3000);

const { Client, GatewayIntentBits, EmbedBuilder, ActivityType } = require('discord.js');
const { pollAll } = require('./monitor');
const { handleVerify } = require('./verify');

// ── Validate required env vars ────────────────────────────────────────────────
const REQUIRED = ['DISCORD_BOT_TOKEN', 'DISCORD_CHANNEL_ID'];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error('❌ Missing required env vars:', missing.join(', '));
  console.error('Set them in Railway → Variables tab, then redeploy.');
  process.exit(1);
}

const CHANNEL_ID    = process.env.DISCORD_CHANNEL_ID;
const POLL_INTERVAL = 15 * 60 * 1000; // 15 minutes
const SITE_URL      = 'https://rareformu.io/#observer-section';

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
});

// ── Build alert embed ─────────────────────────────────────────────────────────
function buildAlertEmbed(alert) {
  const typeLabels = {
    transfer:    'Whale Transfer',
    cex_deposit: 'CEX Deposit',
    dex_swap:    'DEX Swap',
  };

  const embed = new EmbedBuilder()
    .setColor(alert.color)
    .setTitle(`${alert.emoji} ${alert.chain} — ${typeLabels[alert.type] || 'Movement Detected'}`)
    .setDescription(`*"${alert.teaser}"*`)
    .addFields(
      { name: 'Amount', value: alert.amount, inline: true },
      { name: '≈ USD',  value: alert.usd,    inline: true },
      { name: 'Type',   value: typeLabels[alert.type] || '—', inline: true },
      {
        name: 'Full Analysis',
        value: `[Observer Protocol →](${SITE_URL})\nMint access to unlock the full briefing.`,
      }
    )
    .setFooter({ text: 'RareForm United — The Board sees all moves.' })
    .setTimestamp();

  if (alert.explorer) {
    embed.setURL(alert.explorer);
    embed.addFields({ name: 'On-Chain', value: `[View →](${alert.explorer})`, inline: true });
  }

  return embed;
}

// ── Post alerts ───────────────────────────────────────────────────────────────
async function postAlerts(alerts) {
  if (!alerts.length) return;
  if (!client.isReady()) { console.warn('[bot] Client not ready — skipping post'); return; }

  let channel;
  try {
    channel = await client.channels.fetch(CHANNEL_ID);
  } catch (err) {
    console.error('[bot] Cannot fetch channel:', err.message);
    return;
  }

  if (!channel?.isTextBased()) {
    console.error('[bot] Channel not text-based:', CHANNEL_ID);
    return;
  }

  for (const alert of alerts) {
    try {
      await channel.send({ embeds: [buildAlertEmbed(alert)] });
      console.log(`[bot] Posted ${alert.chain} — ${alert.amount} (${alert.usd})`);
      await new Promise(r => setTimeout(r, 1200));
    } catch (err) {
      console.error(`[bot] Failed to post ${alert.chain} alert:`, err.message);
    }
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────
let pollRunning = false;

async function runPoll() {
  if (pollRunning) { console.log('[monitor] Previous poll still running — skipping'); return; }
  pollRunning = true;
  console.log(`[monitor] Polling at ${new Date().toISOString()}`);
  try {
    const alerts = await pollAll();
    console.log(`[monitor] ${alerts.length} alert(s) detected`);
    if (alerts.length) await postAlerts(alerts);
  } catch (err) {
    console.error('[monitor] Poll error:', err.message);
  } finally {
    pollRunning = false;
  }
}

// ── Slash command handler ─────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'verify') return;

  await handleVerify(interaction).catch(err => {
    console.error('[verify] Error:', err.message);
    const reply = { content: 'Verification error — please try again.', ephemeral: true };
    if (!interaction.replied && !interaction.deferred) interaction.reply(reply).catch(() => {});
    else interaction.editReply(reply).catch(() => {});
  });
});

// ── Discord event handlers ────────────────────────────────────────────────────
client.once('clientReady', () => {
  console.log(`✅ Observer Bot online — ${client.user.tag}`);
  client.user.setActivity('The Board', { type: ActivityType.Watching });

  // First poll 15s after ready, then every 15 min
  setTimeout(runPoll, 15_000);
  setInterval(runPoll, POLL_INTERVAL);
});

client.on('disconnect', () => console.warn('[discord] Disconnected'));
client.on('reconnecting', () => console.log('[discord] Reconnecting…'));
client.on('error', err => console.error('[discord] Client error:', err.message));

// ── Global error safety net ───────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message);
  // Don't exit — let Railway restart policy handle truly fatal errors
});

// ── Login with retry ──────────────────────────────────────────────────────────
async function login(attempts = 0) {
  try {
    await client.login(process.env.DISCORD_BOT_TOKEN);
  } catch (err) {
    console.error(`[login] Attempt ${attempts + 1} failed:`, err.message);
    if (err.message.includes('TOKEN_INVALID') || err.message.includes('Improper token')) {
      console.error('[login] Token is invalid. Regenerate it at discord.com/developers and update DISCORD_BOT_TOKEN in Railway Variables.');
      process.exit(1); // fatal — no point retrying
    }
    if (attempts < 5) {
      const delay = (attempts + 1) * 5000;
      console.log(`[login] Retrying in ${delay / 1000}s…`);
      await new Promise(r => setTimeout(r, delay));
      return login(attempts + 1);
    }
    console.error('[login] Max retries reached. Exiting.');
    process.exit(1);
  }
}

login();
