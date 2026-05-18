/**
 * agent-escrow.js — /agent-escrow slash command
 * Derives the escrow PDA for an Observer NFT and reads on-chain state.
 *
 * PDA seeds: ["escrow", nft_mint]  (ESCROW_SEED = b"escrow" in lib.rs)
 * Program:   Ut9ekyMnssoNhwnNCjLcDEgjKMet8MnwwASRvhTu7jo
 *
 * EscrowState layout (Anchor — 8-byte discriminator prefix):
 *   offset  0 —  8 : discriminator
 *   offset  8 — 40 : holder        Pubkey
 *   offset 40 — 72 : agent_auth    Pubkey
 *   offset 72 —104 : nft_mint      Pubkey
 *   offset 104—112 : daily_cap     u64 LE (USDC 6-decimal units)
 *   offset 112—120 : spent_today   u64 LE
 *   offset 120—128 : last_reset_ts i64 LE (unix seconds)
 *   offset 128     : bump          u8
 */

const { Connection, PublicKey } = require('@solana/web3.js');

const OBSERVER_PROGRAM_ID = new PublicKey('Ut9ekyMnssoNhwnNCjLcDEgjKMet8MnwwASRvhTu7jo');
const ESCROW_SEED = Buffer.from('escrow');
const VAULT_SEED  = Buffer.from('vault');
const USDC_DECIMALS = 1_000_000;

async function handleAgentEscrow(interaction, alertBuffer) {
  await interaction.deferReply({ ephemeral: true });

  const mintInput = (interaction.options.getString('nft_mint') ?? process.env.DEFAULT_TEST_NFT_MINT ?? '').trim();
  if (!mintInput) {
    return interaction.editReply('⚠️ No NFT mint provided — pass `nft_mint` or set `DEFAULT_TEST_NFT_MINT`.');
  }

  let nftMint;
  try {
    nftMint = new PublicKey(mintInput);
  } catch {
    return interaction.editReply('⚠️ Invalid NFT mint address.');
  }

  const rpcUrl = process.env.AGENT_ESCROW_RPC ?? 'https://api.devnet.solana.com';
  const conn = new Connection(rpcUrl, 'confirmed');

  // Derive PDAs
  const [escrowPda] = PublicKey.findProgramAddressSync(
    [ESCROW_SEED, nftMint.toBuffer()],
    OBSERVER_PROGRAM_ID,
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [VAULT_SEED, nftMint.toBuffer()],
    OBSERVER_PROGRAM_ID,
  );

  let accountInfo;
  try {
    accountInfo = await conn.getAccountInfo(escrowPda);
  } catch (err) {
    return interaction.editReply(`⚠️ RPC error fetching escrow: ${err.message}`);
  }

  const solscanLink = `https://solscan.io/account/${escrowPda.toBase58()}?cluster=devnet`;
  const mintShort = `${mintInput.slice(0, 8)}…${mintInput.slice(-4)}`;

  if (!accountInfo) {
    return interaction.editReply(
      `⚠️ No escrow found for \`${mintShort}\`.\n` +
      `**PDA:** \`${escrowPda.toBase58()}\`\n` +
      `[→ Solscan (devnet)](${solscanLink})\n\n` +
      `Run \`init-escrow\` to initialize it.`,
    );
  }

  const data = accountInfo.data;
  if (data.length < 129) {
    return interaction.editReply('⚠️ Account data too short — not a valid escrow account.');
  }

  // Parse EscrowState fields
  const dailyCapRaw    = data.readBigUInt64LE(104);
  const spentTodayRaw  = data.readBigUInt64LE(112);
  const lastResetRaw   = data.readBigInt64LE(120);

  const dailyCap   = Number(dailyCapRaw)   / USDC_DECIMALS;
  const spentToday = Number(spentTodayRaw) / USDC_DECIMALS;
  const remaining  = dailyCap - spentToday;
  const lastReset  = new Date(Number(lastResetRaw) * 1000).toUTCString();

  // Vault USDC balance
  let vaultBalance = 0;
  try {
    const bal = await conn.getTokenAccountBalance(vaultPda);
    vaultBalance = bal.value.uiAmount ?? 0;
  } catch {
    // vault may not exist yet or has zero balance
  }

  // total_signals from in-memory buffer (best-effort; not on-chain)
  const totalSignals = alertBuffer.length;

  const fmt = (n) => `$${n.toFixed(4)}`;

  const lines = [
    `🏛 **Agent Escrow — \`${mintShort}\`**`,
    ``,
    `**PDA:** \`${escrowPda.toBase58()}\``,
    `[→ Solscan (devnet)](${solscanLink})`,
    ``,
    `**Vault USDC:**   ${fmt(vaultBalance)}`,
    `**Daily Cap:**    ${fmt(dailyCap)}`,
    `**Spent Today:**  ${fmt(spentToday)}`,
    `**Remaining:**    ${fmt(remaining)}`,
    `**Last Reset:**   ${lastReset}`,
    ``,
    `**Total signals (buffer):** ${totalSignals}`,
    `-# total_spent lifetime not tracked on-chain · Mode: observe`,
  ].join('\n');

  return interaction.editReply({ content: lines });
}

module.exports = { handleAgentEscrow };
