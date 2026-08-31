'use strict';

const { httpJson } = require('./http');
const { CHAINS } = require('./config');

/** Fail-soft RH Chain enrichment via Blockscout. */
async function fetchRecentTokenTransfers(contract, limit = 50) {
  const api = CHAINS.robinhood.blockscoutApi;
  if (!contract) return [];
  try {
    const data = await httpJson(
      `${api}?module=account&action=tokentx&contractaddress=${contract}&page=1&offset=${limit}&sort=desc`
    );
    if (data.status !== '1' || !Array.isArray(data.result)) return [];
    return data.result.map((tx) => ({
      from: (tx.from || '').toLowerCase(),
      to: (tx.to || '').toLowerCase(),
      tokenId: tx.tokenID || tx.tokenId,
      timestamp: Number(tx.timeStamp) * 1000,
      hash: tx.hash,
    }));
  } catch (err) {
    console.warn(`[blockscout] transfers ${contract}: ${err.message}`);
    return [];
  }
}

module.exports = { fetchRecentTokenTransfers };
