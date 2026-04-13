/**
 * verify.js — /verify slash command
 * Checks Observer Protocol NFT (tier 1) and Community Layer NFT (tier 2).
 * Assigns Elite Observer role for tier 1, Inner Circle role for tier 2.
 */

const { Connection, PublicKey } = require('@solana/web3.js');

const OBS_COLLECTION  = new PublicKey('A4mK2dc1unr56CC8zr5kdyzK2KgAQ1uiWzbpY7A5Wn1U');
const CL_COLLECTION   = new PublicKey('6qexjNBu6BYwpbDfpBzywaj7b4NaQKVDFyhEJ4dKLbF3');
const TOKEN_PROGRAM   = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const META_PROGRAM    = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const MINT_SITE       = 'https://rareformu.io/#observer-section';
const CL_MINT_SITE    = 'https://rareformu.io/#community-layer-section';

async function metadataPDA(mint) {
  const [pda] = await PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), META_PROGRAM.toBuffer(), mint.toBuffer()],
    META_PROGRAM
  );
  return pda;
}

// Check if a wallet holds an NFT from a specific collection.
// Returns true/false.
async function walletHoldsCollection(conn, walletPk, collectionMint) {
  const collectionBytes = collectionMint.toBytes();
  const resp = await conn.getParsedTokenAccountsByOwner(walletPk, { programId: TOKEN_PROGRAM });
  const nfts = resp.value.filter(a => {
    const info = a.account.data.parsed.info;
    return info.tokenAmount.decimals === 0 && parseInt(info.tokenAmount.amount, 10) === 1;
  });

  if (!nfts.length) return false;

  const checks = nfts.map(async (acct) => {
    try {
      const mintAddr = new PublicKey(acct.account.data.parsed.info.mint);
      const metaPDA  = await metadataPDA(mintAddr);
      const metaInfo = await conn.getAccountInfo(metaPDA);
      if (!metaInfo?.data) return false;
      const data = metaInfo.data;
      for (let i = 0; i <= data.length - 32; i++) {
        if (data.slice(i, i + 32).every((b, j) => b === collectionBytes[j])) return true;
      }
      return false;
    } catch { return false; }
  });

  const results = await Promise.all(checks);
  return results.some(Boolean);
}

async function handleVerify(interaction) {
  const walletInput    = interaction.options.getString('wallet', true).trim();
  const obsRoleId      = process.env.ELITE_OBSERVER_ROLE_ID;
  const clRoleId       = process.env.INNER_CIRCLE_ROLE_ID;
  const rpc            = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';

  await interaction.deferReply({ ephemeral: true });

  let walletPk;
  try {
    walletPk = new PublicKey(walletInput);
  } catch {
    return interaction.editReply({ content: '⚠️ Invalid wallet address.' });
  }

  const conn = new Connection(rpc, 'confirmed');
  const shortAddr = `${walletInput.slice(0, 8)}…${walletInput.slice(-4)}`;

  let holdsObs = false;
  let holdsCL  = false;

  try {
    holdsObs = await walletHoldsCollection(conn, walletPk, OBS_COLLECTION);
    if (holdsObs) {
      holdsCL = await walletHoldsCollection(conn, walletPk, CL_COLLECTION);
    }
  } catch (err) {
    return interaction.editReply({ content: `⚠️ RPC error: ${err.message}` });
  }

  // ── Tier 2: Community Layer ──────────────────────────────────────────────────
  if (holdsCL) {
    // Assign both roles
    if (interaction.guild) {
      try {
        const member = await interaction.guild.members.fetch(interaction.user.id);
        const toAdd = [obsRoleId, clRoleId].filter(id => id && !member.roles.cache.has(id));
        for (const id of toAdd) await member.roles.add(id);
      } catch (err) {
        console.error('[verify] Role assignment failed:', err.message);
      }
    }

    return interaction.editReply({
      embeds: [{
        color: 0xC9A84C,
        title: '⬡ Community Layer — Inner Circle Confirmed',
        description:
          `Wallet \`${shortAddr}\` holds **both** the Observer Protocol NFT and the Community Layer NFT.\n\n` +
          `The **Inner Circle** role has been assigned. Welcome to the Board.\n\n` +
          `[→ Open Discord Server](https://discord.gg/Aeehd4dK)`,
        footer: { text: 'RareForm United — The Board Sees All Moves' },
        thumbnail: { url: 'https://gateway.irys.xyz/BRsK5DNdRzUuK6FzboheszCBGmMkLXBAPKMNavGvqgeB?ext=png' },
      }],
    });
  }

  // ── Tier 1: Observer Protocol ────────────────────────────────────────────────
  if (holdsObs) {
    if (obsRoleId && interaction.guild) {
      try {
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (!member.roles.cache.has(obsRoleId)) await member.roles.add(obsRoleId);
      } catch (err) {
        console.error('[verify] Role assignment failed:', err.message);
      }
    }

    return interaction.editReply({
      embeds: [{
        color: 0x00ffc8,
        title: '✅ Observer Protocol — Access Confirmed',
        description:
          `Wallet \`${shortAddr}\` holds an Observer Protocol Access NFT.\n\n` +
          `The **Elite Observer** role has been assigned.\n\n` +
          `Eligible for Community Layer — mint at the link below to enter the Inner Circle.`,
        fields: [
          { name: 'Community Layer', value: '2 SOL — 10 supply', inline: true },
          { name: 'Status', value: 'Eligible to mint', inline: true },
        ],
        url: CL_MINT_SITE,
        footer: { text: 'RareForm United — Become The Architecture' },
        thumbnail: { url: 'https://gateway.irys.xyz/BRsK5DNdRzUuK6FzboheszCBGmMkLXBAPKMNavGvqgeB?ext=png' },
      }],
      components: [{
        type: 1,
        components: [{
          type: 2, style: 5,
          label: 'Mint Community Layer',
          url: CL_MINT_SITE,
        }],
      }],
    });
  }

  // ── No access ─────────────────────────────────────────────────────────────────
  return interaction.editReply({
    embeds: [{
      color: 0xC9A84C,
      title: '🔒 Observer Protocol — Access Denied',
      description:
        `No Observer Protocol NFT detected in wallet \`${shortAddr}\`.\n\n` +
        `Mint **Observer Ø1** to access the intelligence layer and qualify for Community Layer.`,
      fields: [
        { name: 'Observer Protocol', value: '0.5 SOL — 10 supply', inline: true },
        { name: 'Community Layer', value: '2 SOL (Observer required)', inline: true },
      ],
      url: MINT_SITE,
      footer: { text: 'rareformu.io — Observer Protocol' },
    }],
    components: [{
      type: 1,
      components: [{
        type: 2, style: 5,
        label: 'Mint Observer Ø1',
        url: MINT_SITE,
      }],
    }],
  });
}

module.exports = { handleVerify };
