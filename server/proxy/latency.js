function nowMs() {
  return Date.now();
}

export async function measureLatency(url, { proxyUrl = null, timeoutMs = 4000 } = {}) {
  const started = nowMs();

  const headers = {
    Accept: '*/*',
    'User-Agent': 'IPTV Proxy Manager/1.0'
  };

  // Note: Node fetch does not support proxy for undici by default.
  // We keep proxyUrl parameter for compatibility with future implementation.
  // For now, we treat proxyUrl as unsupported and always measure direct.
  // The real upstream proxying will happen in proxyManager where we can implement tunneling.
  // This stub still returns a reasonable value for direct/direct-health.
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    });
    // Consume a small amount
    if (res.body) {
      const reader = res.body.getReader();
      await reader?.read();
      try { await reader?.cancel(); } catch {}
    }
    return { ok: res.ok, latencyMs: nowMs() - started, status: res.status };
  } catch (e) {
    return { ok: false, latencyMs: nowMs() - started, status: 0, error: e?.message };
  }
}

