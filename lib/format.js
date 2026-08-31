'use strict';

const { CHAINS } = require('./config');
const { fmt } = require('./score');

function chainOf(key) {
  return CHAINS[key] || CHAINS.ethereum;
}

function shortAddr(addr) {
  if (!addr) return '—';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function pct(n) {
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${(n * 100).toFixed(1)}%`;
}

function formatMorningDigest(items, { date = new Date(), dry = false } = {}) {
  const day = date.toLocaleDateString('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

  if (!items.length) {
    return [
      `GM SWEEPS — ${day} — ETH + ROBINHOOD`,
      dry ? '(dry-run)' : null,
      'No sweepable books cleared filters today. Watching.',
    ].filter((x) => x != null).join('\n');
  }

  const lines = [
    `GM SWEEPS — ${day} — ETH + ROBINHOOD`,
    `${items.length} books worth touching. Ranked.`,
  ];
  if (dry) lines.push('(dry-run)');
  lines.push('');

  items.forEach((it, i) => {
    const c = chainOf(it.chain);
    const b = it.book;
    lines.push(`${i + 1}. ${it.name}`);
    lines.push(`   Chain: ${c.label}`);
    lines.push(`   Floor: ${fmt(b.floor)} | Last10: ${fmt(b.last10Avg)} | Δ: ${pct(b.pctVsLast10)}`);
    lines.push(`   Depth: ${b.near5Count} listed within 5% | ~${fmt(b.liftCost)} to lift +10%`);
    lines.push(`   24h: ${fmt(b.volume24h)} / ${b.sales24h} sales`);
    lines.push(`   Thesis: ${it.thesis}  Score: ${it.score}`);
    lines.push(`   Why: ${it.why}`);
    const watch = (b.cheapest || []).slice(0, 3).map((l) => fmt(l.priceEth)).join(', ');
    lines.push(`   Watch: ${watch || '—'}`);
    lines.push(`   Links: ${c.openseaCollection(it.slug)} | ${c.explorer(it.contract)}`);
    lines.push(`   Contract: ${shortAddr(it.contract)}`);
    lines.push('');
  });

  return `${lines.join('\n').trim()}\n`;
}

function formatBreaking(it) {
  const c = chainOf(it.chain);
  const b = it.book;
  const live = b.live || {};
  return [
    `SWEEP LIVE — ${it.name} — ${c.label}`,
    `${live.buys || b.sales24h} buys in ${live.windowMin || 30}m. Floor ${fmt(live.floorFrom)} → ${fmt(live.floorTo || b.floor)}.`,
    `Depth left under +5%: ${b.near5Count} / ~${fmt(b.depthEth)}`,
    c.openseaCollection(it.slug),
  ].join('\n');
}

function digestToEmbed(text) {
  return {
    color: 0x00ff88,
    title: 'GM SWEEPS',
    description: String(text).slice(0, 3900),
    timestamp: new Date().toISOString(),
    footer: { text: 'NFT Sweep Bot • morning digest • LIVE_BUY=false' },
  };
}

function breakingToEmbed(text) {
  return {
    color: 0xffaa00,
    title: 'SWEEP LIVE',
    description: String(text).slice(0, 3900),
    timestamp: new Date().toISOString(),
    footer: { text: 'NFT Sweep Bot • breaking • score≥75' },
  };
}

module.exports = {
  formatMorningDigest,
  formatBreaking,
  digestToEmbed,
  breakingToEmbed,
};
