/**
 * index.js — RFU Observer Bot
 * - HTTP health-check server (required by Railway to keep process alive)
 * - Whale movement alerts every 15 minutes
 * - /verify slash command for Observer Protocol NFT gating
 * - /agent-status and /agent-escrow slash commands for agent introspection
 * - /my-revenue, /revenue-stats, /revenue-explainer for holder revenue
 */

require('dotenv').config();
const {verifyAlert,rpcFromEnv,reservePublication,evidenceMessage}=require('./alert-evidence.cjs');

const express = require('express');
const crypto  = require('crypto');

const { Client, GatewayIntentBits, EmbedBuilder, ActivityType, SlashCommandBuilder } = require('discord.js');
const { pollAll } = require('./monitor');
const { handleVerify } = require('./verify');
const { handleAgentStatus } = require('./agent-status');
const { handleAgentEscrow } = require('./agent-escrow');
const { handleMyRevenue } = require('./my-revenue');
const { handleRevenueStats } = require('./revenue-stats');
const { handleRevenueExplainer } = require('./revenue-explainer');

// ── Alert ring buffer — last 100 /agent-alert payloads (in-memory, no DB) ────
const ALERT_BUFFER_MAX = 100;
const alertBuffer = [];

function extractSource(payload) {
  const c = (payload.content ?? '').toUpperCase();
  if (c.includes('WHALE FLOW') || c.includes('WHALE_FLOW')) return 'whale-flow';
  if (c.includes('JUPITER')) return 'jupiter-swap';
  if (payload.type && payload.type !== 'observe' && payload.type !== 'custom') return payload.type;
  return 'unknown';
}

function pushAlert(payload) {
  alertBuffer.push({
    source:     extractSource(payload),
    ts:         Date.now(),
    signalId:   payload.meta?.signalId ?? null,
    confidence: payload.meta?.confidence ?? null,
  });
  if (alertBuffer.length > ALERT_BUFFER_MAX) alertBuffer.shift();
}

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

// ── Slash command definitions (registered on ready) ───────────────────────────
const SLASH_COMMANDS = [
  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Verify your Observer Protocol NFT ownership and claim the Elite Observer role.')
    .addStringOption(opt =>
      opt.setName('wallet')
        .setDescription('Your Solana wallet address (public key)')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('agent-status')
    .setDescription('Show active monitors, signal counts, and last alert time (last 24h).'),

  new SlashCommandBuilder()
    .setName('agent-escrow')
    .setDescription('Query on-chain escrow state for an Observer NFT (devnet).')
    .addStringOption(opt =>
      opt.setName('nft_mint')
        .setDescription('Observer NFT mint address (omit to use DEFAULT_TEST_NFT_MINT)')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('my-revenue')
    .setDescription('Show your RFU holder revenue, tier, and claim link.'),

  new SlashCommandBuilder()
    .setName('revenue-stats')
    .setDescription('Show aggregate RFU holder revenue stats.'),

  new SlashCommandBuilder()
    .setName('revenue-explainer')
    .setDescription('Explain how RFU agent-to-agent revenue flows to NFT holders.'),
].map(cmd => cmd.toJSON());

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
});

// ── Webhook HTTP server (Railway health-check + /agent-alert) ─────────────────
// Wrapped in try/catch: startup failure logs but does not crash /verify or the
// 15-min poll loop.
try {
  const webhookApp = express();

  // Capture raw body before JSON parsing so HMAC covers the exact bytes sent.
  webhookApp.use(express.json({
    verify: (req, _res, buf) => { req.rawBody = buf; },
  }));

  // Railway healthcheck — must return 2xx on GET /
  webhookApp.get('/', (_req, res) => res.send('OK'));

  webhookApp.post('/agent-alert', async (req, res) => {
    // ── Auth ──────────────────────────────────────────────────────────────────
    const secret = process.env.AGENT_WEBHOOK_SECRET;
    const sig    = req.headers['x-agent-signature'];
    if (!secret || !sig) {
      return res.status(401).json({ error: 'missing signature' });
    }
    const expected = crypto.createHmac('sha256', secret)
      .update(req.rawBody)
      .digest('hex');
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    const valid  = sigBuf.length === expBuf.length &&
                   crypto.timingSafeEqual(sigBuf, expBuf);
    if (!valid) {
      return res.status(401).json({ error: 'bad signature' });
    }

    // ── Payload validation ────────────────────────────────────────────────────
    const { holderId, type } = req.body ?? {};
    const safe=await verifyAlert({...req.body,signal_type:type},rpcFromEnv());
    if(!safe)return res.status(422).json({error:'no_evidence_no_alert'});
    const content=evidenceMessage(safe);
    if (!type || !content) {
      return res.status(400).json({ error: 'missing required fields: type, content' });
    }
    if (!client.isReady()) {
      return res.status(503).json({ error: 'discord client not ready' });
    }
    const sink=type==='observe'?'discord:'+CHANNEL_ID:'discord-dm:'+holderId;
    if(!await reservePublication(safe,sink))return res.status(409).json({error:'duplicate_or_reservation_unavailable'});

    // ── Buffer every authenticated alert for /agent-status ────────────────────
    pushAlert({type:'ONCHAIN_ACTIVITY',content,meta:{signalId:safe.alert_id}});

    // ── Observe-mode: post to channel, no DM path ─────────────────────────────
    if (type === 'observe') {
      try {
        const ch = await client.channels.fetch(CHANNEL_ID);
        await ch.send({ content });
        console.log(`[webhook] Observe alert posted to channel ${CHANNEL_ID}`);
        return res.json({ ok: true, delivery: 'channel' });
      } catch (chErr) {
        console.error(`[webhook] Observe channel post failed:`, chErr.message);
        return res.status(500).json({ error: 'channel delivery failed', detail: chErr.message });
      }
    }

    // ── Active-mode: DM first, channel fallback ───────────────────────────────
    if (!holderId) {
      return res.status(400).json({ error: 'holderId required for non-observe alerts' });
    }

    try {
      const user = await client.users.fetch(holderId);
      await user.send({ content });
      console.log(`[webhook] DM delivered to holderId=${holderId}`);
      return res.json({ ok: true, delivery: 'dm' });
    } catch (dmErr) {
      console.warn(`[webhook] DM to ${holderId} failed (${dmErr.message}) — trying channel fallback`);
    }

    // Never retry an uncertain DM as a channel post. Reservation remains consumed.
    return res.status(500).json({error:'delivery_failed_no_retry'});
  });

  webhookApp.listen(process.env.PORT || 3000, () => {
    console.log(`[webhook] Listening on port ${process.env.PORT || 3000}`);
  });
} catch (webhookErr) {
  console.error('[webhook] Failed to start — /verify and monitor unaffected:', webhookErr.message);
}

// ── Build alert embed ─────────────────────────────────────────────────────────
function buildAlertEmbed(alert) {
  return new EmbedBuilder().setTitle('On-chain activity').setDescription(evidenceMessage(alert)).setFooter({text:'RareForm United'});
}

// ── Plain-text fallback (used when EMBED_LINKS is denied in channel) ──────────
function buildAlertText(alert) { return evidenceMessage(alert); }

// ── Post alerts ───────────────────────────────────────────────────────────────
async function postAlerts(alerts) {
  const verified=[];
  for(const alert of alerts){const safe=await verifyAlert(alert,rpcFromEnv());if(safe&&await reservePublication(safe,'discord:'+CHANNEL_ID))verified.push(safe);}
  // Legacy monitor payloads lack verifiable evidence and are intentionally blocked.
  alerts=verified;
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
      await channel.send({content:evidenceMessage(alert),allowedMentions:{parse:[]}});
      console.log(`[bot] Posted ${alert.chain} — ${alert.amount} (${alert.usd})`);
    } catch (embedErr) {
      // EMBED_LINKS denied in this channel — fall back to formatted text
      if (embedErr.code === 50013 || embedErr.message?.includes('Missing Permissions')) {
        console.warn(`[bot] Embed denied — falling back to text for ${alert.chain} alert`);
        try {
          // No ambiguous-delivery retry or raw narrative fallback.
          console.log(`[bot] Posted (text fallback) ${alert.chain} — ${alert.amount} (${alert.usd})`);
        } catch (textErr) {
          console.error(`[bot] Text fallback also failed for ${alert.chain}:`, textErr.message);
        }
      } else {
        console.error(`[bot] Failed to post ${alert.chain} alert:`, embedErr.message);
      }
    }
    await new Promise(r => setTimeout(r, 1200));
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

  const errReply = (label, err) => {
    console.error(`[${label}] Error:`, err.message);
    const reply = { content: `Error running /${label} — please try again.`, ephemeral: true };
    if (!interaction.replied && !interaction.deferred) interaction.reply(reply).catch(() => {});
    else interaction.editReply(reply).catch(() => {});
  };

  if (interaction.commandName === 'verify') {
    await handleVerify(interaction).catch(err => errReply('verify', err));
  } else if (interaction.commandName === 'my-revenue') {
    await handleMyRevenue(interaction).catch(err => errReply('my-revenue', err));
  } else if (interaction.commandName === 'revenue-stats') {
    await handleRevenueStats(interaction).catch(err => errReply('revenue-stats', err));
  } else if (interaction.commandName === 'revenue-explainer') {
    await handleRevenueExplainer(interaction).catch(err => errReply('revenue-explainer', err));
  } else if (interaction.commandName === 'agent-status') {
    await handleAgentStatus(interaction, alertBuffer).catch(err => errReply('agent-status', err));
  } else if (interaction.commandName === 'agent-escrow') {
    await handleAgentEscrow(interaction, alertBuffer).catch(err => errReply('agent-escrow', err));
  }
});

// ── Discord event handlers ────────────────────────────────────────────────────
client.once('clientReady', async () => {
  console.log(`✅ Observer Bot online — ${client.user.tag}`);
  client.user.setActivity('The Board', { type: ActivityType.Watching });

  // Register slash commands on every boot — guild-scoped (instant) when
  // DISCORD_GUILD_ID is set, otherwise global (~1h propagation).
  try {
    if (process.env.DISCORD_GUILD_ID) {
      const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
      if (guild) {
        await guild.commands.set(SLASH_COMMANDS);
        console.log(`[bot] Registered ${SLASH_COMMANDS.length} slash commands (guild)`);
      } else {
        console.warn('[bot] DISCORD_GUILD_ID set but guild not in cache — falling back to global');
        await client.application.commands.set(SLASH_COMMANDS);
        console.log(`[bot] Registered ${SLASH_COMMANDS.length} slash commands (global)`);
      }
    } else {
      await client.application.commands.set(SLASH_COMMANDS);
      console.log(`[bot] Registered ${SLASH_COMMANDS.length} slash commands (global)`);
    }
  } catch (err) {
    console.error('[bot] Slash command registration failed (non-fatal):', err.message);
  }

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
