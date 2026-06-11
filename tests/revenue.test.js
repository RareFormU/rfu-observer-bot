const assert = require('node:assert/strict');
const test   = require('node:test');
const { Keypair, PublicKey } = require('@solana/web3.js');
const { ButtonStyle } = require('discord.js');

const {
  CLAIM_URL,
  CLAIM_SCALE,
  STATS_TTL_MS,
  createRevenueService,
  formatUsdc,
  sweepExpiredCacheEntries,
} = require('../revenue-service');

const { handleMyRevenue }    = require('../my-revenue');
const { handleRevenueStats } = require('../revenue-stats');

// ── Buffer helpers ────────────────────────────────────────────────────────────

function writePubkey(buf, offset, pubkey) {
  pubkey.toBuffer().copy(buf, offset);
  return offset + 32;
}

function writeU64(buf, offset, value) {
  buf.writeBigUInt64LE(BigInt(value), offset);
  return offset + 8;
}

function writeU128(buf, offset, value) {
  const big = BigInt(value);
  buf.writeBigUInt64LE(big & ((1n << 64n) - 1n), offset);
  buf.writeBigUInt64LE(big >> 64n, offset + 8);
  return offset + 16;
}

function poolData({ marketplace, acceptedMint, accumulated, distributed = 0n, claimed = 0n }) {
  const buf = Buffer.alloc(177);
  let offset = 8;
  offset = writePubkey(buf, offset, marketplace);
  offset = writePubkey(buf, offset, acceptedMint);
  offset = writePubkey(buf, offset, Keypair.generate().publicKey);
  offset = writeU64(buf, offset, distributed);
  offset = writeU64(buf, offset, distributed);
  offset = writeU64(buf, offset, claimed);
  offset = writeU64(buf, offset, 1n);
  buf.writeBigInt64LE(0n, offset); offset += 8;
  offset = writeU128(buf, offset, accumulated);
  offset = writeU64(buf, offset, 14n);
  buf.writeUInt8(255, offset); offset += 1;
  buf.writeBigInt64LE(0n, offset);
  return buf;
}

function claimData({ marketplace, holder, mint, tier = 1, weight = 3, pending = 0n, claimed = 0n }) {
  const buf = Buffer.alloc(148);
  let offset = 8;
  offset = writePubkey(buf, offset, marketplace);
  offset = writePubkey(buf, offset, holder);
  buf.writeUInt8(tier, offset); offset += 1;
  offset = writePubkey(buf, offset, mint);
  buf.writeUInt16LE(weight, offset); offset += 2;
  offset = writeU64(buf, offset, 1n);
  offset = writeU64(buf, offset, pending);
  offset = writeU64(buf, offset, claimed);
  buf.writeUInt8(99, offset); offset += 1;
  buf.writeBigInt64LE(1n, offset); offset += 8;
  buf.writeBigInt64LE(2n, offset);
  return buf;
}

function metadataData(collection) {
  return Buffer.concat([Buffer.from('metadata'), collection.toBuffer(), Buffer.from('tail')]);
}

function fakeInteraction(userId = 'discord-user') {
  const calls = [];
  return {
    user: { id: userId },
    calls,
    replied: false,
    deferred: false,
    async deferReply(payload) {
      this.deferred = true;
      calls.push(['deferReply', payload]);
    },
    async editReply(payload) {
      this.replied = true;
      calls.push(['editReply', payload]);
    },
    async reply(payload) {
      this.replied = true;
      calls.push(['reply', payload]);
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('/my-revenue happy path renders private revenue embed with claim button', async () => {
  const interaction = fakeInteraction();
  const wallet = Keypair.generate().publicKey.toBase58();
  const service = {
    async getWalletRevenue() {
      return {
        wallet,
        hasHoldings: true,
        claimed: 1_000_000n,
        claimable: 2_500_000n,
        total: 3_500_000n,
        tier: 'Observer',
        tierWeight: 3,
      };
    },
  };

  await handleMyRevenue(interaction, service, () => wallet);

  assert.deepEqual(interaction.calls[0], ['deferReply', { ephemeral: true }]);
  const reply = interaction.calls.at(-1)[1];
  assert.equal(reply.embeds.length, 1);
  assert.equal(reply.components.length, 1);
  assert.equal(reply.components[0].components[0].data.style, ButtonStyle.Link);
  assert.equal(reply.components[0].components[0].data.url, CLAIM_URL);
  assert.equal(reply.components[0].components[0].data.custom_id, undefined);
});

test('/my-revenue unverified user asks them to run /verify first', async () => {
  const interaction = fakeInteraction();

  await handleMyRevenue(interaction, { getWalletRevenue: async () => assert.fail('service should not be called') }, () => null);

  assert.match(interaction.calls.at(-1)[1].content, /Run \/verify first/);
});

test('/my-revenue verified wallet with no claim accounts reports no holdings', async () => {
  const interaction = fakeInteraction();
  const wallet = Keypair.generate().publicKey.toBase58();
  const service = {
    async getWalletRevenue() {
      return { wallet, hasHoldings: false };
    },
  };

  await handleMyRevenue(interaction, service, () => wallet);

  assert.match(interaction.calls.at(-1)[1].content, /no holdings/i);
});

test('revenue service caches wallet reads for 60 seconds', async () => {
  const holder      = Keypair.generate().publicKey;
  const mint        = Keypair.generate().publicKey;
  const collection  = new PublicKey('A4mK2dc1unr56CC8zr5kdyzK2KgAQ1uiWzbpY7A5Wn1U');
  const marketplace = Keypair.generate().publicKey;
  const acceptedMint = Keypair.generate().publicKey;
  let accountInfoCalls = 0;
  const conn = {
    async getAccountInfo() {
      accountInfoCalls += 1;
      if (accountInfoCalls === 1) {
        return { data: poolData({ marketplace, acceptedMint, accumulated: 3_000_000n * CLAIM_SCALE }) };
      }
      if (accountInfoCalls === 2) return { data: metadataData(collection) };
      return { data: claimData({ marketplace, holder, mint, weight: 3, claimed: 1_000_000n }) };
    },
    async getParsedTokenAccountsByOwner() {
      return {
        value: [{
          account: {
            data: {
              parsed: {
                info: {
                  mint: mint.toBase58(),
                  tokenAmount: { decimals: 0, amount: '1' },
                },
              },
            },
          },
        }],
      };
    },
  };
  const service = createRevenueService({ connection: conn, acceptedMint });

  const first  = await service.getWalletRevenue(holder.toBase58());
  const second = await service.getWalletRevenue(holder.toBase58());

  assert.equal(first.claimable, 8_000_000n);
  assert.equal(second.claimable, 8_000_000n);
  assert.equal(accountInfoCalls, 3);
});

test('revenue service evicts expired wallet cache entries', () => {
  const walletCache = new Map([
    ['expired', { value: {}, expiresAt: 999 }],
    ['fresh', { value: {}, expiresAt: 1_001 }],
  ]);

  const removed = sweepExpiredCacheEntries(walletCache, 1_000);

  assert.equal(removed, 1);
  assert.equal(walletCache.has('expired'), false);
  assert.equal(walletCache.has('fresh'), true);
});

test('revenue service caches getStats for 5 minutes', async () => {
  const marketplace  = Keypair.generate().publicKey;
  const acceptedMint = Keypair.generate().publicKey;
  let programAccountCalls = 0;
  let getAccountInfoCalls  = 0;
  const conn = {
    async getAccountInfo() {
      getAccountInfoCalls += 1;
      return { data: poolData({ marketplace, acceptedMint, accumulated: 0n, distributed: 5_000_000n }) };
    },
    async getProgramAccounts() {
      programAccountCalls += 1;
      return [];
    },
  };

  let fakeNow = 0;
  const service = createRevenueService({ connection: conn, acceptedMint, now: () => fakeNow });

  const first  = await service.getStats();
  const second = await service.getStats();  // cache hit — no extra RPC calls

  assert.equal(programAccountCalls, 1);
  assert.equal(first.totalHoldersEarning, second.totalHoldersEarning);

  // Advance past TTL → cache should expire
  fakeNow = STATS_TTL_MS + 1;
  await service.getStats();
  assert.equal(programAccountCalls, 2);
});

test('revenue service deduplicates earning wallets in getStats', async () => {
  const programId    = Keypair.generate().publicKey;
  const acceptedMint = Keypair.generate().publicKey;
  const marketplace  = PublicKey.findProgramAddressSync(
    [Buffer.from('marketplace'), acceptedMint.toBuffer()],
    programId
  )[0];
  const holderA = Keypair.generate().publicKey;
  const holderB = Keypair.generate().publicKey;
  const conn = {
    async getAccountInfo() {
      return { data: poolData({ marketplace, acceptedMint, accumulated: 1_000_000n * CLAIM_SCALE, distributed: 3_000_000n }) };
    },
    async getProgramAccounts() {
      return [
        { account: { data: claimData({ marketplace, holder: holderA, mint: Keypair.generate().publicKey, tier: 1, weight: 1 }) } },
        { account: { data: claimData({ marketplace, holder: holderA, mint: Keypair.generate().publicKey, tier: 2, weight: 1 }) } },
        { account: { data: claimData({ marketplace, holder: holderB, mint: Keypair.generate().publicKey, tier: 0, weight: 1 }) } },
      ];
    },
  };
  const service = createRevenueService({ connection: conn, acceptedMint, programId });

  const stats = await service.getStats();

  assert.equal(stats.totalHoldersEarning, 2);
  assert.deepEqual(stats.tierCounts, { Initiate: 1, Observer: 1, 'Community Layer': 1 });
});

test('/revenue-stats aggregates totals and tier counts', async () => {
  const interaction = fakeInteraction();
  const service = {
    async getStats() {
      return {
        totalDistributed: 12_000_000n,
        totalClaimed:     5_000_000n,
        totalHoldersEarning: 2,
        tierCounts: { Initiate: 1, Observer: 2, 'Community Layer': 1 },
      };
    },
  };

  await handleRevenueStats(interaction, service);

  const embed = interaction.calls.at(-1)[1].embeds[0].data;
  assert.equal(embed.fields.find(field => field.name === 'Total Distributed').value, '12 USDC');
  assert.equal(embed.fields.find(field => field.name === 'Holders Earning').value, '2');
  assert.equal(embed.fields.find(field => field.name === 'Community Layer').value, '1');
});

test('formatUsdc handles fractional base units', () => {
  assert.equal(formatUsdc(1_234_567n), '1.234567 USDC');
  assert.equal(formatUsdc(1_200_000n), '1.2 USDC');
});
