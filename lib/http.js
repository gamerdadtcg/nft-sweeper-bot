'use strict';

function httpFetch(url, options) {
  const fetchFn = globalThis.fetch || require('node-fetch');
  return fetchFn(url, options);
}

async function httpJson(url, options = {}) {
  const res = await httpFetch(url, options);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body || {}).slice(0, 200);
    const err = new Error(`HTTP ${res.status} ${url}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

module.exports = { httpFetch, httpJson };
