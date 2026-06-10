const fs = require('fs');
const path = require('path');

const DEFAULT_STORE_PATH = path.join(__dirname, 'wallet-links.json');

function storePath() {
  return process.env.WALLET_LINKS_PATH || DEFAULT_STORE_PATH;
}

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(storePath(), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    console.error('[wallet-links] Failed to read store:', err.message);
    return {};
  }
}

function writeStore(store) {
  fs.writeFileSync(storePath(), JSON.stringify(store, null, 2));
}

function getWalletForUser(userId) {
  return readStore()[userId]?.wallet || null;
}

function linkWalletForUser(userId, wallet, metadata = {}) {
  const store = readStore();
  store[userId] = {
    wallet,
    verifiedAt: new Date().toISOString(),
    ...metadata,
  };
  writeStore(store);
  return store[userId];
}

module.exports = {
  getWalletForUser,
  linkWalletForUser,
  readStore,
};
