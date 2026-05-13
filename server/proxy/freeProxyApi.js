const FREEPROXY_ENDPOINT = 'https://freeproxy24.com/api/free-proxy-list';

export async function fetchFreeProxies({ country, limit = 200, page = 1, timeoutMs = 12000 }) {
  const url = new URL(FREEPROXY_ENDPOINT);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('page', String(page));
  url.searchParams.set('country', country);
  url.searchParams.set('sortBy', 'lastChecked');
  url.searchParams.set('sortType', 'desc');

  const res = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'IPTV Proxy Manager/1.0'
    },
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!res.ok) {
    throw new Error(`freeproxy24 error ${res.status}`);
  }

  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }

  // Typical API formats vary; normalize to array of URLs
  const proxies = [];

  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (typeof item === 'string') proxies.push(item);
      else if (item && typeof item === 'object') {
        const host = item.host || item.ip || item.address;
        const port = item.port;
        const protocol = item.protocol || item.type || 'http';
        if (host && port) proxies.push(`${protocol}://${host}:${port}`);
      }
    }
  } else if (payload && typeof payload === 'object') {
    // { data: [...] } or similar
    const arr = payload.data || payload.proxies || payload.results;
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (typeof item === 'string') proxies.push(item);
        else if (item && typeof item === 'object') {
          const host = item.host || item.ip || item.address;
          const port = item.port;
          const protocol = item.protocol || item.type || 'http';
          if (host && port) proxies.push(`${protocol}://${host}:${port}`);
        }
      }
    }
  }

  return [...new Set(proxies)];
}

