#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { runMorningDigest } = require('../lib/pipeline');

async function main() {
  const post = process.argv.includes('--post');
  const mock = process.argv.includes('--mock');
  console.log(`=== SWEEP MORNING DIGEST (${mock ? 'mock' : 'live'}, ${post ? 'POST' : 'dry'}) ===\n`);

  if (!mock && !process.env.OPENSEA_API_KEY) {
    console.error('OPENSEA_API_KEY required. Use --mock or npm run sweep:dry');
    process.exit(1);
  }

  await runMorningDigest({
    mock,
    dry: !post,
    post,
    trending: !process.argv.includes('--watchlist-only'),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
