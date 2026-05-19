const SESSION_KEY = "checker-iptv-session-id";

export function getClientSessionId() {
  const existing = window.localStorage.getItem(SESSION_KEY);

  if (existing) {
    return existing;
  }

  const next = crypto.randomUUID();
  window.localStorage.setItem(SESSION_KEY, next);
  return next;
}

export function buildSessionHeaders(headers: HeadersInit = {}) {
  return {
    ...headers,
    "x-session-id": getClientSessionId()
  };
}
