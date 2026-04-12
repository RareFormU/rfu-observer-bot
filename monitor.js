/**
 * monitor.js — On-chain whale movement detection
 * Chains: Solana, XRP, SUI
 * Polls every 15 minutes, deduplicates via seen-signature cache.
 */

const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');

// ── Thresholds ────────────────────────────────────────────────────────────────
const WHALE_USD   = parseInt(process.env.WHALE_THRESHOLD_USD || '50000', 10);

// Rough spot prices — used for threshold calculation only (not live feed)
const APPROX_SOL_USD = 170;
const APPROX_XRP_USD = 0.60;
const APPROX_SUI_USD = 3.50;

const SOL_THRESHOLD_LAMPORTS = BigInt(Math.floor((WHALE_USD / APPROX_SOL_USD) * 1e9));
const XRP_THRESHOLD_DROPS    = BigInt(Math.floor((WHALE_USD / APPROX_XRP_USD) * 1e6));
const SUI_THRESHOLD_MIST     = BigInt(Math.floor((WHALE_USD / APPROX_SUI_USD) * 1e9));

// ── Seen-signature caches (in-memory, resets on restart — enough for 24h) ────
const seenSolana = new Set();
const seenXrp    = new Set();
const seenSui    = new Set();
const CACHE_MAX  = 2000;

function addSeen(cache, id) {
  cache.add(id);
  if (cache.size > CACHE_MAX) {
    const [first] = cache;
    cache.delete(first);
  }
}

// ── RFU brand-voice teasers ───────────────────────────────────────────────────
const TEASERS = {
  transfer: [
    'The Queen sees a move forming on {chain}. Something large is in transit.',
    'Quiet hands move first. A position is shifting on {chain}.',
    'An operator is repositioning on {chain}. The Board is adjusting.',
    'Power rarely announces itself. But the ledger does. {chain} shows a significant transfer.',
    'Not all moves are visible at first. This one on {chain} just became visible.',
  ],
  cex_deposit: [
    'Coins are moving toward the exchange on {chain}. Liquidation pressure building, or a trap being set?',
    'The Board detects an inbound CEX deposit on {chain}. Anticipate turbulence.',
    'Someone is loading the cannon on {chain}. Watch the order book.',
    'A deposit to centralized rails on {chain}. The sovereign path leads elsewhere.',
  ],
  dex_swap: [
    'A large on-chain swap just executed on {chain}. Position rotation in progress.',
    'The Board confirms a significant DEX movement on {chain}. Rotation or exit?',
    'On-chain conviction on {chain}. A whale moved without permission from any exchange.',
    'Self-custody in motion on {chain}. A significant swap — no custodian required.',
  ],
};

function teaser(type, chain) {
  const pool = TEASERS[type] || TEASERS.transfer;
  const msg  = pool[Math.floor(Math.random() * pool.length)];
  return msg.replace('{chain}', chain);
}

// ── Formatters ────────────────────────────────────────────────────────────────
function fmtUSD(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}
function fmtAmount(n, symbol, decimals) {
  const val = Number(BigInt(n)) / 10 ** decimals;
  return val.toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' ' + symbol;
}

// ── Solana ────────────────────────────────────────────────────────────────────
async function checkSolana() {
  const alerts = [];
  const rpc    = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
  const conn   = new Connection(rpc, 'confirmed');

  try {
    // Grab recent signatures from the system program (large SOL transfers)
    // We look at recent confirmed transactions touching the System Program
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    const slot = await conn.getSlot('confirmed');

    // Get recent block and scan for large native SOL transfers
    let block;
    try {
      block = await conn.getBlock(slot - 2, {
        maxSupportedTransactionVersion: 0,
        transactionDetails: 'full',
        rewards: false,
      });
    } catch (_) {
      // Block not available yet — skip this cycle
      return alerts;
    }

    if (!block || !block.transactions) return alerts;

    for (const tx of block.transactions) {
      if (!tx.meta || tx.meta.err) continue;
      const sig = tx.transaction.signatures?.[0];
      if (!sig || seenSolana.has(sig)) continue;

      const preBalances  = tx.meta.preBalances  || [];
      const postBalances = tx.meta.postBalances || [];

      // Find largest balance change (absolute value)
      let maxDelta = 0n;
      let maxIdx   = -1;
      for (let i = 0; i < preBalances.length; i++) {
        const delta = BigInt(postBalances[i]) - BigInt(preBalances[i]);
        if (delta > maxDelta) { maxDelta = delta; maxIdx = i; }
      }

      if (maxDelta >= SOL_THRESHOLD_LAMPORTS) {
        addSeen(seenSolana, sig);
        const solAmount  = Number(maxDelta) / 1e9;
        const usdApprox  = Math.round(solAmount * APPROX_SOL_USD);
        const type       = detectSolanaType(tx);
        alerts.push({
          chain:  'Solana',
          emoji:  '◎',
          color:  0x9945FF,
          amount: solAmount.toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' SOL',
          usd:    fmtUSD(usdApprox),
          type,
          sig,
          explorer: `https://solscan.io/tx/${sig}`,
          teaser: teaser(type, 'Solana'),
        });
      }
    }
  } catch (err) {
    console.error('[Solana monitor]', err.message);
  }

  return alerts;
}

function detectSolanaType(tx) {
  // Known CEX deposit addresses (abbreviated — extend as needed)
  const CEX_PROGRAMS = new Set([
    'Gfig6QeZq3sCpbYKTM9K4H9PBdqPb3JXrLvL5B9CvLK', // Coinbase
    '5tzFkiKscXHK5ZXCGbGuygQFNkR1LGGsRfG3eBDHFCQW', // Binance
  ]);
  const accounts = tx.transaction?.message?.accountKeys || [];
  for (const key of accounts) {
    const k = typeof key === 'string' ? key : key.pubkey?.toString();
    if (k && CEX_PROGRAMS.has(k)) return 'cex_deposit';
  }
  // Raydium / Orca / Jupiter program IDs → DEX swap
  const DEX_PROGRAMS = new Set([
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',  // Orca Whirlpools
    'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',  // Jupiter v6
  ]);
  for (const key of accounts) {
    const k = typeof key === 'string' ? key : key.pubkey?.toString();
    if (k && DEX_PROGRAMS.has(k)) return 'dex_swap';
  }
  return 'transfer';
}

// ── XRP ───────────────────────────────────────────────────────────────────────
async function checkXRP() {
  const alerts = [];
  try {
    // XRPL public JSON-RPC REST endpoint
    const resp = await axios.post(
      'https://xrplcluster.com',
      {
        method: 'ledger',
        params: [{ ledger_index: 'validated', transactions: true, expand: true }],
      },
      { timeout: 10000 }
    );

    const ledger = resp.data?.result?.ledger;
    if (!ledger || !Array.isArray(ledger.transactions)) return alerts;

    const ledgerIndex = ledger.ledger_index;

    for (const tx of ledger.transactions) {
      if (tx.TransactionType !== 'Payment') continue;
      if (seenXrp.has(tx.hash)) continue;

      // Amount may be string (XRP drops) or object (IOU token)
      const amountRaw = tx.Amount;
      if (typeof amountRaw !== 'string') continue; // skip IOUs for now

      const drops = BigInt(amountRaw);
      if (drops < XRP_THRESHOLD_DROPS) continue;

      addSeen(seenXrp, tx.hash);

      const xrpAmount = Number(drops) / 1e6;
      const usdApprox = Math.round(xrpAmount * APPROX_XRP_USD);

      alerts.push({
        chain:  'XRP Ledger',
        emoji:  '✕',
        color:  0x00AAE4,
        amount: xrpAmount.toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' XRP',
        usd:    fmtUSD(usdApprox),
        type:   'transfer',
        sig:    tx.hash,
        explorer: `https://xrpscan.com/tx/${tx.hash}`,
        teaser: teaser('transfer', 'XRP Ledger'),
      });
    }
  } catch (err) {
    console.error('[XRP monitor]', err.message);
  }
  return alerts;
}

// ── SUI ───────────────────────────────────────────────────────────────────────
async function checkSUI() {
  const alerts = [];
  try {
    // Query recent checkpoint transactions
    const resp = await axios.post(
      'https://fullnode.mainnet.sui.io',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'suix_queryTransactionBlocks',
        params: [
          {
            filter: { InputObject: '0x2::coin::Coin<0x2::sui::SUI>' },
            options: { showBalanceChanges: true, showInput: false, showEffects: false },
          },
          null,   // cursor
          20,     // limit
          true,   // descending
        ],
      },
      { timeout: 10000 }
    );

    const txs = resp.data?.result?.data || [];

    for (const tx of txs) {
      const digest = tx.digest;
      if (!digest || seenSui.has(digest)) continue;

      const changes = tx.balanceChanges || [];
      let maxGain = 0n;
      for (const change of changes) {
        if (change.coinType !== '0x2::sui::SUI') continue;
        const amt = BigInt(change.amount || 0);
        if (amt > maxGain) maxGain = amt;
      }

      if (maxGain < SUI_THRESHOLD_MIST) continue;

      addSeen(seenSui, digest);

      const suiAmount = Number(maxGain) / 1e9;
      const usdApprox = Math.round(suiAmount * APPROX_SUI_USD);

      alerts.push({
        chain:  'Sui',
        emoji:  '💧',
        color:  0x4DA2FF,
        amount: suiAmount.toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' SUI',
        usd:    fmtUSD(usdApprox),
        type:   'dex_swap',
        sig:    digest,
        explorer: `https://suiscan.xyz/mainnet/tx/${digest}`,
        teaser: teaser('dex_swap', 'Sui'),
      });
    }
  } catch (err) {
    console.error('[SUI monitor]', err.message);
  }
  return alerts;
}

// ── Main poll ─────────────────────────────────────────────────────────────────
async function pollAll() {
  const [solAlerts, xrpAlerts, suiAlerts] = await Promise.allSettled([
    checkSolana(),
    checkXRP(),
    checkSUI(),
  ]);

  const alerts = [
    ...(solAlerts.status  === 'fulfilled' ? solAlerts.value  : []),
    ...(xrpAlerts.status  === 'fulfilled' ? xrpAlerts.value  : []),
    ...(suiAlerts.status  === 'fulfilled' ? suiAlerts.value  : []),
  ];

  return alerts;
}

module.exports = { pollAll };
