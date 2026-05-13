import fs from 'node:fs';
import path from 'node:path';

const proxyListDir = path.resolve(process.cwd(), 'proxy-list');

function normalizeProxyLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('#')) return null;

  // Accept: host:port OR http://host:port OR https://host:port
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-zA-Z0-9.-]+:\d+$/.test(trimmed)) return `http://${trimmed}`;

  return null;
}

function parseTxt(content) {
  const lines = content.split(/\r?\n/);
  const out = [];
  for (const l of lines) {
    const p = normalizeProxyLine(l);
    if (p) out.push(p);
  }
  return out;
}

function parseJson(content) {
  const parsed = JSON.parse(content);
  const out = [];

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (typeof item === 'string') {
        const p = normalizeProxyLine(item);
        if (p) out.push(p);
      } else if (item && typeof item === 'object') {
        // { host, port, protocol }
        const host = item.host ?? item.ip ?? item.address;
        const port = item.port;
        const protocol = item.protocol || item.type || 'http';
        if (host && port) {
          out.push(`${protocol}://${host}:${port}`);
        }
      }
    }
  } else if (parsed && typeof parsed === 'object') {
    // { proxies: [...] }
    const maybe = parsed.proxies;
    if (Array.isArray(maybe)) {
      for (const item of maybe) {
        const p = typeof item === 'string' ? normalizeProxyLine(item) : null;
        if (p) out.push(p);
      }
    }
  }

  return out;
}

export async function loadLocalProxyLists() {
  if (!fs.existsSync(proxyListDir)) {
    return { rotating: [], country: [], morocco: [] };
  }

  const files = fs.readdirSync(proxyListDir).filter((f) => /\.(txt|json)$/i.test(f));
  const buckets = { rotating: [], country: [], morocco: [] };

  for (const fileName of files) {
    const filePath = path.join(proxyListDir, fileName);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const ext = path.extname(fileName).toLowerCase();
      const proxies = ext === '.txt' ? parseTxt(content) : parseJson(content);

      // Heuristics by file name
      const lower = fileName.toLowerCase();
      if (lower.includes('ma') || lower.includes('morocco')) {
        buckets.morocco.push(...proxies);
      } else if (lower.includes('country')) {
        buckets.country.push(...proxies);
      } else {
        buckets.rotating.push(...proxies);
      }
    } catch {
      // ignore invalid files
    }
  }

  // de-dupe
  for (const k of Object.keys(buckets)) {
    buckets[k] = [...new Set(buckets[k])];
  }

  return buckets;
}

export function getProxyListDir() {
  return proxyListDir;
}

