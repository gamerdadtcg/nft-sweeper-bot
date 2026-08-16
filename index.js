require('dotenv').config();
const { OpenSeaStreamClient } = require('@opensea/stream-js');
const { WebSocket } = require('ws');

// ========== CONFIG ==========
const MIN_NFTS = 10;
const MIN_ETH_PER_NFT = 0.001; // only count buys worth more than this (ETH)
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const ALERT_COOLDOWN = 5 * 60 * 1000; // 5 min cooldown
const ETH_PRICE_INTERVAL_MS = 30 * 60 * 1000; // refresh rarely; sale payloads usually carry usd_price
const ALLOWED_CHAINS = new Set(['ethereum']); // skip other chains to cut event CPU
// Native ETH only — skip WETH (offer accepts flood alerts)
const WETH_ADDRESSES = new Set([
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // Ethereum
  '0x4200000000000000000000000000000000000006', // Base / Optimism
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', // Arbitrum
  '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619', // Polygon
]);
const BLOCKED_COLLECTIONS = new Set([
  'courtyard-nft',
]);
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// ========== STATE ==========
const sweeps = new Map();
let ethPrice = 3000;
let discordSend = null; // async ({ embeds }) => void

function isWethSale(payload) {
  const symbol = (payload.payment_token?.symbol || '').toUpperCase();
  if (symbol === 'WETH') return true;
  const address = (payload.payment_token?.address || '').toLowerCase();
  return WETH_ADDRESSES.has(address);
}

function getChain(payload) {
  const chain = payload.item?.chain?.name || payload.chain?.name || payload.chain;
  return typeof chain === 'string' ? chain.toLowerCase() : '';
}

function httpFetch(url, options) {
  const fetchFn = globalThis.fetch || require('node-fetch');
  return fetchFn(url, options);
}

// ========== HELPERS ==========
async function updateEthPrice() {
  try {
    const res = await httpFetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    const data = await res.json();
    const next = data.ethereum?.usd;
    if (next && next !== ethPrice) {
      ethPrice = next;
      console.log(`ETH price: $${ethPrice}`);
    }
  } catch (err) {
    console.error('ETH price error:', err.message);
  }
}

function getSaleAmount(payload) {
  const price = payload.sale_price || payload.total_price || payload.base_price || '0';
  const decimals = payload.payment_token?.decimals ?? 18;
  const amount = Number(price) / Math.pow(10, decimals);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return amount;
}

function getEthValue(payload) {
  try {
    const amount = getSaleAmount(payload);
    if (amount <= 0) return 0;

    const symbol = (payload.payment_token?.symbol || '').toUpperCase();
    const address = (payload.payment_token?.address || '').toLowerCase();
    // Native ETH (symbol ETH or zero-address payment token)
    if (symbol === 'ETH' || address === ZERO_ADDRESS || !address) {
      return amount;
    }

    const tokenEth = Number(payload.payment_token?.eth_price);
    if (Number.isFinite(tokenEth) && tokenEth > 0) {
      return amount * tokenEth;
    }

    if (symbol === 'USDC' || symbol === 'USDT' || symbol === 'DAI') {
      return ethPrice > 0 ? amount / ethPrice : 0;
    }

    const tokenUsd = Number(payload.payment_token?.usd_price);
    if (Number.isFinite(tokenUsd) && tokenUsd > 0 && ethPrice > 0) {
      return (amount * tokenUsd) / ethPrice;
    }

    return 0;
  } catch {
    return 0;
  }
}

function getUsdValue(payload, eth) {
  const tokenUsd = Number(payload.payment_token?.usd_price);
  const amount = getSaleAmount(payload);
  if (Number.isFinite(tokenUsd) && tokenUsd > 0 && amount > 0) {
    const symbol = (payload.payment_token?.symbol || '').toUpperCase();
    if (symbol === 'ETH' || symbol === '' || (payload.payment_token?.address || '').toLowerCase() === ZERO_ADDRESS) {
      return amount * tokenUsd;
    }
    if (symbol === 'USDC' || symbol === 'USDT' || symbol === 'DAI') {
      return amount;
    }
    return amount * tokenUsd;
  }
  return (eth || 0) * ethPrice;
}

// ========== DISCORD (webhook preferred — much cheaper than a full bot gateway) ==========
async function initDiscord() {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (webhookUrl) {
    discordSend = async ({ embeds }) => {
      const res = await httpFetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Webhook ${res.status}: ${text.slice(0, 200)}`);
      }
    };
    console.log('Discord: using webhook (low memory mode)');
    return;
  }

  // Fallback: full Discord bot (higher RAM / Railway cost)
  const { Client, GatewayIntentBits } = require('discord.js');
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await new Promise((resolve, reject) => {
    client.once('clientReady', resolve);
    client.once('error', reject);
    client.login(process.env.DISCORD_TOKEN).catch(reject);
  });
  console.log(`Logged in as ${client.user.tag}`);
  console.log('Tip: set DISCORD_WEBHOOK_URL to cut Railway memory/cost (no bot gateway needed)');

  discordSend = async ({ embeds }) => {
    const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);
    if (!channel) throw new Error('Discord channel not found');
    await channel.send({ embeds });
  };
}

// ========== MAIN LOGIC ==========
function processSale(event) {
  try {
    const payload = event.payload || event;

    const collection = payload.collection?.slug || payload.item?.collection?.slug;
    if (!collection) return;
    if (BLOCKED_COLLECTIONS.has(collection.toLowerCase())) return;

    const chain = getChain(payload);
    if (chain && !ALLOWED_CHAINS.has(chain)) return;

    if (isWethSale(payload)) return;

    const eth = getEthValue(payload);
    if (eth <= MIN_ETH_PER_NFT) return;

    const buyer = (
      payload.taker?.address ||
      payload.winner_account?.address ||
      payload.to_account?.address ||
      payload.buyer?.address ||
      payload.maker?.address
    )?.toLowerCase();
    if (!buyer) return;

    const key = `${buyer}:${collection}`;
    const now = Date.now();
    let entry = sweeps.get(key);
    if (!entry) {
      entry = { sales: [], lastAlert: 0 };
      sweeps.set(key, entry);
    }

    // Cache display fields once (avoid re-reading every sale)
    if (!entry.collectionName) {
      entry.collectionName = payload.collection?.name || payload.item?.collection?.name || collection;
      entry.image = payload.item?.metadata?.image_url || payload.collection?.image_url || null;
    }

    const usd = getUsdValue(payload, eth);
    entry.sales.push({ t: now, eth, usd });

    // Drop expired in place
    const cutoff = now - WINDOW_MS;
    if (entry.sales.length > 0 && entry.sales[0].t < cutoff) {
      entry.sales = entry.sales.filter(s => s.t >= cutoff);
    }

    const count = entry.sales.length;
    if (count < MIN_NFTS) return;
    if (now - entry.lastAlert <= ALERT_COOLDOWN) return;

    let totalEth = 0;
    let totalUsd = 0;
    for (let i = 0; i < count; i++) {
      totalEth += entry.sales[i].eth;
      totalUsd += entry.sales[i].usd;
    }

    entry.lastAlert = now;
    sendAlert({
      buyer,
      collection,
      collectionName: entry.collectionName,
      image: entry.image,
      count,
      totalEth,
      totalUsd,
    });
  } catch (err) {
    console.error('Process error:', err.message);
  }
}

async function sendAlert({ buyer, collection, collectionName, image, count, totalEth, totalUsd }) {
  try {
    if (!discordSend) return;

    const short = `${buyer.slice(0, 6)}...${buyer.slice(-4)}`;
    const openseaLink = `https://opensea.io/${buyer}`;
    const etherscanLink = `https://etherscan.io/address/${buyer}`;
    const collectionLink = `https://opensea.io/collection/${collection}`;

    const embed = {
      color: 0x00ff88,
      title: '🚨 NFT SWEEP DETECTED',
      description: `**${collectionName}** just got swept`,
      fields: [
        { name: 'Project', value: `[${collectionName}](${collectionLink})`, inline: true },
        { name: 'NFTs Swept', value: `**${count}**`, inline: true },
        { name: 'Total Value', value: `**${totalEth.toFixed(4)} ETH ($${totalUsd.toFixed(2)})**`, inline: true },
        { name: 'Wallet', value: `[${short}](${openseaLink})`, inline: false },
        { name: 'Links', value: `[OpenSea](${openseaLink}) • [Etherscan](${etherscanLink})`, inline: false },
      ],
      timestamp: new Date().toISOString(),
      footer: { text: `NFT Sweep Bot • ≥${MIN_NFTS} buys > ${MIN_ETH_PER_NFT} ETH • 10 min window` },
    };
    if (image) embed.thumbnail = { url: image };

    await discordSend({ embeds: [embed] });
    console.log(`Alert → ${collectionName} | ${count} NFTs | ${totalEth.toFixed(4)} ETH ($${totalUsd.toFixed(2)})`);
  } catch (err) {
    console.error('Send alert error:', err.message);
  }
}

// ========== START ==========
async function start() {
  console.log('Starting NFT Sweep Bot...');

  if (!process.env.DISCORD_WEBHOOK_URL && !process.env.DISCORD_TOKEN) {
    throw new Error('Set DISCORD_WEBHOOK_URL (recommended) or DISCORD_TOKEN + DISCORD_CHANNEL_ID');
  }
  if (!process.env.OPENSEA_API_KEY) {
    throw new Error('Missing OPENSEA_API_KEY');
  }

  await updateEthPrice();
  setInterval(updateEthPrice, ETH_PRICE_INTERVAL_MS);

  // Cleanup idle sweep keys every 2 minutes
  setInterval(() => {
    const cutoff = Date.now() - WINDOW_MS;
    for (const [key, entry] of sweeps.entries()) {
      entry.sales = entry.sales.filter(s => s.t >= cutoff);
      if (entry.sales.length === 0) sweeps.delete(key);
    }
  }, 2 * 60 * 1000);

  await initDiscord();

  const streamClient = new OpenSeaStreamClient({
    token: process.env.OPENSEA_API_KEY,
    connectOptions: { transport: WebSocket },
  });

  streamClient.onItemSold('*', processSale);

  console.log('Listening for Ethereum sales (WETH + blocked collections skipped)...');
}

start().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
