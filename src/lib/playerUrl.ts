export function buildBrowserPlayableUrl(sourceUrl: string) {
  return sourceUrl.trim();
}

export function buildVlcUrl(sourceUrl: string) {
  return `vlc://${sourceUrl.replace(/^https?:\/\//i, "")}`;
}

export function buildMxUrl(sourceUrl: string) {
  return `intent:${sourceUrl}#Intent;package=com.mxtech.videoplayer.ad;type=video/*;end`;
}
