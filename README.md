# NFT Sweeper Bot

Live OpenSea sale streamer (existing) **plus** a morning sweep-opportunity digest for **Ethereum** and **Robinhood Chain (4663)**.

## What it does

### Live bot (`npm start`)
Watches OpenSea sales and alerts when one wallet buys ≥5 NFTs (>0.001 ETH each) in 15 minutes on Ethereum. Unchanged behavior.

### Morning digest (`npm run sweep:digest`)
Once a day (run at 7:00 America/Los_Angeles via cron/Railway):

1. Seeds candidates from `data/watchlist.json` + OpenSea trending (ETH + Robinhood)
2. Pulls floor, best asks, last sales, stats
3. Hard-filters dead/thin/wash/blacklist books
4. Scores 0–100 (depth / dislocation / flow / quality)
5. Dedupes against `data/posted.json`
6. Posts **one** ranked digest (max 8, score ≥ 62, fallback ≥ 52 if <3 pass)

Optional breaking alerts (score ≥ 75 + live sweep / fresh depth) are wired in `runBreakingCheck` — not dripped by default.

`LIVE_BUY` defaults **false**. This repo does not execute buys.

## Setup

```bash
cp .env.example .env
# fill OPENSEA_API_KEY + DISCORD_WEBHOOK_URL
npm install
```

Edit `data/watchlist.json` with collection slugs you care about (per chain).  
Edit `data/blacklist.json` for farms / junk slugs.

## Commands

```bash
# Mocked digest (no API key) — dump book + live sweep + reject
npm run sweep:dry

# Live scan, print only (needs OPENSEA_API_KEY)
npm run sweep:digest

# Live scan + post to Discord
npm run sweep:digest:post

# Existing live sweep streamer
npm start
```

### Cron (7:00 AM PT)

Railway cron / GitHub Action / system crontab:

```bash
0 14 * * * cd /app && npm run sweep:digest:post
# 14:00 UTC ≈ 7:00 America/Los_Angeles (PST); use 15:00 during PDT
```

## Scoring (short)

| Bucket | Max | Signals |
|--------|-----|---------|
| Depth | 30 | asks within 5%, ETH to lift +10%, bid support |
| Dislocation | 25 | floor vs last-10 / VWAP, % asks under last sale |
| Flow | 25 | live sweep, buyer/seller imbalance, ask dumps |
| Quality | 20 | volume, holders, watchlist |

Thesis tags: `DUMP_BOOK` · `UNDER_VWAP` · `TRAIT_SNIPE` · `LIVE_SWEEP` · `THIN_ABOVE`

## Hard rejects

Null floor · <3 listings in first 10% · dead volume · low holders · stale-high book · blacklist · wash · exit trap

## Dedupe

Same thesis: 18h cooldown unless floor moves ≥8%, depth +50%, or thesis changes (then 6h).

## Layout

```
index.js              # live stream bot
lib/                  # digest pipeline
  config.js score.js format.js pipeline.js
  opensea.js blockscout.js store.js discord.js http.js
scripts/
  sweep-dry.js        # mocked voice check
  sweep-digest.js     # morning job
data/
  watchlist.json
  blacklist.json
  posted.json         # runtime memory (gitignored)
```

## Env

| Var | Required | Use |
|-----|----------|-----|
| `OPENSEA_API_KEY` | yes (digest/live) | OpenSea API/stream |
| `DISCORD_WEBHOOK_URL` | recommended | alerts + digest |
| `DISCORD_TOKEN` + `DISCORD_CHANNEL_ID` | fallback | bot gateway |
| `LIVE_BUY` | no | must stay `false` unless buy path added |
