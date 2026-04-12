/**
 * index.js — RFU Observer Bot
 * - Posts whale movement alerts to Discord every 15 minutes
 * - Handles /verify slash command for Observer Protocol NFT gating
 */

require('dotenv').config();

const { Client, GatewayIntentBits, EmbedBuilder, ActivityType } = require('discord.js');
const { pollAll } = require('./monitor');
const { handleVerify } = require('./verify');

// ── Validate required env vars ────────────────────────────────────────────────
const REQUIRED = ['DISCORD_BOT_TOKEN', 'DISCORD_CHANNEL_ID'];
for (const key of REQUIRED) {
  if (!process.env[key]) {
    console.error(`❌ Missing required env var: ${key}`);
    process.exit(1);
  }
}

const CHANNEL_ID     = process.env.DISCORD_CHANNEL_ID;
const POLL_INTERVAL  = 15 * 60 * 1000; // 15 minutes
const SITE_URL       = 'https://rareformu.io/#observer-section';

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
      { name: 'Amount',   value: alert.amount,  inline: true },
      { name: '≈ USD',    value: alert.usd,     inline: true },
      { name: 'Type',     value: typeLabels[alert.type] || '—', inline: true },
      {
        name: 'Full Analysis',
        value: `[Observer Protocol →](${SITE_URL})\nMint access to unlock the full briefing.`,
      }
    )
    .setFooter({
      text: 'RareForm United — The Board sees all moves. Observer Protocol unlocks the full picture.',
    })
    .setTimestamp();

  if (alert.explorer) {
    embed.setURL(alert.explorer);
    embed.addFields({ name: 'On-Chain', value: `[View Transaction →](${alert.explorer})`, inline: true });
  }

  return embed;
}

// ── Post alerts ───────────────────────────────────────────────────────────────
async function postAlerts(alerts) {
  if (!alerts.length) return;

  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.error('[bot] Alert channel not found or not text-based:', CHANNEL_ID);
    return;
  }

  for (const alert of alerts) {
    try {
      await channel.send({ embeds: [buildAlertEmbed(alert)] });
      console.log(`[bot] Posted ${alert.chain} alert — ${alert.amount} (${alert.usd})`);
      // Stagger posts to avoid rate limits
      await new Promise(r => setTimeout(r, 1200));
    } catch (err) {
      console.error(`[bot] Failed to post ${alert.chain} alert:`, err.message);
    }
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────
async function runPoll() {
  console.log(`[monitor] Polling chains at ${new Date().toISOString()}`);
  try {
    const alerts = await pollAll();
    if (alerts.length) {
      console.log(`[monitor] ${alerts.length} alert(s) detected`);
      await postAlerts(alerts);
    } else {
      console.log('[monitor] No significant movements this cycle');
    }
  } catch (err) {
    console.error('[monitor] Poll error:', err.message);
  }
}

// ── Slash command handler ─────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'verify') {
    await handleVerify(interaction).catch(err => {
      console.error('[verify] Unhandled error:', err.message);
      if (!interaction.replied && !interaction.deferred) {
        interaction.reply({ content: 'An error occurred during verification.', ephemeral: true }).catch(() => {});
      }
    });
  }
});

// ── Ready ─────────────────────────────────────────────────────────────────────
client.once('clientReady', async () => {
  console.log(`✅ Observer Bot online — logged in as ${client.user.tag}`);

  client.user.setActivity('The Board', { type: ActivityType.Watching });

  // Initial poll shortly after startup, then regular interval
  setTimeout(runPoll, 10_000);
  setInterval(runPoll, POLL_INTERVAL);
});

// ── Error handling ────────────────────────────────────────────────────────────
client.on('error', err => console.error('[discord.js]', err.message));
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));

// ── Login ─────────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_BOT_TOKEN).catch(err => {
  console.error('❌ Bot login failed:', err.message);
  process.exit(1);
});
