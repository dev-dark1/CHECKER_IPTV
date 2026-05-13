export const proxyState = {
  // Pools
  direct: { enabled: true },
  country: { countryCode: null, proxies: [], updatedAt: 0 },
  morocco: { proxies: [], updatedAt: 0 },
  rotating: { proxies: [], updatedAt: 0 },

  // Active selection
  activePool: 'direct',
  activeProxy: null,

  // Health & failure
  stats: {
    // key: `${poolName}|${proxy}`
    // value: { fails, lastFailAt, lastLatencyMs, deadUntil }
  }
};

