export function buildHeaderProfile(profile) {
  switch (profile) {
    case 'VLC':
      return {
        'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18',
        'Accept': '*/*',
        'Referer': 'https://google.com',
        'Origin': '*'
      };
    case 'MX':
      return {
        'User-Agent': 'okhttp/3.12.1',
        'Accept': '*/*',
        'X-Requested-With': 'com.mxplayer'
      };
    case 'AndroidIPTV':
      return {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13; IPTV) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36',
        'Accept': '*/*'
      };
    default:
      return {
        'User-Agent': 'IPTV Proxy Relay/1.0',
        'Accept': '*/*'
      };
  }
}

export function pickHeaderProfileForUrl(targetUrl) {
  const u = String(targetUrl || '').toLowerCase();
  if (/mxplayer|mx\b/i.test(u)) return 'MX';
  if (/vlc/i.test(u)) return 'VLC';
  return 'AndroidIPTV';
}

