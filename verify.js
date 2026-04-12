/**
 * verify.js — /verify slash command
 * Checks if a wallet holds the Observer Protocol Access NFT.
 * Collection mint: A4mK2dc1unr56CC8zr5kdyzK2KgAQ1uiWzbpY7A5Wn1U (mainnet)
 */

const { Connection, PublicKey } = require('@solana/web3.js');

const COLLECTION_MINT = new PublicKey('A4mK2dc1unr56CC8zr5kdyzK2KgAQ1uiWzbpY7A5Wn1U');
const TOKEN_PROGRAM   = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const META_PROGRAM    = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const MINT_SITE       = 'https://rareformu.io/#observer-section';

// Derive Metaplex metadata PDA for a mint
async function metadataPDA(mint) {
  const [pda] = await PublicKey.findProgramAddressSync(
    [
      Buffer.from('metadata'),
      META_PROGRAM.toBuffer(),
      mint.toBuffer(),
    ],
    META_PROGRAM
  );
  return pda;
}

// Scan wallet for Observer Protocol NFT
// Strategy: get all SPL token accounts, for each with amount=1 (NFT),
// fetch raw metadata account and scan bytes for collection mint key
async function walletHoldsObserverNFT(walletAddress) {
  const rpc  = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
  const conn = new Connection(rpc, 'confirmed');

  let walletPk;
  try {
    walletPk = new PublicKey(walletAddress);
  } catch {
    return { holds: false, error: 'Invalid wallet address.' };
  }

  // Get all NFT-like token accounts (amount = 1, decimals = 0)
  let tokenAccounts;
  try {
    const resp = await conn.getParsedTokenAccountsByOwner(walletPk, { programId: TOKEN_PROGRAM });
    tokenAccounts = resp.value.filter(a => {
      const info = a.account.data.parsed.info;
      return (
        info.tokenAmount.decimals === 0 &&
        parseInt(info.tokenAmount.amount, 10) === 1
      );
    });
  } catch (err) {
    return { holds: false, error: 'RPC error checking token accounts: ' + err.message };
  }

  if (tokenAccounts.length === 0) return { holds: false };

  const collectionBytes = COLLECTION_MINT.toBytes();

  // For each NFT, fetch metadata and scan for collection mint key in raw bytes
  const checks = tokenAccounts.map(async (acct) => {
    try {
      const mintAddr = new PublicKey(acct.account.data.parsed.info.mint);
      const metaPDA  = await metadataPDA(mintAddr);
      const metaInfo = await conn.getAccountInfo(metaPDA);
      if (!metaInfo || !metaInfo.data) return false;

      const data = metaInfo.data;
      // Scan raw bytes for the 32-byte collection mint pubkey sequence
      for (let i = 0; i <= data.length - 32; i++) {
        if (data.slice(i, i + 32).every((b, j) => b === collectionBytes[j])) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  });

  const results = await Promise.all(checks);
  return { holds: results.some(Boolean) };
}

// Handle /verify interaction
async function handleVerify(interaction) {
  const walletInput = interaction.options.getString('wallet', true).trim();
  const roleId      = process.env.ELITE_OBSERVER_ROLE_ID;

  await interaction.deferReply({ ephemeral: true });

  const { holds, error } = await walletHoldsObserverNFT(walletInput);

  if (error) {
    return interaction.editReply({
      content: `⚠️ Verification failed: ${error}`,
    });
  }

  if (holds) {
    // Assign Elite Observer role if configured
    if (roleId && interaction.guild) {
      try {
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (!member.roles.cache.has(roleId)) {
          await member.roles.add(roleId);
        }
      } catch (err) {
        console.error('[verify] Role assignment failed:', err.message);
      }
    }

    return interaction.editReply({
      embeds: [{
        color: 0x00ffc8,
        title: '✅ Observer Protocol — Access Confirmed',
        description:
          `Wallet \`${walletInput.slice(0, 8)}…${walletInput.slice(-4)}\` holds an Observer Protocol Access NFT.\n\n` +
          `The **Elite Observer** role has been assigned. You are cleared for full analysis.`,
        footer: { text: 'RareForm United — Become The Architecture' },
        thumbnail: { url: 'https://gateway.irys.xyz/BRsK5DNdRzUuK6FzboheszCBGmMkLXBAPKMNavGvqgeB?ext=png' },
      }],
    });
  }

  // Not verified
  return interaction.editReply({
    embeds: [{
      color: 0xC9A84C,
      title: '🔒 Observer Protocol — Access Denied',
      description:
        `No Observer Protocol NFT detected in wallet \`${walletInput.slice(0, 8)}…${walletInput.slice(-4)}\`.\n\n` +
        `Mint your **Observer Ø1** access token at the link below to unlock full intelligence briefings.`,
      fields: [
        {
          name: 'Mint Price',
          value: '0.5 SOL',
          inline: true,
        },
        {
          name: 'Supply',
          value: '10 total',
          inline: true,
        },
      ],
      url: MINT_SITE,
      footer: { text: 'rareformu.io — Observer Protocol' },
    }],
    components: [{
      type: 1,
      components: [{
        type: 2,
        style: 5,
        label: 'Mint Observer Ø1',
        url: MINT_SITE,
      }],
    }],
  });
}

module.exports = { handleVerify };
