'use strict';

const fs = require('fs');
const { DATA_DIR, POSTED_PATH } = require('./config');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return typeof fallback === 'function' ? fallback() : fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return typeof fallback === 'function' ? fallback() : fallback;
  }
}

function writeJson(file, data) {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function loadPosted() {
  return readJson(POSTED_PATH, { items: {} });
}

function savePosted(store) {
  writeJson(POSTED_PATH, store);
}

function postKey(chain, contractOrSlug) {
  return `${chain}:${String(contractOrSlug || '').toLowerCase()}`;
}

function canRepost(store, opp, opts = {}) {
  const sameThesisHours = opts.sameThesisHours ?? 18;
  const changedHours = opts.changedHours ?? 6;
  const floorMovePct = opts.floorMovePct ?? 0.08;
  const depthIncreasePct = opts.depthIncreasePct ?? 0.5;

  const key = postKey(opp.chain, opp.contract || opp.slug);
  const prev = store.items[key];
  if (!prev) return { allow: true, reason: 'new' };

  const hours = (Date.now() - new Date(prev.last_posted_at).getTime()) / 36e5;
  const thesisChanged = prev.thesis_tag !== opp.thesis;
  const floorMoved =
    prev.floor_at_post > 0 &&
    Math.abs(opp.floor - prev.floor_at_post) / prev.floor_at_post >= floorMovePct;
  const depthUp =
    prev.depth_eth_at_post > 0 &&
    (opp.depthEth - prev.depth_eth_at_post) / prev.depth_eth_at_post >= depthIncreasePct;
  const liveSweep = opp.thesis === 'LIVE_SWEEP' && prev.thesis_tag !== 'LIVE_SWEEP';
  const changed = thesisChanged || floorMoved || depthUp || liveSweep;
  const needHours = changed ? changedHours : sameThesisHours;

  if (hours < needHours) {
    return { allow: false, reason: `dedupe ${hours.toFixed(1)}h < ${needHours}h` };
  }
  return { allow: true, reason: changed ? 'changed' : 'stale_ok' };
}

function markPosted(store, opp) {
  const key = postKey(opp.chain, opp.contract || opp.slug);
  store.items[key] = {
    chain: opp.chain,
    contract: opp.contract || null,
    slug: opp.slug,
    floor_at_post: opp.floor,
    depth_eth_at_post: opp.depthEth,
    thesis_tag: opp.thesis,
    score: opp.score,
    last_posted_at: new Date().toISOString(),
  };
}

module.exports = {
  ensureDataDir,
  readJson,
  writeJson,
  loadPosted,
  savePosted,
  postKey,
  canRepost,
  markPosted,
};
