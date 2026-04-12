# RFU Observer Bot

Discord bot for RareForm United. Posts on-chain whale movement alerts and gates the Elite Observer role via Observer Protocol NFT verification.

---

## Setup

### 1. Create the Discord Application

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. **New Application** → name it "RFU Observer"
3. Go to **Bot** tab → **Add Bot** → copy the **Bot Token** → save as `DISCORD_BOT_TOKEN`
4. Under **Privileged Gateway Intents**, enable: **Server Members Intent**
5. Go to **OAuth2 → General** → copy the **Client ID** → save as `DISCORD_CLIENT_ID`

### 2. Invite the Bot to Your Server

Use this OAuth2 URL (replace `CLIENT_ID`):
```
https://discord.com/api/oauth2/authorize?client_id=CLIENT_ID&permissions=268435456&scope=bot%20applications.commands
```

Permissions needed: `Manage Roles` (268435456) + slash commands.

### 3. Get IDs from Your Server

In Discord: **Settings → Advanced → Developer Mode ON**

- Right-click your server name → **Copy Server ID** → `DISCORD_GUILD_ID`
- Right-click your alerts channel → **Copy Channel ID** → `DISCORD_CHANNEL_ID`
- Create a role called **Elite Observer** → right-click it → **Copy Role ID** → `ELITE_OBSERVER_ROLE_ID`

> **Important:** The bot's role must be ranked **above** Elite Observer in Server Settings → Roles, or it cannot assign it.

### 4. Environment Variables

Copy `.env.example` to `.env` and fill in all values:

```env
DISCORD_BOT_TOKEN=...
DISCORD_CHANNEL_ID=...
DISCORD_GUILD_ID=...
DISCORD_CLIENT_ID=...
ELITE_OBSERVER_ROLE_ID=...
SOLANA_RPC=https://api.mainnet-beta.solana.com
```

### 5. Install Dependencies

```bash
npm install
```

### 6. Register Slash Commands (once)

```bash
node deploy-commands.js
```

Commands register to the guild instantly. Re-run if you add new commands.

### 7. Run Locally

```bash
node index.js
```

---

## Deploy to Railway (free tier, 24/7)

### First Deploy

1. Push this folder to a GitHub repo (can be private)
2. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**
3. Select your repo → Railway auto-detects Node.js

### Set Environment Variables on Railway

In your Railway project → **Variables** tab → add each env var from `.env`:

| Variable | Value |
|---|---|
| `DISCORD_BOT_TOKEN` | your bot token |
| `DISCORD_CHANNEL_ID` | alerts channel ID |
| `DISCORD_GUILD_ID` | server ID |
| `DISCORD_CLIENT_ID` | application client ID |
| `ELITE_OBSERVER_ROLE_ID` | role ID |
| `SOLANA_RPC` | `https://api.mainnet-beta.solana.com` |

### Set Start Command

Railway reads `railway.json` automatically. Start command: `node index.js`

Railway free tier gives **500 hours/month** — enough for one always-on worker.

---

## Usage

### Whale Alerts
Automatic — bot polls every 15 minutes and posts to the configured channel when it detects:
- Solana transfers > ~$50k
- XRP Ledger payments > ~$50k  
- Sui swaps > ~$50k

### NFT Verification
Members run in any channel:
```
/verify wallet:YOUR_SOLANA_ADDRESS
```

Bot checks for Observer Protocol NFT on mainnet. If verified: assigns **Elite Observer** role. If not: sends mint link.

---

## Adjusting Thresholds

Set `WHALE_THRESHOLD_USD` env var to change the alert threshold (default: `50000`).

## Upgrading the RPC

Public Solana mainnet RPC can rate-limit. For higher reliability:
- [Helius](https://helius.xyz) — 1M credits/month free
- Set `SOLANA_RPC=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY`
