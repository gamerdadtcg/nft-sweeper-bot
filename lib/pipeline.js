'use strict';

const cfg = require('./config');
const { readJson, loadPosted, savePosted, canRepost, markPosted } = require('./store');
const os = require('./opensea');
const { fetchRecentTokenTransfers } = require('./blockscout');
const { buildBook, hardFilter, scoreOpportunity, detectWash } = require('./score');
const { formatMorningDigest, formatBreaking, digestToEmbed, breakingToEmbed } = require('./format');
const { initDiscord } = require('./discord');

function loadWatchlist() {
  return readJson(cfg.WATCHLIST_PATH, { ethereum: [], robinhood: [] });
}

function loadBlacklist() {
  const raw = readJson(cfg.BLACKLIST_PATH, { slugs: [], contracts: [] });
  return {
    slugs: new Set((raw.slugs || []).map((s) => String(s).toLowerCase())),
    contracts: new Set((raw.contracts || []).map((c) => String(c).toLowerCase())),
  };
}

async function seedCandidates({ includeTrending = true } = {}) {
  const watch = loadWatchlist();
  const seen = new Set();
  const out = [];

  function add(chain, slug, source) {
    if (!slug) return;
    const key = `${chain}:${String(slug).toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ chain, slug: String(slug).toLowerCase(), source });
  }

  for (const slug of watch.ethereum || []) add('ethereum', slug, 'watchlist');
  for (const slug of watch.robinhood || []) add('robinhood', slug, 'watchlist');

  if (includeTrending) {
    for (const chain of ['ethereum', 'robinhood']) {
      const trending = await os.fetchTrending(chain, 25);
      for (const c of trending) {
        if (c?.slug) add(chain, c.slug, 'trending');
      }
      await os.sleep(250);
    }
  }

  return out;
}

async function enrichCandidate(candidate, blacklist) {
  const { chain, slug } = candidate;

  let collection = null;
  try {
    collection = await os.withBackoff(() => os.fetchCollection(slug));
  } catch (err) {
    console.warn(`[pipeline] collection ${slug}: ${err.message}`);
    return null;
  }

  const statsRaw = await os.fetchCollectionStats(slug);
  await os.sleep(150);
  const listings = await os.fetchBestListings(slug, chain, 50);
  await os.sleep(150);
  const sales = await os.fetchRecentSales(slug, chain, 30);
  await os.sleep(150);
  const offers = await os.fetchOffers(slug, 15);

  if (chain === 'robinhood' && collection?.contract) {
    await fetchRecentTokenTransfers(collection.contract, 30);
  }

  const stats = {
    floor: statsRaw?.floor || 0,
    sales24h: statsRaw?.sales24h || 0,
    sales7d: statsRaw?.sales7d || 0,
    volume24h: statsRaw?.volume24h || 0,
    numOwners: statsRaw?.numOwners || 0,
  };

  const book = buildBook(listings, sales, stats, offers);
  const blacklisted =
    blacklist.slugs.has(slug.toLowerCase()) ||
    (collection?.contract && blacklist.contracts.has(collection.contract.toLowerCase()));

  const opp = {
    chain,
    slug,
    name: collection?.name || slug,
    contract: collection?.contract || null,
    source: candidate.source,
    watchlisted: candidate.source === 'watchlist',
    blacklisted,
    washSuspect: detectWash(sales),
    brandNew: false,
    netListings6h: 0,
    book,
    floor: book.floor,
    depthEth: book.depthEth,
  };

  const filter = hardFilter(opp);
  if (!filter.ok) {
    return { ...opp, rejected: true, rejectReason: filter.reason };
  }

  const scored = scoreOpportunity(opp);
  return {
    ...opp,
    rejected: false,
    score: scored.score,
    thesis: scored.thesis,
    why: scored.why,
    parts: scored.parts,
  };
}

function selectMorning(opps) {
  let threshold = cfg.SCORE_MORNING;
  let passed = opps
    .filter((o) => !o.rejected && o.score >= threshold)
    .sort((a, b) => b.score - a.score);

  if (passed.length < cfg.MORNING_FALLBACK_MIN) {
    threshold = cfg.SCORE_MORNING_FALLBACK;
    passed = opps
      .filter((o) => !o.rejected && o.score >= threshold)
      .sort((a, b) => b.score - a.score);
  }

  return { threshold, items: passed.slice(0, cfg.MORNING_CAP) };
}

function toDigestItem(opp) {
  return {
    chain: opp.chain,
    slug: opp.slug,
    name: opp.name,
    contract: opp.contract,
    thesis: opp.thesis,
    score: opp.score,
    why: opp.why,
    book: opp.book,
    floor: opp.floor,
    depthEth: opp.depthEth,
  };
}

async function runMorningDigest(opts = {}) {
  const dry = opts.dry !== false && !opts.post;
  const blacklist = loadBlacklist();
  const store = loadPosted();

  let evaluated;
  if (opts.mock) {
    evaluated = buildMockSet();
  } else {
    if (!process.env.OPENSEA_API_KEY) {
      throw new Error('OPENSEA_API_KEY required for live digest (or pass mock:true)');
    }
    const seeds = await seedCandidates({ includeTrending: opts.trending !== false });
    console.log(`[pipeline] seeded ${seeds.length} candidates`);
    evaluated = [];
    for (const seed of seeds) {
      try {
        const row = await enrichCandidate(seed, blacklist);
        if (row) evaluated.push(row);
      } catch (err) {
        console.warn(`[pipeline] fail ${seed.slug}: ${err.message}`);
      }
    }
  }

  const afterDedupe = [];
  const skipped = [];
  for (const opp of evaluated) {
    if (opp.rejected) {
      skipped.push({ slug: opp.slug, reason: opp.rejectReason });
      continue;
    }
    if (opts.mock && opts.skipDedupe !== false) {
      afterDedupe.push(opp);
      continue;
    }
    const gate = canRepost(store, opp, {
      sameThesisHours: cfg.DEDUPE_SAME_THESIS_HOURS,
      changedHours: cfg.DEDUPE_CHANGED_HOURS,
      floorMovePct: cfg.FLOOR_MOVE_REPOST_PCT,
      depthIncreasePct: cfg.DEPTH_INCREASE_REPOST_PCT,
    });
    if (!gate.allow) {
      skipped.push({ slug: opp.slug, reason: gate.reason });
      continue;
    }
    afterDedupe.push(opp);
  }

  const { items, threshold } = selectMorning(afterDedupe);
  const digestItems = items.map(toDigestItem);
  const text = formatMorningDigest(digestItems, { dry });

  console.log(`\n[pipeline] threshold=${threshold} selected=${items.length} skipped=${skipped.length}`);
  console.log(text);

  if (!dry) {
    const send = await initDiscord();
    if (!send) throw new Error('Set DISCORD_WEBHOOK_URL (or DISCORD_TOKEN + DISCORD_CHANNEL_ID)');
    await send({ content: text, embeds: [digestToEmbed(text)] });
    for (const it of items) markPosted(store, it);
    savePosted(store);
    console.log('[pipeline] posted digest + saved store');
  }

  return { text, items: digestItems, skipped, threshold, evaluated };
}

async function runBreakingCheck(opts = {}) {
  const dry = opts.dry !== false && !opts.post;

  if (opts.mock) {
    const live = buildMockSet().find((o) => o.thesis === cfg.THESIS.LIVE_SWEEP && !o.rejected);
    if (!live) return { text: null, item: null };
    const text = formatBreaking(toDigestItem(live));
    console.log(text);
    return { text, item: live };
  }

  const blacklist = loadBlacklist();
  const store = loadPosted();
  const seeds = await seedCandidates({ includeTrending: true });
  const hits = [];

  for (const seed of seeds.slice(0, 40)) {
    const row = await enrichCandidate(seed, blacklist);
    if (!row || row.rejected) continue;
    if (row.score < cfg.SCORE_BREAKING) continue;
    if (row.thesis !== cfg.THESIS.LIVE_SWEEP && row.book.near5Count < cfg.MIN_LISTINGS_NEAR_FLOOR) {
      continue;
    }
    const gate = canRepost(store, row, {
      sameThesisHours: 6,
      changedHours: 6,
      floorMovePct: cfg.FLOOR_MOVE_REPOST_PCT,
      depthIncreasePct: cfg.DEPTH_INCREASE_REPOST_PCT,
    });
    if (!gate.allow) continue;
    hits.push(row);
  }

  hits.sort((a, b) => b.score - a.score);
  const top = hits[0];
  if (!top) {
    console.log('[breaking] none');
    return { text: null, item: null };
  }

  const text = formatBreaking(toDigestItem(top));
  console.log(text);

  if (!dry) {
    const send = await initDiscord();
    if (!send) throw new Error('Set DISCORD_WEBHOOK_URL');
    await send({ content: text, embeds: [breakingToEmbed(text)] });
    markPosted(store, top);
    savePosted(store);
  }

  return { text, item: top };
}

function buildMockSet() {
  const now = Date.now();

  // Dump book: floor near last10 (not deep under VWAP) + heavy ask pressure
  const dumpListings = [
    { priceEth: 0.42 }, { priceEth: 0.425 }, { priceEth: 0.43 },
    { priceEth: 0.435 }, { priceEth: 0.44 }, { priceEth: 0.50 },
  ];
  const dumpSales = Array.from({ length: 10 }, (_, i) => ({
    priceEth: 0.43 + (i % 3) * 0.005,
    buyer: `0xbuyer${i}`,
    seller: `0xseller${i}`,
    timestamp: now - (i + 1) * 3600 * 1000,
  }));

  // Live sweep: sequential buys lifting floor over 30m
  const liveListings = [
    { priceEth: 0.11 }, { priceEth: 0.112 }, { priceEth: 0.115 },
    { priceEth: 0.118 }, { priceEth: 0.12 },
  ];
  const liveSales = Array.from({ length: 7 }, (_, i) => ({
    priceEth: 0.10 + i * 0.002,
    buyer: `0xlivebuyer${i}`,
    seller: `0xliveseller${i}`,
    timestamp: now - (6 - i) * 60 * 1000,
  }));

  const junkListings = [{ priceEth: 0.02 }, { priceEth: 0.08 }];
  const junkSales = [
    { priceEth: 0.02, buyer: '0x1', seller: '0x2', timestamp: now - 1e5 },
    { priceEth: 0.02, buyer: '0x2', seller: '0x1', timestamp: now - 2e5 },
  ];

  function pack({ chain, slug, name, contract, listings, sales, stats, watchlisted, netListings6h }) {
    const book = buildBook(listings, sales, stats, []);
    const opp = {
      chain,
      slug,
      name,
      contract,
      source: watchlisted ? 'watchlist' : 'trending',
      watchlisted: !!watchlisted,
      blacklisted: false,
      washSuspect: detectWash(sales),
      brandNew: false,
      netListings6h: netListings6h || 0,
      book,
      floor: book.floor,
      depthEth: book.depthEth,
    };
    const filter = hardFilter(opp);
    if (!filter.ok) {
      return { ...opp, rejected: true, rejectReason: filter.reason };
    }
    const scored = scoreOpportunity(opp);
    return {
      ...opp,
      rejected: false,
      score: scored.score,
      thesis: scored.thesis,
      why: scored.why,
      parts: scored.parts,
    };
  }

  return [
    pack({
      chain: 'ethereum',
      slug: 'mock-pudgy-dump',
      name: 'Mock Pudgy Dump',
      contract: '0x1234567890abcdef1234567890abcdef12345678',
      listings: dumpListings,
      sales: dumpSales,
      stats: { floor: 0.42, sales24h: 18, sales7d: 90, volume24h: 8.2, numOwners: 1200 },
      watchlisted: true,
      netListings6h: 14,
    }),
    pack({
      chain: 'robinhood',
      slug: 'mock-rh-lift',
      name: 'Mock RH Lift',
      contract: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      listings: liveListings,
      sales: liveSales,
      stats: { floor: 0.11, sales24h: 22, sales7d: 60, volume24h: 2.4, numOwners: 80 },
      watchlisted: false,
      netListings6h: 2,
    }),
    pack({
      chain: 'ethereum',
      slug: 'mock-illiquid-junk',
      name: 'Mock Illiquid Junk',
      contract: '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead',
      listings: junkListings,
      sales: junkSales,
      stats: { floor: 0.02, sales24h: 2, sales7d: 4, volume24h: 0.04, numOwners: 12 },
      watchlisted: false,
    }),
  ];
}

module.exports = {
  runMorningDigest,
  runBreakingCheck,
  seedCandidates,
  enrichCandidate,
  selectMorning,
  buildMockSet,
  loadWatchlist,
  loadBlacklist,
};
