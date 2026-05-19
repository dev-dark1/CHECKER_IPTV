const rawApiBaseUrl = (import.meta.env.VITE_API_BASE_URL || "").trim();

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

export function getApiBaseUrl() {
  return rawApiBaseUrl ? trimTrailingSlash(rawApiBaseUrl) : "";
}

export function getApiOrigin() {
  const baseUrl = getApiBaseUrl();

  if (!baseUrl) {
    return window.location.origin;
  }

  try {
    return new URL(baseUrl).origin;
  } catch {
    return window.location.origin;
  }
}

export function buildApiUrl(pathname: string) {
  const baseUrl = getApiBaseUrl();

  if (!baseUrl) {
    return pathname;
  }

  return new URL(pathname, `${baseUrl}/`).toString();
}

export function buildProxyUrl(targetUrl: string, retry = 0) {
  const url = new URL(buildApiUrl("/proxy"), window.location.origin);
  url.searchParams.set("url", targetUrl);

  if (retry > 0) {
    url.searchParams.set("retry", String(Math.min(3, Math.floor(retry))));
  }

  return url.toString();
}

export function buildProxyProbeUrl(targetUrl: string, retry = 0) {
  const url = new URL(buildApiUrl("/proxy/probe"), window.location.origin);
  url.searchParams.set("url", targetUrl);

  if (retry > 0) {
    url.searchParams.set("retry", String(Math.min(3, Math.floor(retry))));
  }

  return url.toString();
}
