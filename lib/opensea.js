'use strict';

const { httpJson } = require('./http');
const { CHAINS } = require('./config');

const BASE = 'https://api.opensea.io/api/v2';

function headers() {
  const key = process.env.OPENSEA_API_KEY;
  if (!key) throw new Error('Missing OPENSEA_API_KEY');
  return { Accept: 'application/json', 'X-API-KEY': key };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function osGet(pathname, query = {}) {
  const url = new URL(pathname.startsWith('http') ? pathname : `${BASE}${pathname}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  return httpJson(url.toString(), { headers: headers() });
}

async function withBackoff(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (err.status === 429 || (err.status && err.status >= 500)) {
        await sleep(400 * Math.pow(2, i));
        continue;
      }
      throw err;
    }
  }
  throw last;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeCollection(c) {
  if (!c) return null;
  const contracts = c.contracts || [];
  const primary = contracts[0] || {};
  return {
    slug: c.collection || c.slug,
    name: c.name || c.slug,
    contract: (primary.address || '').toLowerCase() || null,
    chain: (primary.chain || c.chain || 'ethereum').toLowerCase(),
    totalSupply: num(c.total_supply),
  };
}

function parseListing(row, chain) {
  try {
    const priceNode = row.price?.current || row.price || row.current_price;
    let priceEth = null;
    if (priceNode && typeof priceNode === 'object') {
      const value = num(priceNode.value ?? priceNode.amount ?? priceNode.quantity);
      const decimals = num(priceNode.decimals ?? 18) || 18;
      const currency = (priceNode.currency || priceNode.symbol || 'ETH').toUpperCase();
      const raw = value / Math.pow(10, decimals);
      priceEth = currency === 'ETH' || currency === 'WETH' ? raw : null;
      if (priceEth == null && priceNode.value_in_eth) priceEth = num(priceNode.value_in_eth);
    } else if (priceNode != null) {
      const v = num(priceNode);
      priceEth = v > 1e6 ? v / 1e18 : v;
    }
    if (priceEth == null && row.current_price) priceEth = num(row.current_price) / 1e18;
    if (!Number.isFinite(priceEth) || priceEth <= 0) return null;
    return {
      priceEth,
      tokenId: String(row.token_id || row.protocol_data?.parameters?.offer?.[0]?.identifierOrCriteria || '') || null,
      chain,
    };
  } catch {
    return null;
  }
}

function parseSale(event, chain) {
  try {
    const payment = event.payment || event.payment_token || {};
    const decimals = num(payment.decimals ?? 18) || 18;
    let priceEth = 0;
    if (event.payment?.quantity != null) {
      priceEth = num(event.payment.quantity) / Math.pow(10, decimals);
      const symbol = (event.payment.symbol || payment.symbol || 'ETH').toUpperCase();
      if (symbol !== 'ETH' && symbol !== 'WETH') {
        const ethPrice = num(payment.eth_price);
        if (ethPrice > 0) priceEth *= ethPrice;
      }
    } else if (event.sale_price) {
      priceEth = num(event.sale_price) / 1e18;
    }
    if (!Number.isFinite(priceEth) || priceEth <= 0) return null;
    const ts = event.event_timestamp || event.closing_date || event.created_date;
    return {
      priceEth,
      buyer: (event.buyer?.address || event.taker?.address || '').toLowerCase() || null,
      seller: (event.seller?.address || event.maker?.address || '').toLowerCase() || null,
      timestamp: ts ? new Date(ts).getTime() : Date.now(),
      chain,
    };
  } catch {
    return null;
  }
}

function parseOffer(row) {
  try {
    const priceNode = row.price?.value || row.current_price || row.price;
    let priceEth = null;
    if (typeof priceNode === 'object' && priceNode) {
      priceEth = num(priceNode.value ?? priceNode.amount) / Math.pow(10, num(priceNode.decimals ?? 18) || 18);
    } else if (priceNode != null) {
      const v = num(priceNode);
      priceEth = v > 1e6 ? v / 1e18 : v;
    }
    if (!Number.isFinite(priceEth) || priceEth <= 0) return null;
    return { priceEth };
  } catch {
    return null;
  }
}

async function fetchTrending(chainKey, limit = 25) {
  const chain = CHAINS[chainKey]?.opensea || chainKey;
  try {
    const data = await osGet('/collections', {
      chain,
      order_by: 'seven_day_volume',
      limit: Math.min(limit, 50),
    });
    return (data.collections || []).map(normalizeCollection).filter(Boolean);
  } catch (err) {
    console.warn(`[opensea] trending ${chainKey}: ${err.message}`);
    return [];
  }
}

async function fetchCollection(slug) {
  const data = await osGet(`/collections/${encodeURIComponent(slug)}`);
  return normalizeCollection(data.collection || data);
}

async function fetchCollectionStats(slug) {
  try {
    const data = await osGet(`/collections/${encodeURIComponent(slug)}/stats`);
    const s = data.total || data.stats || data;
    return {
      floor: num(s.floor_price ?? s.floor?.value ?? s.floor),
      volume24h: num(s.one_day_volume ?? s.volume_24h),
      sales24h: num(s.one_day_sales ?? s.sales_24h),
      sales7d: num(s.seven_day_sales ?? s.sales_7d),
      volume7d: num(s.seven_day_volume),
      numOwners: num(s.num_owners ?? s.owners),
    };
  } catch (err) {
    console.warn(`[opensea] stats ${slug}: ${err.message}`);
    return null;
  }
}

async function fetchBestListings(slug, chainKey, limit = 50) {
  const chain = CHAINS[chainKey]?.opensea || chainKey;
  try {
    const data = await osGet(`/listings/collection/${encodeURIComponent(slug)}/nfts`, {
      limit: Math.min(limit, 50),
    });
    const rows = data.listings || data.nfts || [];
    const parsed = rows.map((r) => parseListing(r, chain)).filter(Boolean);
    if (parsed.length) return parsed.sort((a, b) => a.priceEth - b.priceEth).slice(0, limit);
  } catch (err) {
    console.warn(`[opensea] listings ${slug}: ${err.message}`);
  }
  try {
    const data = await osGet(`/orders/${chain}/seaport/listings`, {
      collection_slug: slug,
      limit: Math.min(limit, 50),
      order_by: 'eth_price',
      order_direction: 'asc',
    });
    return (data.orders || [])
      .map((r) => parseListing(r, chain))
      .filter(Boolean)
      .sort((a, b) => a.priceEth - b.priceEth)
      .slice(0, limit);
  } catch (err) {
    console.warn(`[opensea] seaport ${slug}: ${err.message}`);
    return [];
  }
}

async function fetchRecentSales(slug, chainKey, limit = 30) {
  const chain = CHAINS[chainKey]?.opensea || chainKey;
  try {
    const data = await osGet(`/events/collection/${encodeURIComponent(slug)}`, {
      event_type: 'sale',
      limit: Math.min(limit, 50),
    });
    return (data.asset_events || data.events || [])
      .map((e) => parseSale(e, chain))
      .filter(Boolean);
  } catch (err) {
    console.warn(`[opensea] sales ${slug}: ${err.message}`);
    return [];
  }
}

async function fetchOffers(slug, limit = 20) {
  try {
    const data = await osGet(`/offers/collection/${encodeURIComponent(slug)}`, {
      limit: Math.min(limit, 50),
    });
    return (data.offers || data.orders || []).map(parseOffer).filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = {
  sleep,
  withBackoff,
  fetchTrending,
  fetchCollection,
  fetchCollectionStats,
  fetchBestListings,
  fetchRecentSales,
  fetchOffers,
};
