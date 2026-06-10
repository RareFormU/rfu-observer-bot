const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { Connection, PublicKey } = require('@solana/web3.js');
const { getWalletForUser } = require('./wallet-links');

const PROGRAM_ID = new PublicKey(process.env.RFU_RECEIVER_PROGRAM_ID || '1gCdq3CvQZ61A56rgTgEMG8DPRvZPfVCFQrZ8kUHsZG');
const ACCEPTED_MINT = new PublicKey(process.env.RFU_ACCEPTED_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const OBS_COLLECTION = new PublicKey('A4mK2dc1unr56CC8zr5kdyzK2KgAQ1uiWzbpY7A5Wn1U');
const CL_COLLECTION = new PublicKey('6qexjNBu6BYwpbDfpBzywaj7b4NaQKVDFyhEJ4dKLbF3');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const META_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const CLAIM_SCALE = 1_000_000_000_000n;
const CACHE_TTL_MS = 60_000;
const CLAIM_URL = 'https://rareformu.io/board#claim';

const tierNames = ['Initiate', 'Observer', 'Community Layer'];
const cache = new Map();

function readU64(data, offset) {
  return data.readBigUInt64LE(offset);
}

function readU128(data, offset) {
  const lo = data.readBigUInt64LE(offset);
  const hi = data.readBigUInt64LE(offset + 8);
  return lo + (hi << 64n);
}

function decodeHolderClaimAccount(data) {
  if (!Buffer.isBuffer(data) || data.length < 148) throw new Error('Invalid holder claim account');
  let offset = 8;
  const marketplace = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
  const holderWallet = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
  const holderTier = data.readUInt8(offset); offset += 1;
  const nftMint = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
  const weight = data.readUInt16LE(offset); offset += 2;
  const lastClaimedPeriod = readU64(data, offset); offset += 8;
  const pendingAmount = readU64(data, offset); offset += 8;
  const claimedLifetime = readU64(data, offset); offset += 8;
  const bump = data.readUInt8(offset); offset += 1;
  const createdAt = data.readBigInt64LE(offset); offset += 8;
  const updatedAt = data.readBigInt64LE(offset);

  return {
    marketplace,
    holderWallet,
    holderTier,
    tier: tierNames[holderTier] || 'Unknown',
    nftMint,
    weight,
    lastClaimedPeriod,
    pendingAmount,
    claimedLifetime,
    bump,
    createdAt,
    updatedAt,
  };
}

function decodeRevenuePoolAccount(data) {
  if (!Buffer.isBuffer(data) || data.length < 177) throw new Error('Invalid revenue pool account');
  let offset = 8;
  const marketplace = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
  const acceptedMint = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
  const holderPoolVault = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
  const totalReceived = readU64(data, offset); offset += 8;
  const totalDistributedToHolders = readU64(data, offset); offset += 8;
  const totalClaimedByHolders = readU64(data, offset); offset += 8;
  const currentPeriod = readU64(data, offset); offset += 8;
  const periodStartedAt = data.readBigInt64LE(offset); offset += 8;
  const accumulatedPerWeightUnit = readU128(data, offset); offset += 16;
  const totalRegisteredWeight = readU64(data, offset); offset += 8;
  const bump = data.readUInt8(offset); offset += 1;
  const updatedAt = data.readBigInt64LE(offset);

  return {
    marketplace,
    acceptedMint,
    holderPoolVault,
    totalReceived,
    totalDistributedToHolders,
    totalClaimedByHolders,
    currentPeriod,
    periodStartedAt,
    accumulatedPerWeightUnit,
    totalRegisteredWeight,
    bump,
    updatedAt,
  };
}

function claimAmount(accumulatedPerWeightUnit, weight) {
  return (BigInt(accumulatedPerWeightUnit) * BigInt(weight)) / CLAIM_SCALE;
}

function calculateClaimable(pool, claim) {
  const gross = claimAmount(pool.accumulatedPerWeightUnit, claim.weight);
  const claimable = gross + BigInt(claim.pendingAmount) - BigInt(claim.claimedLifetime);
  return claimable > 0n ? claimable : 0n;
}

function formatUsdc(baseUnits) {
  const value = BigInt(baseUnits);
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} USDC`;
}

function shortWallet(wallet) {
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
}

function metadataPDA(mint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), META_PROGRAM.toBuffer(), mint.toBuffer()],
    META_PROGRAM
  );
  return pda;
}

function marketplacePDA(acceptedMint = ACCEPTED_MINT, programId = PROGRAM_ID) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('marketplace'), acceptedMint.toBuffer()],
    programId
  );
  return pda;
}

function revenuePoolPDA(marketplace, programId = PROGRAM_ID) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('revenue-pool'), marketplace.toBuffer()],
    programId
  );
  return pda;
}

function holderClaimPDA(marketplace, holder, nftMint, programId = PROGRAM_ID) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('holder-claim'), marketplace.toBuffer(), holder.toBuffer(), nftMint.toBuffer()],
    programId
  );
  return pda;
}

function metadataHasCollection(data, collectionMint) {
  const collectionBytes = collectionMint.toBytes();
  for (let i = 0; i <= data.length - 32; i += 1) {
    if (data.subarray(i, i + 32).every((b, j) => b === collectionBytes[j])) return true;
  }
  return false;
}

async function findHeldNftMintsByCollection(conn, walletPk, collectionMints = [OBS_COLLECTION, CL_COLLECTION]) {
  const resp = await conn.getParsedTokenAccountsByOwner(walletPk, { programId: TOKEN_PROGRAM });
  const tokenAccounts = resp.value || [];
  const nftAccounts = tokenAccounts.filter((acct) => {
    const info = acct.account.data.parsed.info;
    return info.tokenAmount.decimals === 0 && Number(info.tokenAmount.amount) === 1;
  });

  const held = [];
  for (const acct of nftAccounts) {
    try {
      const mint = new PublicKey(acct.account.data.parsed.info.mint);
      const meta = await conn.getAccountInfo(metadataPDA(mint));
      if (!meta?.data) continue;
      if (collectionMints.some(collection => metadataHasCollection(meta.data, collection))) held.push(mint);
    } catch {
      // Ignore malformed token metadata and keep scanning.
    }
  }
  return held;
}

function buildSummary(wallet, pool, claims) {
  const rows = claims.map((claim) => ({
    ...claim,
    claimable: calculateClaimable(pool, claim),
  }));
  const claimed = rows.reduce((sum, row) => sum + BigInt(row.claimedLifetime), 0n);
  const claimable = rows.reduce((sum, row) => sum + row.claimable, 0n);
  const top = rows.slice().sort((a, b) => b.weight - a.weight)[0];

  return {
    wallet,
    hasHoldings: rows.length > 0,
    claimed,
    claimable,
    total: claimed + claimable,
    tier: top?.tier || null,
    tierWeight: top?.weight || 0,
    claims: rows,
  };
}

function createRevenueService(options = {}) {
  const conn = options.connection || new Connection(process.env.SOLANA_RPC || process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
  const programId = options.programId || PROGRAM_ID;
  const acceptedMint = options.acceptedMint || ACCEPTED_MINT;
  const now = options.now || (() => Date.now());
  const walletCache = options.cache || cache;

  async function getPool() {
    const marketplace = marketplacePDA(acceptedMint, programId);
    const poolPda = revenuePoolPDA(marketplace, programId);
    const account = await conn.getAccountInfo(poolPda);
    if (!account?.data) throw new Error('Revenue pool account not found');
    return { marketplace, pool: decodeRevenuePoolAccount(account.data) };
  }

  async function getWalletRevenue(wallet) {
    const cached = walletCache.get(wallet);
    if (cached && cached.expiresAt > now()) return cached.value;

    const holder = new PublicKey(wallet);
    const { marketplace, pool } = await getPool();
    const mints = await findHeldNftMintsByCollection(conn, holder);
    const claims = [];

    for (const mint of mints) {
      const claimPda = holderClaimPDA(marketplace, holder, mint, programId);
      const account = await conn.getAccountInfo(claimPda);
      if (account?.data) claims.push(decodeHolderClaimAccount(account.data));
    }

    const value = buildSummary(wallet, pool, claims);
    walletCache.set(wallet, { value, expiresAt: now() + CACHE_TTL_MS });
    return value;
  }

  async function getStats() {
    const { marketplace, pool } = await getPool();
    const accounts = await conn.getProgramAccounts(programId, {
      filters: [{ dataSize: 148 }],
    });
    const claims = accounts
      .map((account) => {
        try { return decodeHolderClaimAccount(account.account.data); } catch { return null; }
      })
      .filter(claim => claim && claim.marketplace === marketplace.toBase58());
    const tierCounts = { Initiate: 0, Observer: 0, 'Community Layer': 0 };
    let totalHoldersEarning = 0;
    for (const claim of claims) {
      tierCounts[claim.tier] = (tierCounts[claim.tier] || 0) + 1;
      if (calculateClaimable(pool, claim) > 0n) totalHoldersEarning += 1;
    }
    return {
      totalDistributed: pool.totalDistributedToHolders,
      totalClaimed: pool.totalClaimedByHolders,
      totalHoldersEarning,
      tierCounts,
    };
  }

  return { getWalletRevenue, getStats };
}

const defaultRevenueService = createRevenueService();

function buildMyRevenueEmbed(summary) {
  return new EmbedBuilder()
    .setColor(0x00ffc8)
    .setTitle('RFU Holder Revenue')
    .setDescription(`Wallet ${shortWallet(summary.wallet)} is linked to your Discord account.`)
    .addFields(
      { name: 'Claimable', value: formatUsdc(summary.claimable), inline: true },
      { name: 'Claimed', value: formatUsdc(summary.claimed), inline: true },
      { name: 'Total', value: formatUsdc(summary.total), inline: true },
      { name: 'Tier', value: summary.tier || 'None', inline: true },
      { name: 'Tier Weight', value: String(summary.tierWeight), inline: true }
    )
    .setFooter({ text: 'RareForm United holder revenue' })
    .setTimestamp();
}

function claimButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('claim_revenue')
      .setLabel('Claim')
      .setStyle(ButtonStyle.Primary)
  );
}

async function handleMyRevenue(interaction, service = defaultRevenueService, walletLookup = getWalletForUser) {
  await interaction.deferReply({ ephemeral: true });
  const wallet = walletLookup(interaction.user.id);
  if (!wallet) {
    return interaction.editReply({ content: 'No verified wallet found. Run /verify first.' });
  }

  const summary = await service.getWalletRevenue(wallet);
  if (!summary.hasHoldings) {
    return interaction.editReply({ content: `Wallet ${shortWallet(wallet)} has no holdings registered for holder revenue yet.` });
  }

  return interaction.editReply({
    embeds: [buildMyRevenueEmbed(summary)],
    components: [claimButtonRow()],
  });
}

async function handleClaimButton(interaction) {
  try {
    await interaction.user.send(`Open the RFU dashboard to claim holder revenue: ${CLAIM_URL}`);
    return interaction.reply({ content: 'Claim link sent to your DMs.', ephemeral: true });
  } catch {
    return interaction.reply({ content: `I could not DM you. Claim here: ${CLAIM_URL}`, ephemeral: true });
  }
}

async function handleRevenueStats(interaction, service = defaultRevenueService) {
  await interaction.deferReply();
  const stats = await service.getStats();
  const embed = new EmbedBuilder()
    .setColor(0xC9A84C)
    .setTitle('RFU Holder Revenue Stats')
    .addFields(
      { name: 'Total Distributed', value: formatUsdc(stats.totalDistributed), inline: true },
      { name: 'Total Claimed', value: formatUsdc(stats.totalClaimed), inline: true },
      { name: 'Holders Earning', value: String(stats.totalHoldersEarning), inline: true },
      { name: 'Initiate', value: String(stats.tierCounts.Initiate || 0), inline: true },
      { name: 'Observer', value: String(stats.tierCounts.Observer || 0), inline: true },
      { name: 'Community Layer', value: String(stats.tierCounts['Community Layer'] || 0), inline: true }
    )
    .setTimestamp();
  return interaction.editReply({ embeds: [embed] });
}

async function handleRevenueExplainer(interaction) {
  const embed = new EmbedBuilder()
    .setColor(0x00ffc8)
    .setTitle('How RFU Holder Revenue Works')
    .setDescription(
      'RFU sells an intelligence feed for AI agents. When agents pay for premium research or access, a holder share is routed on-chain to the revenue pool. NFT holders earn by tier weight, and claims happen from the dashboard.'
    )
    .addFields(
      { name: 'Tiers', value: 'Initiate weight 1, Observer weight 3, Community Layer weight 10.' },
      { name: 'Claims', value: 'Discord shows status and sends the dashboard link. Wallet claims are handled outside Discord.' }
    );
  return interaction.reply({ embeds: [embed] });
}

async function handleAgentStatus(interaction, service = defaultRevenueService) {
  await interaction.deferReply();
  const stats = await service.getStats();
  const embed = new EmbedBuilder()
    .setColor(0xC9A84C)
    .setTitle('RFU Observer Agent Status')
    .setDescription('Observer bot online. Whale monitoring loop active.')
    .addFields({ name: 'Total revenue distributed to holders', value: formatUsdc(stats.totalDistributed) });
  return interaction.editReply({ embeds: [embed] });
}

module.exports = {
  CACHE_TTL_MS,
  CLAIM_SCALE,
  calculateClaimable,
  claimAmount,
  createRevenueService,
  decodeHolderClaimAccount,
  decodeRevenuePoolAccount,
  formatUsdc,
  handleAgentStatus,
  handleClaimButton,
  handleMyRevenue,
  handleRevenueExplainer,
  handleRevenueStats,
};
