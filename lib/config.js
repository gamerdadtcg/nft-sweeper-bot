'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

const CHAINS = {
  ethereum: {
    key: 'ethereum',
    label: 'ETH',
    opensea: 'ethereum',
    chainId: 1,
    minHolders: 40,
    explorer: (addr) => `https://etherscan.io/address/${addr}`,
    openseaCollection: (slug) => `https://opensea.io/collection/${slug}`,
  },
  robinhood: {
    key: 'robinhood',
    label: 'RH',
    opensea: 'robinhood',
    chainId: 4663,
    minHolders: 20,
    explorer: (addr) => `https://robinhoodchain.blockscout.com/address/${addr}`,
    openseaCollection: (slug) => `https://opensea.io/collection/${slug}`,
    blockscoutApi: 'https://robinhoodchain.blockscout.com/api',
  },
};

const THESIS = {
  DUMP_BOOK: 'DUMP_BOOK',
  UNDER_VWAP: 'UNDER_VWAP',
  TRAIT_SNIPE: 'TRAIT_SNIPE',
  LIVE_SWEEP: 'LIVE_SWEEP',
  THIN_ABOVE: 'THIN_ABOVE',
};

module.exports = {
  ROOT,
  DATA_DIR,
  WATCHLIST_PATH: path.join(DATA_DIR, 'watchlist.json'),
  BLACKLIST_PATH: path.join(DATA_DIR, 'blacklist.json'),
  POSTED_PATH: path.join(DATA_DIR, 'posted.json'),
  CHAINS,
  THESIS,

  SCORE_MORNING: 62,
  SCORE_MORNING_FALLBACK: 52,
  SCORE_BREAKING: 75,
  MORNING_CAP: 8,
  MORNING_FALLBACK_MIN: 3,

  MIN_LISTINGS_NEAR_FLOOR: 3,
  NEAR_FLOOR_PCT: 0.10,
  DEPTH_BAND_PCT: 0.05,
  LIFT_BAND_PCT: 0.10,
  MIN_SALES_24H: 3,
  MIN_SALES_7D: 10,
  STALE_HIGH_PCT: 0.15,

  DEDUPE_SAME_THESIS_HOURS: 18,
  DEDUPE_CHANGED_HOURS: 6,
  FLOOR_MOVE_REPOST_PCT: 0.08,
  DEPTH_INCREASE_REPOST_PCT: 0.50,

  LIVE_SWEEP_BUYS: 5,
  LIVE_SWEEP_WINDOW_MS: 30 * 60 * 1000,
  LIVE_SWEEP_BONUS: 12,

  LIVE_BUY: String(process.env.LIVE_BUY || 'false').toLowerCase() === 'true',
};
