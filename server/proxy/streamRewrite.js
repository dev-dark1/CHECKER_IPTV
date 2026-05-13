function proxied(req, targetUrl) {
  return `/proxy?url=${encodeURIComponent(targetUrl)}`;
}

export function rewritePlaylistIfNeeded({ text, targetUrl, req }) {
  const contentTypeGuessIsPlaylist = /\.m3u8?(\?|$)/i.test(targetUrl) || /#EXTM3U/i.test(text);
  if (!contentTypeGuessIsPlaylist) return { rewritten: false, body: text };

  const lines = text.split(/\r?\n/);
  const out = lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_m, uri) => {
          const absolute = new URL(uri, targetUrl).toString();
          return `URI="${proxied(req, absolute)}"`;
        });
      }

      // segment/playlist lines
      return proxied(req, new URL(trimmed, targetUrl).toString());
    })
    .join('\n');

  return { rewritten: true, body: out };
}

