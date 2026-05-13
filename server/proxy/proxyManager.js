import fs from 'node:fs';
import path from 'node:path';
import { proxyState } from './proxyState.js';
import { loadLocalProxyLists } from './proxySources.js';
import { detectCountryCode } from './proxyGeo.js';
import { fetchFreeProxies } from './freeProxyApi.js';

const UPSTREAM_PROXY_DISABLED_DEFAULT = true;

function getEnv(name) {
  const v = process.env[name];
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

function normalizeProxyUrl(proxyUrl) {
  const s = String(proxyUrl || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) return `http://${s}`;
  return s;
}

function proxyKey(poolName, proxyUrl) {
  return `${poolName}|${proxyUrl}`;
}

function getProxyStats(key) {
  return proxyState.stats[key] || null;
}

function markProxyDead(poolName, proxyUrl, deadMs = 60_000) {
  const p = normalizeProxyUrl(proxyUrl);
  if (!p) return;
  const key = proxyKey(poolName, p);
  const prev = proxyState.stats[key] || { fails: 0 };
  proxyState.stats[key] = {
    ...prev,
    fails: (prev.fails || 0) + 1,
    lastFailAt: Date.now(),
    deadUntil: Date.now() + deadMs
  };
}

function markProxyHealthy(poolName, proxyUrl, latencyMs) {
  const p = normalizeProxyUrl(proxyUrl);
  if (!p) return;
  const key = proxyKey(poolName, p);
  const prev = proxyState.stats[key] || { fails: 0 };
  proxyState.stats[key] = {
    ...prev,
    lastLatencyMs: latencyMs ?? prev.lastLatencyMs,
    lastFailAt: prev.lastFailAt,
    deadUntil: 0
  };
}

function isProxyDead(poolName, proxyUrl) {
  const p = normalizeProxyUrl(proxyUrl);
  if (!p) return true;
  const key = proxyKey(poolName, p);
  const s = proxyState.stats[key];
  if (!s?.deadUntil) return false;
  return Date.now() < s.deadUntil;
}

async function initPoolsOnce() {
  if (proxyState.country.updatedAt && Date.now() - proxyState.country.updatedAt < 6 * 60_000) {
    return;
  }

  // Load local lists
  const localBuckets = await loadLocalProxyLists();

  // Country detection
  const cc = await detectCountryCode();
  proxyState.country.countryCode = cc;

  // Free proxy fetch
  let countryFromApi = [];
  let moroccoFromApi = [];
  let rotatingFromApi = [];
  try {
    countryFromApi = await fetchFreeProxies({ country: cc, limit: 500, page: 1 });
  } catch {}
  try {
    moroccoFromApi = await fetchFreeProxies({ country: 'MA', limit: 500, page: 1 });
  } catch {}

  // Rotating (fallback) = merge country + morocco
  rotatingFromApi = [...countryFromApi, ...moroccoFromApi];

  proxyState.country.proxies = [...new Set([...localBuckets.country, ...countryFromApi])];
  proxyState.morocco.proxies = [...new Set([...localBuckets.morocco, ...moroccoFromApi])];
  proxyState.rotating.proxies = [...new Set([...localBuckets.rotating, ...rotatingFromApi])];

  proxyState.country.updatedAt = Date.now();
  proxyState.morocco.updatedAt = Date.now();
  proxyState.rotating.updatedAt = Date.now();
}

export async function selectProxyForRequest({ failoverIndex = 0 } = {}) {
  // Priority order
  // 0) direct local fetch via relay (no upstream proxy URL)
  // 1) country
  // 2) morocco
  // 3) rotating
  const priorityPools = ['direct', 'country', 'morocco', 'rotating'];

  const poolName = priorityPools[Math.min(failoverIndex, priorityPools.length - 1)];
  if (poolName === 'direct') {
    return { poolName: 'direct', proxyUrl: null };
  }

  await initPoolsOnce();

  const list = proxyState[poolName].proxies || [];

  // Pick first not-dead; if all dead, allow first
  for (const p of list) {
    if (!isProxyDead(poolName, p)) {
      return { poolName, proxyUrl: normalizeProxyUrl(p) };
    }
  }

  return { poolName, proxyUrl: normalizeProxyUrl(list[0] || null) };
}

export function markProxyFailure({ poolName, proxyUrl }) {
  if (poolName === 'direct' || !proxyUrl) return;
  markProxyDead(poolName, proxyUrl);
}

export function markProxySuccess({ poolName, proxyUrl, latencyMs }) {
  if (poolName === 'direct' || !proxyUrl) return;
  markProxyHealthy(poolName, proxyUrl, latencyMs);
}

