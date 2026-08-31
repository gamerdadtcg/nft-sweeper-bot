'use strict';

const cfg = require('./config');

function sum(arr) {
  return arr.reduce((a, b) => a + (Number(b) || 0), 0);
}

function avg(arr) {
  return arr.length ? sum(arr) / arr.length : 0;
}

function fmt(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  return n >= 1 ? n.toFixed(3) : n.toFixed(4);
}

function detectLiveSweep(sales) {
  const windowMs = cfg.LIVE_SWEEP_WINDOW_MS;
  const now = Date.now();
  const recent = sales
    .filter((s) => now - s.timestamp <= windowMs)
    .sort((a, b) => a.timestamp - b.timestamp);
  const buyers = new Set(recent.map((s) => s.buyer).filter(Boolean));
  return {
    hit: buyers.size >= cfg.LIVE_SWEEP_BUYS || recent.length >= cfg.LIVE_SWEEP_BUYS,
    buys: recent.length,
    uniqueBuyers: buyers.size,
    windowMin: Math.round(windowMs / 60000),
    floorFrom: recent[0]?.priceEth || 0,
    floorTo: recent[recent.length - 1]?.priceEth || 0,
  };
}

function detectWash(sales) {
  const day = sales.filter((s) => Date.now() - s.timestamp < 864e5);
  if (day.length < 6) return false;
  const wallets = new Set();
  for (const s of day) {
    if (s.buyer) wallets.add(s.buyer);
    if (s.seller) wallets.add(s.seller);
  }
  return wallets.size > 0 && wallets.size <= 2;
}

function buildBook(listings, sales, stats = {}, offers = []) {
  const asks = [...listings].sort((a, b) => a.priceEth - b.priceEth);
  const prints = [...sales].sort((a, b) => b.timestamp - a.timestamp);

  const listFloor = asks[0]?.priceEth || 0;
  const statsFloor = stats.floor || 0;
  const floor = listFloor && statsFloor ? Math.min(listFloor, statsFloor) : listFloor || statsFloor;

  const last10 = prints.slice(0, 10);
  const last10Avg = avg(last10.map((s) => s.priceEth));
  const sales24 = prints.filter((s) => Date.now() - s.timestamp < 864e5);
  const vwap24 = avg(sales24.map((s) => s.priceEth));

  const near5 = asks.filter((l) => floor > 0 && l.priceEth <= floor * (1 + cfg.DEPTH_BAND_PCT));
  const near10 = asks.filter((l) => floor > 0 && l.priceEth <= floor * (1 + cfg.NEAR_FLOOR_PCT));
  const underLast = last10Avg > 0 ? asks.filter((l) => l.priceEth < last10Avg).length : 0;

  const depthEth = sum(near5.map((l) => l.priceEth));
  const liftCap = floor * (1 + cfg.LIFT_BAND_PCT);
  const liftCost = sum(asks.filter((l) => l.priceEth <= liftCap).map((l) => l.priceEth));

  const bestBid = offers.length ? Math.max(...offers.map((o) => o.priceEth)) : 0;
  const bidSupport = floor > 0 && bestBid > 0 ? bestBid / floor : 0;

  const sales6h = prints.filter((s) => Date.now() - s.timestamp < 6 * 3600 * 1000);
  const buyers = new Set(sales6h.map((s) => s.buyer).filter(Boolean));
  const sellers = new Set(sales6h.map((s) => s.seller).filter(Boolean));

  const midBand = asks.filter(
    (l) => floor > 0 && l.priceEth > floor * (1 + cfg.DEPTH_BAND_PCT) && l.priceEth <= floor * 1.2
  );

  return {
    floor,
    last10Avg,
    vwap24,
    near5Count: near5.length,
    near10Count: near10.length,
    depthEth,
    liftCost,
    bidSupport,
    pctVsLast10: last10Avg > 0 ? (floor - last10Avg) / last10Avg : 0,
    pctUnderLast: asks.length ? underLast / asks.length : 0,
    uniqueBuyers6h: buyers.size,
    uniqueSellers6h: sellers.size,
    thinAbove: near5.length >= 3 && midBand.length <= 2,
    live: detectLiveSweep(prints),
    cheapest: near5.slice(0, 5),
    sales24h: stats.sales24h ?? sales24.length,
    sales7d: stats.sales7d || 0,
    volume24h: stats.volume24h ?? sum(sales24.map((s) => s.priceEth)),
    holders: stats.numOwners || 0,
  };
}

function hardFilter(opp) {
  const b = opp.book;
  const chain = cfg.CHAINS[opp.chain] || cfg.CHAINS.ethereum;

  if (!b.floor) return { ok: false, reason: 'null_floor' };
  if (b.near10Count < cfg.MIN_LISTINGS_NEAR_FLOOR) return { ok: false, reason: 'thin_book' };
  if (b.sales24h < cfg.MIN_SALES_24H && b.sales7d < cfg.MIN_SALES_7D) {
    return { ok: false, reason: 'dead_volume' };
  }
  if (b.holders > 0 && b.holders < chain.minHolders) return { ok: false, reason: 'low_holders' };
  if (b.last10Avg > 0 && b.floor > b.last10Avg * (1 + cfg.STALE_HIGH_PCT)) {
    return { ok: false, reason: 'stale_high' };
  }
  if (opp.blacklisted) return { ok: false, reason: 'blacklist' };
  if (opp.washSuspect) return { ok: false, reason: 'wash' };
  if (opp.exitTrap) return { ok: false, reason: 'exit_trap' };
  return { ok: true };
}

function pickThesis(b, opp) {
  if (b.live.hit) return cfg.THESIS.LIVE_SWEEP;
  if (opp.traitDeal) return cfg.THESIS.TRAIT_SNIPE;
  if (b.pctVsLast10 <= -0.05 || (b.vwap24 > 0 && b.floor < b.vwap24 * 0.95)) {
    return cfg.THESIS.UNDER_VWAP;
  }
  if ((opp.netListings6h || 0) >= 6 && b.near5Count >= 4) return cfg.THESIS.DUMP_BOOK;
  if (b.thinAbove) return cfg.THESIS.THIN_ABOVE;
  if (b.pctVsLast10 <= 0) return cfg.THESIS.UNDER_VWAP;
  return cfg.THESIS.DUMP_BOOK;
}

function buildWhy(b, thesis, opp) {
  const delta = b.last10Avg > 0 ? `${(b.pctVsLast10 * 100).toFixed(1)}% vs last10` : 'n/a last10';
  switch (thesis) {
    case cfg.THESIS.LIVE_SWEEP:
      return `${b.live.uniqueBuyers || b.live.buys} buyers lifting book in ${b.live.windowMin}m (${fmt(b.live.floorFrom)}→${fmt(b.live.floorTo)}).`;
    case cfg.THESIS.UNDER_VWAP:
      return `Floor ${fmt(b.floor)} sits ${delta}; ${b.near5Count} asks inside 5%.`;
    case cfg.THESIS.DUMP_BOOK:
      return `Ask dump — ${b.near5Count} listed within 5% (~${fmt(b.depthEth)} ETH depth).`;
    case cfg.THESIS.THIN_ABOVE:
      return `Stacked at floor (${b.near5Count}) with thin asks above — cheap to lift.`;
    case cfg.THESIS.TRAIT_SNIPE:
      return opp.traitDeal?.why || 'Trait ask ≥20% under recent trait prints.';
    default:
      return `Floor ${fmt(b.floor)} / last10 ${fmt(b.last10Avg)} (${delta}).`;
  }
}

function scoreOpportunity(opp) {
  const b = opp.book;
  let depth = 0;
  let dislocation = 0;
  let flow = 0;
  let quality = 0;

  depth += Math.min(15, b.near5Count * 2.5);
  if (b.depthEth > 0) depth += Math.min(10, b.depthEth * 20);
  if (b.liftCost > 0) depth += Math.min(5, b.liftCost * 8);
  if (b.bidSupport >= 0.7) depth += 5;
  else if (b.bidSupport >= 0.4) depth += 2;
  depth = Math.min(30, depth);

  if (b.pctVsLast10 <= -0.08) dislocation += 12;
  else if (b.pctVsLast10 <= -0.03) dislocation += 8;
  else if (b.pctVsLast10 <= 0) dislocation += 5;
  else if (b.pctVsLast10 <= 0.05) dislocation += 2;
  if (b.vwap24 > 0 && b.floor < b.vwap24 * 0.95) dislocation += 6;
  else if (b.vwap24 > 0 && b.floor <= b.vwap24) dislocation += 3;
  if (b.pctUnderLast >= 0.4) dislocation += 7;
  else if (b.pctUnderLast >= 0.2) dislocation += 4;
  dislocation = Math.min(25, dislocation);

  if (b.live.hit) flow += 15;
  else if (b.live.buys >= 3) flow += 8;
  if (b.uniqueBuyers6h > b.uniqueSellers6h && b.uniqueBuyers6h >= 3) flow += 6;
  else if (b.uniqueBuyers6h >= 2) flow += 3;
  if (b.thinAbove) flow += 4;
  if ((opp.netListings6h || 0) >= 8) flow += 5;
  else if ((opp.netListings6h || 0) >= 4) flow += 2;
  flow = Math.min(25, flow);

  if (b.sales7d >= 50 || b.sales24h >= 15) quality += 10;
  else if (b.sales7d >= 20 || b.sales24h >= 6) quality += 7;
  else if (b.sales7d >= 10 || b.sales24h >= 3) quality += 4;
  if (b.holders >= 500) quality += 6;
  else if (b.holders >= 100) quality += 4;
  else if (b.holders >= 40) quality += 2;
  if (opp.watchlisted) quality += 4;
  if (!opp.brandNew) quality += 2;
  quality = Math.min(20, quality);

  let score = Math.round(depth + dislocation + flow + quality);
  if (b.live.hit) score = Math.min(100, score + cfg.LIVE_SWEEP_BONUS);
  score = Math.max(0, Math.min(100, score));

  const thesis = pickThesis(b, opp);
  return { score, thesis, why: buildWhy(b, thesis, opp), parts: { depth, dislocation, flow, quality } };
}

module.exports = {
  buildBook,
  hardFilter,
  scoreOpportunity,
  detectWash,
  detectLiveSweep,
  fmt,
};
