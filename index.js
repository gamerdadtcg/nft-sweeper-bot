require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { OpenSeaStreamClient } = require('@opensea/stream-js');
const { WebSocket } = require('ws');
const fetch = require('node-fetch');

// ========== CONFIG ==========
const MIN_NFTS = 10;
const MIN_USD = 20;
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const ALERT_COOLDOWN = 5 * 60 * 1000; // 5 min cooldown

// ========== STATE ==========
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const sweeps = new Map();
let ethPrice = 3000;

// ========== HELPERS ==========
async function updateEthPrice() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    const data = await res.json();
    ethPrice = data.ethereum?.usd || ethPrice;
    console.log(`ETH price: $${ethPrice}`);
  } catch (err) {
    console.error('ETH price error:', err.message);
  }
}

function getUsdValue(payload) {
  try {
    // OpenSea item_sold uses sale_price (wei); payment_token.eth_price/usd_price are rates
    const price = payload.sale_price || payload.total_price || payload.base_price || '0';
    const decimals = payload.payment_token?.decimals ?? 18;
    const amount = Number(price) / Math.pow(10, decimals);
    if (!Number.isFinite(amount) || amount <= 0) return 0;

    const symbol = (payload.payment_token?.symbol || '').toUpperCase();
    if (symbol === 'USDC' || symbol === 'USDT' || symbol === 'DAI') {
      return amount;
    }

    const tokenUsd = Number(payload.payment_token?.usd_price);
    if (Number.isFinite(tokenUsd) && tokenUsd > 0) {
      return amount * tokenUsd;
    }

    const tokenEth = Number(payload.payment_token?.eth_price);
    if (Number.isFinite(tokenEth) && tokenEth > 0) {
      return amount * tokenEth * ethPrice;
    }

    return amount * ethPrice;
  } catch {
    return 0;
  }
}

// ========== MAIN LOGIC ==========
function processSale(event) {
  try {
    const payload = event.payload || event;

    // For listing fills (typical floor sweeps), taker is the buyer; maker is the seller.
    const buyer = (
      payload.taker?.address ||
      payload.winner_account?.address ||
      payload.to_account?.address ||
      payload.buyer?.address ||
      payload.maker?.address
    )?.toLowerCase();

    const collection = payload.collection?.slug || payload.item?.collection?.slug;
    const collectionName = payload.collection?.name || payload.item?.collection?.name || collection || 'Unknown';
    const image = payload.item?.metadata?.image_url || payload.collection?.image_url || payload.item?.image_url || null;

    if (!buyer || !collection) return;

    const key = `${buyer}-${collection}`;
    const now = Date.now();

    if (!sweeps.has(key)) {
      sweeps.set(key, { sales: [], lastAlert: 0 });
    }

    const entry = sweeps.get(key);

    const usd = getUsdValue(payload);
    entry.sales.push({
      timestamp: now,
      usd,
      tokenId: payload.item?.token_id || payload.item?.nft_id,
      tx: payload.transaction?.hash
    });

    entry.sales = entry.sales.filter(s => now - s.timestamp < WINDOW_MS);

    const count = entry.sales.length;
    const totalUsd = entry.sales.reduce((sum, s) => sum + (s.usd || 0), 0);

    if (count >= MIN_NFTS && totalUsd >= MIN_USD && (now - entry.lastAlert > ALERT_COOLDOWN)) {
      entry.lastAlert = now;
      sendAlert({ buyer, collection, collectionName, image, count, totalUsd });
    }
  } catch (err) {
    console.error('Process error:', err.message);
  }
}

async function sendAlert({ buyer, collection, collectionName, image, count, totalUsd }) {
  try {
    const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);
    if (!channel) return;

    const short = `${buyer.slice(0, 6)}...${buyer.slice(-4)}`;
    const openseaLink = `https://opensea.io/${buyer}`;
    const etherscanLink = `https://etherscan.io/address/${buyer}`;
    const collectionLink = `https://opensea.io/collection/${collection}`;

    const embed = new EmbedBuilder()
      .setColor(0x00ff88)
      .setTitle('🚨 NFT SWEEP DETECTED')
      .setDescription(`**${collectionName}** just got swept`)
      .addFields(
        { name: 'Project', value: `[${collectionName}](${collectionLink})`, inline: true },
        { name: 'NFTs Swept', value: `**${count}**`, inline: true },
        { name: 'Total Value', value: `**$${totalUsd.toFixed(2)}**`, inline: true },
        { name: 'Wallet', value: `[${short}](${openseaLink})`, inline: false },
        { name: 'Links', value: `[OpenSea](${openseaLink}) • [Etherscan](${etherscanLink})`, inline: false }
      )
      .setTimestamp()
      .setFooter({ text: 'NFT Sweep Bot • 10 min window' });

    if (image) embed.setThumbnail(image);

    await channel.send({ embeds: [embed] });
    console.log(`Alert → ${collectionName} | ${count} NFTs | $${totalUsd.toFixed(2)}`);
  } catch (err) {
    console.error('Send alert error:', err.message);
  }
}

// ========== START ==========
async function start() {
  console.log('Starting NFT Sweep Bot...');

  await updateEthPrice();
  setInterval(updateEthPrice, 5 * 60 * 1000);

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of sweeps.entries()) {
      entry.sales = entry.sales.filter(s => now - s.timestamp < WINDOW_MS);
      if (entry.sales.length === 0) sweeps.delete(key);
    }
  }, 60 * 1000);

  client.once('clientReady', () => {
    console.log(`Logged in as ${client.user.tag}`);
  });

  await client.login(process.env.DISCORD_TOKEN);

  const streamClient = new OpenSeaStreamClient({
    token: process.env.OPENSEA_API_KEY,
    connectOptions: { transport: WebSocket }
  });

  streamClient.onItemSold('*', (event) => {
    processSale(event);
  });

  console.log('Listening for sales across all collections...');
}

start().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
