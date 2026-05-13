export async function detectCountryCode(timeoutMs = 4000) {
  const fallback = 'MA';

  try {
    const res = await fetch('https://ipapi.co/json/', {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return fallback;
    const json = await res.json();
    const cc = json?.country_code || json?.countryCode;
    if (typeof cc === 'string' && /^[A-Z]{2}$/i.test(cc)) return cc.toUpperCase();
  } catch {
    // ignore
  }

  return fallback;
}

