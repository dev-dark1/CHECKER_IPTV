function unwrapProxySourceUrl(sourceUrl: string) {
  const trimmed = sourceUrl.trim();

  try {
    const parsed = new URL(trimmed, "http://local.invalid");
    const nestedUrl = parsed.searchParams.get("url");

    if (
      nestedUrl &&
      (parsed.pathname === "/proxy" ||
        parsed.pathname === "/api/player/stream" ||
        parsed.pathname === "/api/hls-proxy")
    ) {
      return nestedUrl;
    }
  } catch {
    return trimmed;
  }

  return trimmed;
}

function buildXtreamBrowserCandidate(sourceUrl: string) {
  try {
    const parsed = new URL(sourceUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const suffix = `${parsed.search}${parsed.hash}`;

    if (segments.length === 3 && !segments[2].includes(".")) {
      return `${parsed.origin}/live/${segments[0]}/${segments[1]}/${segments[2]}.m3u8${suffix}`;
    }

    if (segments.length === 4 && /^live$/i.test(segments[0]) && !segments[3].includes(".")) {
      return `${parsed.origin}/live/${segments[1]}/${segments[2]}/${segments[3]}.m3u8${suffix}`;
    }
  } catch {
    return sourceUrl;
  }

  return sourceUrl;
}

export function buildBrowserPlayableUrl(sourceUrl: string) {
  return buildXtreamBrowserCandidate(unwrapProxySourceUrl(sourceUrl));
}

export function buildVlcUrl(sourceUrl: string) {
  return `vlc://${sourceUrl.replace(/^https?:\/\//i, "")}`;
}

export function buildMxUrl(sourceUrl: string) {
  return `intent:${sourceUrl}#Intent;package=com.mxtech.videoplayer.ad;type=video/*;end`;
}
