#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { runMorningDigest, buildMockSet } = require('../lib/pipeline');
const { formatMorningDigest, formatBreaking } = require('../lib/format');

async function main() {
  console.log('=== SWEEP DRY RUN (mocked) ===\n');

  const mocked = buildMockSet();
  const rejected = mocked.filter((o) => o.rejected);
  const passed = mocked.filter((o) => !o.rejected).sort((a, b) => b.score - a.score);

  console.log('Rejects:');
  for (const r of rejected) {
    console.log(`  - ${r.name} (${r.chain}/${r.slug}): ${r.rejectReason}`);
  }
  console.log('');

  console.log(formatMorningDigest(passed, { dry: true }));

  const live = passed.find((o) => o.thesis === 'LIVE_SWEEP');
  if (live) {
    console.log('--- BREAKING SAMPLE ---\n');
    console.log(formatBreaking(live));
    console.log('');
  }

  await runMorningDigest({ mock: true, dry: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
