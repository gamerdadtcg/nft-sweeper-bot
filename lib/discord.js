'use strict';

const { httpFetch } = require('./http');

/**
 * Prefer DISCORD_WEBHOOK_URL (same as live bot). Falls back to bot token path.
 * Returns async ({ content, embeds }) => void | null if unconfigured.
 */
async function initDiscord() {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (webhookUrl) {
    return async ({ content, embeds }) => {
      const payload = {};
      if (content) payload.content = content;
      if (embeds) payload.embeds = embeds;
      const res = await httpFetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Webhook ${res.status}: ${text.slice(0, 200)}`);
      }
    };
  }

  if (!process.env.DISCORD_TOKEN || !process.env.DISCORD_CHANNEL_ID) {
    return null;
  }

  const { Client, GatewayIntentBits } = require('discord.js');
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await new Promise((resolve, reject) => {
    client.once('clientReady', resolve);
    client.once('error', reject);
    client.login(process.env.DISCORD_TOKEN).catch(reject);
  });

  return async ({ content, embeds }) => {
    const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);
    if (!channel) throw new Error('Discord channel not found');
    await channel.send({ content, embeds });
  };
}

module.exports = { initDiscord };
