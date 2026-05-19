import crypto from "node:crypto";
import compression from "compression";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import fs from "node:fs";
import helmet from "helmet";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { ProxyAgent } from "undici";
import { initializeDatabase, isDatabaseEnabled } from "./db.js";
import {
  deletePlaylistFromDatabase,
  getSessionId,
  loadFavoritesFromDatabase,
  loadHistoryFromDatabase,
  loadPlaylistsFromDatabase,
  recordCheckerReport,
  recordExportedFile,
  recordScanHistory,
  saveFavoritesToDatabase,
  saveHistoryEntryToDatabase,
  savePlaylistToDatabase,
  upsertStreamDiagnostics
} from "./persistence.js";
import { markProxyFailure, markProxySuccess, selectProxyForRequest } from "./proxy/proxyManager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.resolve(__dirname, "../dist");
const isVercelRuntime = Boolean(process.env.VERCEL);
const cacheRoot = isVercelRuntime
  ? path.join("/tmp", "checker-iptv-cache")
  : path.resolve(__dirname, "../cache");
const playlistCacheDir = path.join(cacheRoot, "playlists");
const logoCacheDir = path.join(cacheRoot, "logos");
const historyCacheDir = path.join(cacheRoot, "history");
const historyCacheFile = path.join(historyCacheDir, "recent.json");
const checkerEndpoint = process.env.IPTV_CHECKER_ENDPOINT || "https://iptvchecker.site/";
const port = Number(process.env.PORT || 4000);
const allowedOrigins = String(process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

for (const dir of [cacheRoot, playlistCacheDir, logoCacheDir, historyCacheDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

const app = express();
app.set("trust proxy", 1);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Origin not allowed by CORS policy"));
    }
  })
);
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: false
  })
);
app.use(compression());
const apiRateLimit = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_MAX || 240),
  standardHeaders: true,
  legacyHeaders: false
});
app.use("/api", apiRateLimit);
app.use("/proxy/probe", apiRateLimit);
app.use(express.json({ limit: "25mb" }));

void initializeDatabase().catch((error) => {
  console.warn("[db] initialization failed", error instanceof Error ? error.message : error);
});

const supportedPath = /\/get\.php$/i;
const PLAYER_STATUS = {
  working: "working_player",
  dead: "dead_stream",
  buffering: "buffering",
  blocked: "blocked_stream",
  timeout: "timeout",
  expired: "expired",
  skipped: "not_tested"
};
const IPTV_REQUEST_HEADERS = {
  "User-Agent": "VLC/3.0.18 LibVLC/3.0.18"
};
const PROXY_FAILOVER_PLAN = [0, 1, 2, 3, 3, 3];
const proxyAgents = new Map();

function getProxyAgent(proxyUrl) {
  if (!proxyUrl) return undefined;

  if (!proxyAgents.has(proxyUrl)) {
    proxyAgents.set(proxyUrl, new ProxyAgent(proxyUrl));
  }

  return proxyAgents.get(proxyUrl);
}

function getRequestOrigin(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return /^https?:$/i.test(parsed.protocol);
  } catch {
    return false;
  }
}

function unwrapProxyTarget(value) {
  const raw = String(value || "").trim();

  try {
    const parsed = new URL(raw, "http://local.invalid");
    if ((parsed.pathname === "/proxy" || parsed.pathname === "/api/player/stream" || parsed.pathname === "/api/hls-proxy") && parsed.searchParams.get("url")) {
      return parsed.searchParams.get("url");
    }
  } catch {
    // fall through
  }

  return raw;
}

function buildProxyPath(req, targetUrl) {
  const retry = Number(req?.query?.retry || 0);
  const retryParam = Number.isFinite(retry) && retry > 0 ? `&retry=${Math.min(3, Math.floor(retry))}` : "";
  return `/proxy?url=${encodeURIComponent(unwrapProxyTarget(targetUrl))}${retryParam}`;
}

function buildAbsoluteProxyUrl(req, targetUrl) {
  return `${getRequestOrigin(req)}${buildProxyPath(req, targetUrl)}`;
}

function parseXtreamLiveTarget(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);

    if (segments.length === 3) {
      const [username, password, streamPart] = segments;
      const match = streamPart.match(/^([^/?#.]+?)(?:\.([a-z0-9]+))?$/i);

      if (!match) {
        return null;
      }

      return {
        parsed,
        username,
        password,
        streamId: match[1],
        extension: match[2]?.toLowerCase() || null,
        kind: "raw"
      };
    }

    if (segments.length === 4 && /^live$/i.test(segments[0])) {
      const [, username, password, streamPart] = segments;
      const match = streamPart.match(/^([^/?#.]+?)(?:\.([a-z0-9]+))?$/i);

      if (!match) {
        return null;
      }

      return {
        parsed,
        username,
        password,
        streamId: match[1],
        extension: match[2]?.toLowerCase() || null,
        kind: "live"
      };
    }
  } catch {
    return null;
  }

  return null;
}

function buildProxyTargetCandidates(targetUrl) {
  const xtreamTarget = parseXtreamLiveTarget(targetUrl);

  if (!xtreamTarget) {
    return [targetUrl];
  }

  if (xtreamTarget.kind === "live" && xtreamTarget.extension) {
    return [targetUrl];
  }

  const { parsed, username, password, streamId, extension } = xtreamTarget;
  const suffix = `${parsed.search}${parsed.hash}`;
  const candidates = [];
  const pushCandidate = (value) => {
    if (!candidates.includes(value)) {
      candidates.push(value);
    }
  };

  pushCandidate(`${parsed.origin}/live/${username}/${password}/${streamId}.m3u8${suffix}`);

  if (extension && extension !== "m3u8") {
    pushCandidate(`${parsed.origin}/live/${username}/${password}/${streamId}.${extension}${suffix}`);
  }

  pushCandidate(`${parsed.origin}/live/${username}/${password}/${streamId}.ts${suffix}`);
  pushCandidate(targetUrl);

  return candidates;
}

function isHlsPlaylistUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    return /\.m3u8?$/i.test(parsed.pathname);
  } catch {
    return /\.m3u8(\?|$)/i.test(String(targetUrl || ""));
  }
}

function isDashManifestUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    return /\.mpd$/i.test(parsed.pathname);
  } catch {
    return /\.mpd(\?|$)/i.test(String(targetUrl || ""));
  }
}

function isRejectedTextContent(contentType) {
  return /text\/html|text\/plain/i.test(contentType || "");
}

function isAllowedStreamContentType(contentType, targetUrl) {
  const normalized = String(contentType || "").split(";")[0].trim().toLowerCase();

  if (!normalized) {
    return true;
  }

  if (isRejectedTextContent(normalized)) {
    return false;
  }

  if (
    normalized === "application/vnd.apple.mpegurl" ||
    normalized === "application/x-mpegurl" ||
    normalized === "audio/x-mpegurl" ||
    normalized === "audio/mpegurl" ||
    normalized === "video/mp2t" ||
    normalized === "video/mp4" ||
    normalized === "application/mp4" ||
    normalized === "application/octet-stream" ||
    normalized === "application/dash+xml" ||
    normalized === "application/xml" ||
    normalized === "text/xml"
  ) {
    return true;
  }

  return isHlsPlaylistUrl(targetUrl) || isDashManifestUrl(targetUrl);
}

function looksLikeHtmlError(value) {
  return /<!doctype html|<html[\s>]|cloudflare|captcha|access denied|forbidden|login/i.test(String(value || "").slice(0, 2048));
}

function logProxy(event, details) {
  console.log(`[proxy:${event}] ${JSON.stringify(details)}`);
}

function normalizeCandidateUrl(candidate) {
  return String(candidate || "")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function isSupportedM3uUrl(candidate) {
  const cleaned = normalizeCandidateUrl(candidate);

  try {
    const parsed = new URL(cleaned);
    const type = (parsed.searchParams.get("type") || "").toLowerCase();
    const username = parsed.searchParams.get("username");
    const password = parsed.searchParams.get("password");

    return (
      /^https?:$/i.test(parsed.protocol) &&
      Boolean(username) &&
      ((supportedPath.test(parsed.pathname) && type.includes("m3u")) ||
        (/\/player_api\.php$/i.test(parsed.pathname) && Boolean(password)))
    );
  } catch {
    return false;
  }
}

function hashString(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function safeFileName(value) {
  return String(value || "playlist")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, payload) {
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function parseNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBoolean(value) {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return null;
}

function buildStreamResult(status, message, overrides = {}) {
  return {
    status,
    streamUrl: null,
    streamName: null,
    httpCode: null,
    contentType: null,
    responseMs: null,
    previewUrl: null,
    sourceKind: null,
    message,
    ...overrides
  };
}

function buildInvalidResponse(url, message = "Unsupported M3U URL format.") {
  return {
    url,
    status: "invalid",
    verdict: "dead",
    checkerStatus: "invalid",
    httpCode: null,
    timeMs: null,
    message,
    xtreamApiUrl: null,
    account: null,
    stream: buildStreamResult(PLAYER_STATUS.skipped, message)
  };
}

function normalizeRemoteResult(payload, fallbackUrl) {
  const checkerStatus = String(payload?.status || "error").toLowerCase();

  return {
    url: typeof payload?.url === "string" ? payload.url : fallbackUrl,
    status: checkerStatus,
    verdict: checkerStatus === "active" ? "active" : "dead",
    checkerStatus,
    httpCode:
      typeof payload?.http_code === "number"
        ? payload.http_code
        : typeof payload?.httpCode === "number"
          ? payload.httpCode
          : null,
    timeMs:
      typeof payload?.time_ms === "number"
        ? payload.time_ms
        : typeof payload?.timeMs === "number"
          ? payload.timeMs
          : null,
    message: typeof payload?.message === "string" ? payload.message : "Unknown checker response.",
    xtreamApiUrl: null,
    account: null,
    stream: buildStreamResult(PLAYER_STATUS.skipped, "Stream test was not started.")
  };
}

function parseExpiration(value, status) {
  const normalized = value === undefined || value === null ? "" : String(value).trim();
  const loweredStatus = String(status || "").toLowerCase();

  if (!normalized || normalized === "0" || normalized.toLowerCase() === "null") {
    return {
      expDate: null,
      expTimestamp: null,
      remainingDays: null,
      isExpired: loweredStatus.includes("expired")
    };
  }

  const numeric = Number(normalized);
  const timestampMs = Number.isFinite(numeric)
    ? numeric > 1_000_000_000_000
      ? numeric
      : numeric * 1000
    : Date.parse(normalized);

  if (!Number.isFinite(timestampMs)) {
    return {
      expDate: normalized,
      expTimestamp: null,
      remainingDays: null,
      isExpired: loweredStatus.includes("expired")
    };
  }

  const remainingDays = Math.ceil((timestampMs - Date.now()) / 86_400_000);

  return {
    expDate: new Date(timestampMs).toISOString(),
    expTimestamp: Math.floor(timestampMs / 1000),
    remainingDays,
    isExpired: remainingDays < 0 || loweredStatus.includes("expired")
  };
}

function buildCredentialsFromM3uUrl(m3uUrl) {
  try {
    const parsed = new URL(m3uUrl);
    const username = parsed.searchParams.get("username");
    const password = parsed.searchParams.get("password");

    if (!username || !password) {
      return null;
    }

    return {
      origin: parsed.origin,
      username,
      password,
      output: parsed.searchParams.get("output") || "ts"
    };
  } catch {
    return null;
  }
}

function buildXtreamApiUrl(m3uUrl) {
  const credentials = buildCredentialsFromM3uUrl(m3uUrl);

  if (!credentials) {
    return null;
  }

  const api = new URL("/player_api.php", credentials.origin);
  api.searchParams.set("username", credentials.username);
  api.searchParams.set("password", credentials.password);
  return api.toString();
}

function buildXtreamPlaylistUrl(value) {
  try {
    const parsed = new URL(value);

    if (!/\/player_api\.php$/i.test(parsed.pathname)) {
      return value;
    }

    const playlistUrl = new URL("/get.php", parsed.origin);
    playlistUrl.searchParams.set("username", parsed.searchParams.get("username") || "");
    playlistUrl.searchParams.set("password", parsed.searchParams.get("password") || "");
    playlistUrl.searchParams.set("type", parsed.searchParams.get("type") || "m3u_plus");
    playlistUrl.searchParams.set("output", parsed.searchParams.get("output") || "m3u8");
    return playlistUrl.toString();
  } catch {
    return value;
  }
}

function buildXtreamActionUrl(apiUrl, action) {
  const next = new URL(apiUrl);
  next.searchParams.set("action", action);
  return next.toString();
}

async function fetchJson(url, timeoutMs = 12000) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json,text/plain,*/*",
      "User-Agent": "M3U Active Checker/1.0"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });

  const text = await response.text();
  return JSON.parse(text);
}

async function fetchText(url, timeoutMs = 20000, accept = "*/*") {
  const response = await fetch(url, {
    headers: {
      Accept: accept,
      "User-Agent": "M3U Active Checker/1.0"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`Remote source returned ${response.status}.`);
  }

  return response.text();
}

function normalizeAccountInfo(payload) {
  const userInfo = payload && typeof payload === "object" ? payload.user_info || null : null;

  if (!userInfo || typeof userInfo !== "object") {
    return null;
  }

  const status = userInfo.status ? String(userInfo.status) : null;
  const expiration = parseExpiration(userInfo.exp_date, status);
  const activeConnections = parseNumber(userInfo.active_cons);
  const maxConnections = parseNumber(userInfo.max_connections);
  const isTrial = parseBoolean(userInfo.is_trial);

  return {
    userInfo,
    status,
    expDate: expiration.expDate,
    expTimestamp: expiration.expTimestamp,
    remainingDays: expiration.remainingDays,
    isExpired: expiration.isExpired,
    isTrial,
    activeConnections,
    maxConnections
  };
}

function absoluteProxyUrl(req, targetUrl) {
  return buildAbsoluteProxyUrl(req, targetUrl);
}

function buildPlayableProxyUrl(req, targetUrl) {
  return buildAbsoluteProxyUrl(req, targetUrl);
}

function parseFirstStreamFromM3u(text) {
  const lines = text.split(/\r?\n/);
  let pendingName = null;
  let firstGeneric = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) continue;

    if (line.startsWith("#EXTINF")) {
      const label = line.split(",").slice(1).join(",").trim();
      pendingName = label || "Sample stream";
      continue;
    }

    if (line.startsWith("#")) {
      continue;
    }

    if (/^https?:\/\//i.test(line) && !/\/get\.php|\/player_api\.php/i.test(line)) {
      const candidate = {
        streamUrl: line,
        streamName: pendingName || "Sample stream",
        sourceKind: /\/live\/|\.m3u8(\?|$)|\.ts(\?|$)/i.test(line) ? "playlist_live" : "playlist_generic"
      };

      if (candidate.sourceKind === "playlist_live") {
        return candidate;
      }

      if (!firstGeneric) {
        firstGeneric = candidate;
      }
    }
  }

  return firstGeneric;
}

function buildXtreamLiveCandidates(credentials, liveItem) {
  const urls = [];
  const extension =
    String(liveItem?.container_extension || "").toLowerCase() ||
    String(credentials.output || "ts").toLowerCase();
  const streamId = liveItem?.stream_id || liveItem?.num || liveItem?.id;
  const directSource = typeof liveItem?.stream_source === "string" ? liveItem.stream_source : null;
  const altSource = typeof liveItem?.direct_source === "string" ? liveItem.direct_source : null;

  if (streamId) {
    urls.push(
      `${credentials.origin}/live/${credentials.username}/${credentials.password}/${streamId}.m3u8`
    );
    urls.push(
      `${credentials.origin}/live/${credentials.username}/${credentials.password}/${streamId}.${extension || "ts"}`
    );

    if ((extension || "") !== "ts") {
      urls.push(
        `${credentials.origin}/live/${credentials.username}/${credentials.password}/${streamId}.ts`
      );
    }
  }

  if (directSource && /^https?:\/\//i.test(directSource)) {
    urls.push(directSource);
  }

  if (altSource && /^https?:\/\//i.test(altSource)) {
    urls.push(altSource);
  }

  return [...new Set(urls)];
}

async function pickXtreamLiveSample(apiUrl, credentials) {
  try {
    const payload = await fetchJson(buildXtreamActionUrl(apiUrl, "get_live_streams"), 20000);

    if (!Array.isArray(payload)) {
      return null;
    }

    for (const liveItem of payload) {
      const candidateUrls = buildXtreamLiveCandidates(credentials, liveItem);

      if (candidateUrls.length > 0) {
        return {
          streamUrl: candidateUrls[0],
          fallbackUrls: candidateUrls.slice(1),
          streamName: liveItem?.name || "Xtream Live",
          sourceKind: "xtream_live"
        };
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function fetchPlaylistSample(m3uUrl, apiUrl) {
  const started = Date.now();
  const credentials = buildCredentialsFromM3uUrl(m3uUrl);

  if (apiUrl && credentials) {
    const liveSample = await pickXtreamLiveSample(apiUrl, credentials);

    if (liveSample) {
      return { sample: liveSample, failure: null };
    }
  }

  try {
    const response = await fetch(m3uUrl, {
      headers: {
        Accept: "audio/x-mpegurl,application/vnd.apple.mpegurl,text/plain,*/*",
        "User-Agent": "M3U Active Checker/1.0"
      },
      signal: AbortSignal.timeout(18000)
    });

    if ([401, 403, 451].includes(response.status)) {
      return {
        sample: null,
        failure: buildStreamResult(PLAYER_STATUS.blocked, "Playlist request was blocked.", {
          httpCode: response.status,
          responseMs: Date.now() - started,
          contentType: response.headers.get("content-type")
        })
      };
    }

    if (!response.ok) {
      return {
        sample: null,
        failure: buildStreamResult(PLAYER_STATUS.dead, "Playlist could not be loaded.", {
          httpCode: response.status,
          responseMs: Date.now() - started,
          contentType: response.headers.get("content-type")
        })
      };
    }

    const playlist = await response.text();
    const sample = parseFirstStreamFromM3u(playlist);

    if (!sample) {
      return {
        sample: null,
        failure: buildStreamResult(PLAYER_STATUS.dead, "No playable stream URL was found in the playlist.", {
          httpCode: response.status,
          responseMs: Date.now() - started,
          contentType: response.headers.get("content-type")
        })
      };
    }

    return { sample, failure: null };
  } catch (error) {
    return {
      sample: null,
      failure: buildStreamResult(
        error?.name === "TimeoutError" ? PLAYER_STATUS.timeout : PLAYER_STATUS.dead,
        error instanceof Error ? error.message : "Playlist request failed.",
        { responseMs: Date.now() - started }
      )
    };
  }
}

async function testSingleStreamUrl(candidateUrl, sample, req) {
  const started = Date.now();

  try {
    const response = await fetch(candidateUrl, {
      headers: {
        Accept: "*/*",
        Range: "bytes=0-4095",
        "User-Agent": "M3U Active Checker/1.0"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(9000)
    });

    const responseMs = Date.now() - started;
    const contentType = response.headers.get("content-type");
    const previewUrl = buildPlayableProxyUrl(req, candidateUrl);

    if ([401, 403, 451].includes(response.status)) {
      return buildStreamResult(PLAYER_STATUS.blocked, "Stream server rejected the sample request.", {
        streamUrl: candidateUrl,
        streamName: sample.streamName,
        httpCode: response.status,
        contentType,
        responseMs,
        previewUrl,
        sourceKind: sample.sourceKind
      });
    }

    if ([404, 410].includes(response.status) || response.status >= 500) {
      return buildStreamResult(PLAYER_STATUS.dead, "Stream endpoint returned an error.", {
        streamUrl: candidateUrl,
        streamName: sample.streamName,
        httpCode: response.status,
        contentType,
        responseMs,
        previewUrl,
        sourceKind: sample.sourceKind
      });
    }

    if (!response.ok && response.status !== 206) {
      return buildStreamResult(PLAYER_STATUS.dead, "Stream endpoint was not playable.", {
        streamUrl: candidateUrl,
        streamName: sample.streamName,
        httpCode: response.status,
        contentType,
        responseMs,
        previewUrl,
        sourceKind: sample.sourceKind
      });
    }

    let firstChunk = "";
    try {
      const reader = response.body?.getReader();
      const chunk = reader ? await reader.read() : null;
      firstChunk = chunk?.value ? new TextDecoder().decode(chunk.value.slice(0, 320)) : "";
      await reader?.cancel();
    } catch {
      return buildStreamResult(PLAYER_STATUS.buffering, "Stream responded but buffered before sending media bytes.", {
        streamUrl: candidateUrl,
        streamName: sample.streamName,
        httpCode: response.status,
        contentType,
        responseMs: Date.now() - started,
        previewUrl,
        sourceKind: sample.sourceKind
      });
    }

    if (/text\/html/i.test(contentType || "") && /blocked|forbidden|denied|captcha|cloudflare|expired/i.test(firstChunk)) {
      return buildStreamResult(PLAYER_STATUS.blocked, "Stream returned a block page instead of media.", {
        streamUrl: candidateUrl,
        streamName: sample.streamName,
        httpCode: response.status,
        contentType,
        responseMs,
        previewUrl,
        sourceKind: sample.sourceKind
      });
    }

    const status = responseMs > 4500 ? PLAYER_STATUS.buffering : PLAYER_STATUS.working;
    return buildStreamResult(status, status === PLAYER_STATUS.buffering ? "Stream is reachable but slow to respond." : "Sample live stream responded with playable media bytes.", {
      streamUrl: candidateUrl,
      streamName: sample.streamName,
      httpCode: response.status,
      contentType,
      responseMs,
      previewUrl,
      sourceKind: sample.sourceKind
    });
  } catch (error) {
    return buildStreamResult(
      error?.name === "TimeoutError" ? PLAYER_STATUS.timeout : PLAYER_STATUS.dead,
      error instanceof Error ? error.message : "Stream probe failed.",
      {
        streamUrl: candidateUrl,
        streamName: sample.streamName,
        responseMs: Date.now() - started,
        previewUrl: buildPlayableProxyUrl(req, candidateUrl),
        sourceKind: sample.sourceKind
      }
    );
  }
}

async function testStream(sample, req) {
  if (!sample?.streamUrl) {
    return buildStreamResult(PLAYER_STATUS.dead, "No stream was available to test.");
  }

  const queue = [sample.streamUrl, ...(Array.isArray(sample.fallbackUrls) ? sample.fallbackUrls : [])];

  for (const candidateUrl of queue) {
    const result = await testSingleStreamUrl(candidateUrl, sample, req);

    if (result.status === PLAYER_STATUS.working || result.status === PLAYER_STATUS.buffering) {
      return result;
    }

    if (result.status === PLAYER_STATUS.blocked) {
      return result;
    }
  }

  return testSingleStreamUrl(sample.streamUrl, sample, req);
}

async function enrichAdvancedValidation(baseResult, url, req) {
  const xtreamApiUrl = buildXtreamApiUrl(url);
  let account = null;
  let stream = buildStreamResult(PLAYER_STATUS.skipped, "Advanced stream test was not started.");

  if (xtreamApiUrl) {
    try {
      account = normalizeAccountInfo(await fetchJson(xtreamApiUrl));
    } catch {
      account = null;
    }
  }

  if (account?.isExpired) {
    return {
      ...baseResult,
      xtreamApiUrl,
      account,
      stream: buildStreamResult(PLAYER_STATUS.expired, "Account is expired and cannot play live streams.")
    };
  }

  const playlistProbe = await fetchPlaylistSample(url, xtreamApiUrl);
  if (playlistProbe.failure) {
    stream = playlistProbe.failure;
  } else {
    stream = await testStream(playlistProbe.sample, req);
  }

  return {
    ...baseResult,
    xtreamApiUrl,
    account,
    stream
  };
}

function proxiedUrl(req, targetUrl) {
  return buildProxyPath(req, targetUrl);
}

function rewriteHlsPlaylist(text, targetUrl, req) {
  return rewriteHlsPlaylistToProxy(text, targetUrl, req).body;
}

function getPlaylistCachePath(id) {
  return path.join(playlistCacheDir, `${safeFileName(id)}.json`);
}

function listCachedPlaylists() {
  return fs
    .readdirSync(playlistCacheDir)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => readJsonFile(path.join(playlistCacheDir, fileName), null))
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

function readRecentHistory() {
  return readJsonFile(historyCacheFile, []);
}

function writeRecentHistory(entries) {
  writeJsonFile(historyCacheFile, entries.slice(0, 60));
}

function buildHealthPayload() {
  return {
    ok: true,
    checkerEndpoint,
    cacheRoot,
    databaseEnabled: isDatabaseEnabled(),
    railwayReady: !isVercelRuntime,
    timestamp: new Date().toISOString()
  };
}

app.get("/health", (_req, res) => {
  res.json(buildHealthPayload());
});

app.get("/api/health", (_req, res) => {
  res.json(buildHealthPayload());
});

app.post("/api/check", async (req, res) => {
  const url = typeof req.body?.url === "string" ? normalizeCandidateUrl(req.body.url) : "";
  const sessionId = getSessionId(req);

  if (!url || !isSupportedM3uUrl(url)) {
    return res.status(400).json(buildInvalidResponse(url));
  }

  const form = new FormData();
  form.set("action", "check");
  form.set("url", url);

  try {
    const response = await fetch(checkerEndpoint, {
      method: "POST",
      body: form,
      headers: {
        Accept: "application/json",
        "User-Agent": "M3U Active Checker/1.0"
      },
      signal: AbortSignal.timeout(25000)
    });

    const payload = JSON.parse(await response.text());
    const enrichedResult = await enrichAdvancedValidation(normalizeRemoteResult(payload, url), url, req);
    void upsertStreamDiagnostics(enrichedResult.stream).catch(() => undefined);
    void recordCheckerReport(sessionId, {
      sourceName: url,
      totalCount: 1,
      activeCount: enrichedResult.verdict === "active" ? 1 : 0,
      deadCount: enrichedResult.verdict === "dead" ? 1 : 0,
      result: enrichedResult
    }).catch(() => undefined);
    return res.json(enrichedResult);
  } catch (error) {
    const baseResult = {
      url,
      status: "error",
      verdict: "dead",
      checkerStatus: "error",
      httpCode: null,
      timeMs: null,
      message: error instanceof Error ? error.message : "Unable to reach the remote checker service.",
      xtreamApiUrl: buildXtreamApiUrl(url),
      account: null,
      stream: buildStreamResult(PLAYER_STATUS.skipped, "Remote checker failed before stream validation.")
    };

    try {
      const enrichedResult = await enrichAdvancedValidation(baseResult, url, req);
      void upsertStreamDiagnostics(enrichedResult.stream).catch(() => undefined);
      void recordCheckerReport(sessionId, {
        sourceName: url,
        totalCount: 1,
        activeCount: 0,
        deadCount: 1,
        result: enrichedResult
      }).catch(() => undefined);
      return res.status(502).json(enrichedResult);
    } catch {
      return res.status(502).json(baseResult);
    }
  }
});

app.post("/api/player/fetch-url", async (req, res) => {
  const url = typeof req.body?.url === "string" ? normalizeCandidateUrl(req.body.url) : "";
  const normalizedPlaylistUrl = buildXtreamPlaylistUrl(url);

  if (!normalizedPlaylistUrl) {
    return res.status(400).json({ error: "Playlist URL is required." });
  }

  try {
    const text = await fetchText(
      normalizedPlaylistUrl,
      25000,
      "audio/x-mpegurl,application/vnd.apple.mpegurl,text/plain,*/*"
    );
    return res.json({
      url: normalizedPlaylistUrl,
      text,
      suggestedName: safeFileName(new URL(normalizedPlaylistUrl).hostname || "remote-playlist")
    });
  } catch (error) {
    return res.status(502).json({
      error: error instanceof Error ? error.message : "Unable to load remote playlist."
    });
  }
});

app.get("/api/player/cache/playlists", async (req, res) => {
  const sessionId = getSessionId(req);
  const databasePlaylists = await loadPlaylistsFromDatabase(sessionId).catch(() => null);

  res.json({
    playlists: databasePlaylists || listCachedPlaylists()
  });
});

app.post("/api/player/cache/playlist", async (req, res) => {
  const playlist = req.body?.playlist;
  const sessionId = getSessionId(req);

  if (!playlist || typeof playlist !== "object" || !playlist.id) {
    return res.status(400).json({ error: "Playlist payload is required." });
  }

  const payload = {
    ...playlist,
    updatedAt: new Date().toISOString()
  };

  writeJsonFile(getPlaylistCachePath(payload.id), payload);
  await savePlaylistToDatabase(sessionId, payload).catch(() => null);
  return res.json({ ok: true, id: payload.id });
});

app.delete("/api/player/cache/playlist/:id", async (req, res) => {
  const sessionId = getSessionId(req);
  const targetPath = getPlaylistCachePath(req.params.id);

  if (fs.existsSync(targetPath)) {
    fs.unlinkSync(targetPath);
  }

  await deletePlaylistFromDatabase(sessionId, req.params.id).catch(() => null);
  return res.json({ ok: true });
});

app.get("/api/player/cache/history", async (req, res) => {
  const sessionId = getSessionId(req);
  const databaseHistory = await loadHistoryFromDatabase(sessionId).catch(() => null);

  res.json({
    history: databaseHistory || readRecentHistory()
  });
});

app.post("/api/player/cache/history", async (req, res) => {
  const entry = req.body?.entry;
  const sessionId = getSessionId(req);

  if (!entry || typeof entry !== "object") {
    return res.status(400).json({ error: "History entry is required." });
  }

  const current = readRecentHistory().filter(
    (item) => item?.channelId !== entry.channelId || item?.playlistId !== entry.playlistId
  );

  current.unshift({
    ...entry,
    playedAt: new Date().toISOString()
  });
  writeRecentHistory(current);
  await saveHistoryEntryToDatabase(sessionId, current[0]).catch(() => null);

  return res.json({ ok: true });
});

app.get("/api/player/cache/favorites", async (req, res) => {
  const sessionId = getSessionId(req);
  const favorites = await loadFavoritesFromDatabase(sessionId).catch(() => null);

  return res.json({
    favorites: favorites || []
  });
});

app.post("/api/player/cache/favorites", async (req, res) => {
  const favorites = Array.isArray(req.body?.favorites) ? req.body.favorites : null;

  if (!favorites) {
    return res.status(400).json({ error: "Favorites array is required." });
  }

  const sessionId = getSessionId(req);
  await saveFavoritesToDatabase(sessionId, favorites).catch(() => null);
  return res.json({ ok: true });
});

app.post("/api/checker/scan-history", async (req, res) => {
  const sessionId = getSessionId(req);
  await recordScanHistory(sessionId, req.body || {}).catch(() => null);
  return res.json({ ok: true });
});

app.post("/api/checker/export", async (req, res) => {
  const sessionId = getSessionId(req);
  await recordExportedFile(sessionId, req.body || {}).catch(() => null);
  return res.json({ ok: true });
});

app.get("/api/player/cache/logo", async (req, res) => {
  const sourceUrl = typeof req.query?.url === "string" ? req.query.url : "";

  try {
    const parsed = new URL(sourceUrl);
    const key = hashString(parsed.toString());
    const cachedPath = fs
      .readdirSync(logoCacheDir)
      .find((fileName) => fileName.startsWith(key));

    if (cachedPath) {
      return res.sendFile(path.join(logoCacheDir, cachedPath));
    }

    const response = await fetch(parsed.toString(), {
      headers: {
        Accept: "image/*,*/*",
        "User-Agent": "M3U Active Checker/1.0"
      },
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      return res.status(response.status).send("Logo fetch failed.");
    }

    const contentType = response.headers.get("content-type") || "image/jpeg";
    const extension =
      contentType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") ||
      path.extname(parsed.pathname).replace(".", "") ||
      "img";
    const filePath = path.join(logoCacheDir, `${key}.${extension}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(filePath, buffer);
    res.setHeader("Content-Type", contentType);
    return res.send(buffer);
  } catch (error) {
    return res.status(502).send(error instanceof Error ? error.message : "Logo cache failed.");
  }
});

function rewriteHlsPlaylistToProxy(text, targetUrl, req) {
  let rewrites = 0;
  const body = text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_match, uri) => {
          const absolute = new URL(uri, targetUrl).toString();
          const rewritten = buildProxyPath(req, absolute);
          rewrites += 1;
          logProxy("rewrite", { original: absolute, rewritten });
          return `URI="${rewritten}"`;
        });
      }

      const absolute = new URL(trimmed, targetUrl).toString();
      const rewritten = buildProxyPath(req, absolute);
      rewrites += 1;
      logProxy("rewrite", { original: absolute, rewritten });
      return rewritten;
    })
    .join("\n");

  logProxy("rewrite-summary", { url: targetUrl, rewrites });
  return { body, rewrites };
}

function copyResponseHeaders(response, res) {
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const contentLength = response.headers.get("content-length");
  const contentRange = response.headers.get("content-range");
  const acceptRanges = response.headers.get("accept-ranges");

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
  res.setHeader("Accept-Ranges", acceptRanges || "bytes");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", contentType);

  if (contentLength) res.setHeader("Content-Length", contentLength);
  if (contentRange) res.setHeader("Content-Range", contentRange);
}

function buildUpstreamAcceptHeader(targetUrl) {
  if (isHlsPlaylistUrl(targetUrl)) {
    return "application/vnd.apple.mpegurl,application/x-mpegurl,audio/x-mpegurl,*/*";
  }

  if (isDashManifestUrl(targetUrl)) {
    return "application/dash+xml,*/*";
  }

  return "*/*";
}

function buildUpstreamHeaders(req, targetUrl, extra = {}) {
  let targetOrigin = "";

  try {
    targetOrigin = new URL(targetUrl).origin;
  } catch {
    targetOrigin = "";
  }

  const headers = {
    ...IPTV_REQUEST_HEADERS,
    Accept: buildUpstreamAcceptHeader(targetUrl),
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Keep-Alive": "timeout=30, max=1000",
    Referer: targetOrigin || undefined,
    Origin: targetOrigin || undefined,
    ...extra
  };

  if (req.headers.range) {
    headers.Range = req.headers.range;
  }

  const incomingUserAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "";
  if (incomingUserAgent && !/playwright|headless|chrome\/\d+/i.test(incomingUserAgent)) {
    headers["User-Agent"] = incomingUserAgent;
  }

  return headers;
}

async function fetchUpstream(targetUrl, { req, proxyUrl = null, timeoutMs = 25000, range = null } = {}) {
  const headers = buildUpstreamHeaders(req, targetUrl, range ? { Range: range } : {});
  const dispatcher = getProxyAgent(proxyUrl);
  const controller = timeoutMs ? new AbortController() : null;
  const timeout = controller
    ? setTimeout(() => {
        controller.abort();
      }, timeoutMs)
    : null;

  try {
    const response = await fetch(targetUrl, {
      headers,
      redirect: "follow",
      dispatcher,
      signal: controller?.signal
    });

    if (timeout) {
      clearTimeout(timeout);
    }

    return response;
  } catch (error) {
    if (timeout) {
      clearTimeout(timeout);
    }
    throw error;
  }
}

async function readResponseProbe(response, maxBytes = 2048, { cancel = true } = {}) {
  const reader = response.body?.getReader();
  if (!reader) return "";

  try {
    const chunk = await Promise.race([
      reader.read(),
      new Promise((resolve) => {
        setTimeout(() => resolve(null), 5000);
      })
    ]);

    if (!chunk) {
      if (cancel) {
        await reader.cancel();
      } else {
        reader.releaseLock();
      }
      return "";
    }

    if (cancel) {
      await reader.cancel();
    } else {
      reader.releaseLock();
    }
    return chunk?.value ? new TextDecoder().decode(chunk.value.slice(0, maxBytes)) : "";
  } catch {
    return "";
  }
}

async function validateExternalProxy({ req, targetUrl, choice }) {
  const started = Date.now();

  if (!choice.proxyUrl) {
    return false;
  }

  try {
    const response = await fetchUpstream(targetUrl, {
      req,
      proxyUrl: choice.proxyUrl,
      timeoutMs: 9000,
      range: "bytes=0-2047"
    });
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const probeText = response.body ? await readResponseProbe(response) : "";
    const ok =
      (response.ok || response.status === 206) &&
      isAllowedStreamContentType(contentType, targetUrl) &&
      !looksLikeHtmlError(probeText);

    logProxy("validate", {
      url: targetUrl,
      selectedProxy: choice.proxyUrl,
      pool: choice.poolName,
      status: response.status,
      contentType,
      latencyMs: Date.now() - started,
      ok
    });

    if (ok) {
      markProxySuccess({ poolName: choice.poolName, proxyUrl: choice.proxyUrl, latencyMs: Date.now() - started });
      return true;
    }

    markProxyFailure({ poolName: choice.poolName, proxyUrl: choice.proxyUrl });
    return false;
  } catch (error) {
    logProxy("validate-error", {
      url: targetUrl,
      selectedProxy: choice.proxyUrl,
      pool: choice.poolName,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : "proxy validation failed"
    });
    markProxyFailure({ poolName: choice.poolName, proxyUrl: choice.proxyUrl });
    return false;
  }
}

function buildFailoverPlan(req) {
  const retry = Number(req.query?.retry || 0);
  if (!Number.isFinite(retry) || retry <= 0) {
    return PROXY_FAILOVER_PLAN;
  }

  return [Math.min(3, Math.floor(retry)), 1, 2, 3, 3, 0];
}

async function fetchBestUpstream(req, targetUrl) {
  const plan = buildFailoverPlan(req);
  const targetQueue = buildProxyTargetCandidates(targetUrl);
  let lastError = null;

  for (const candidateTarget of targetQueue) {
    for (const failoverIndex of plan) {
      const choice = await selectProxyForRequest({ failoverIndex });

      if (choice.poolName !== "direct" && !choice.proxyUrl) {
        logProxy("skip-empty-pool", { url: targetUrl, candidateUrl: candidateTarget, pool: choice.poolName });
        continue;
      }

      if (choice.proxyUrl) {
        const valid = await validateExternalProxy({ req, targetUrl: candidateTarget, choice });
        if (!valid) {
          continue;
        }
      }

      const started = Date.now();

      try {
        logProxy("request", {
          originalUrl: targetUrl,
          candidateUrl: candidateTarget,
          selectedProxy: choice.proxyUrl || "local-relay",
          pool: choice.poolName
        });

        const response = await fetchUpstream(candidateTarget, {
          req,
          proxyUrl: choice.proxyUrl,
          timeoutMs: 30000
        });
        const contentType = response.headers.get("content-type") || "application/octet-stream";

        logProxy("response", {
          originalUrl: targetUrl,
          candidateUrl: candidateTarget,
          selectedProxy: choice.proxyUrl || "local-relay",
          pool: choice.poolName,
          status: response.status,
          contentType,
          latencyMs: Date.now() - started
        });

        if ([401, 403, 451, 429].includes(response.status)) {
          if (choice.proxyUrl) {
            markProxyFailure({ poolName: choice.poolName, proxyUrl: choice.proxyUrl });
          }
          lastError = new Error(`Upstream blocked request with ${response.status}`);
          continue;
        }

        if (!response.ok && response.status !== 206) {
          if (choice.proxyUrl) {
            markProxyFailure({ poolName: choice.poolName, proxyUrl: choice.proxyUrl });
          }
          lastError = new Error(`Upstream returned ${response.status}`);
          continue;
        }

        if (!isAllowedStreamContentType(contentType, candidateTarget)) {
          if (choice.proxyUrl) {
            markProxyFailure({ poolName: choice.poolName, proxyUrl: choice.proxyUrl });
          }
          lastError = new Error(`Rejected invalid stream content-type: ${contentType}`);
          lastError.statusCode = 415;

          if (isRejectedTextContent(contentType)) {
            break;
          }

          continue;
        }

        if (choice.proxyUrl) {
          markProxySuccess({ poolName: choice.poolName, proxyUrl: choice.proxyUrl, latencyMs: Date.now() - started });
        }

        return { response, choice, contentType, resolvedUrl: candidateTarget };
      } catch (error) {
        lastError = error;
        logProxy("request-error", {
          originalUrl: targetUrl,
          candidateUrl: candidateTarget,
          selectedProxy: choice.proxyUrl || "local-relay",
          pool: choice.poolName,
          error: error instanceof Error ? error.message : "upstream request failed"
        });

        if (choice.proxyUrl) {
          markProxyFailure({ poolName: choice.poolName, proxyUrl: choice.proxyUrl });
        }
      }
    }
  }

  throw lastError || new Error("No working relay/proxy candidate could fetch the stream.");
}

function sendProxyFailure(res, status, message, details = {}) {
  if (res.headersSent) return;
  res.status(status);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  return res.send(JSON.stringify({ error: message, ...details }));
}

async function proxyStreamToResponse(req, res, targetUrl) {
  const normalizedTarget = unwrapProxyTarget(targetUrl);

  if (!isHttpUrl(normalizedTarget)) {
    return sendProxyFailure(res, 400, "Unsupported stream URL.");
  }

  let upstream;
  try {
    upstream = await fetchBestUpstream(req, normalizedTarget);
  } catch (error) {
    return sendProxyFailure(res, error?.statusCode || 502, error instanceof Error ? error.message : "Stream proxy failed.");
  }

  const { response, choice, contentType, resolvedUrl } = upstream;
  const playbackUrl = resolvedUrl || normalizedTarget;

  if (isRejectedTextContent(contentType)) {
    return sendProxyFailure(res, 415, "Rejected HTML/text response instead of stream.", {
      contentType,
      status: response.status,
      resolvedUrl: playbackUrl
    });
  }

  if (isHlsPlaylistUrl(playbackUrl) || /mpegurl/i.test(contentType)) {
    const text = await response.text();

    if (looksLikeHtmlError(text) || !/#EXTM3U/i.test(text.slice(0, 1024))) {
      return sendProxyFailure(res, 415, "Rejected invalid HLS manifest.", {
        contentType,
        status: response.status,
        resolvedUrl: playbackUrl
      });
    }

    const { body, rewrites } = rewriteHlsPlaylistToProxy(text, playbackUrl, req);
    res.status(response.status);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    logProxy("playlist", {
      originalUrl: normalizedTarget,
      resolvedUrl: playbackUrl,
      selectedProxy: choice.proxyUrl || "local-relay",
      contentType,
      status: response.status,
      rewrites
    });
    return res.send(body);
  }

  if (!response.body) {
    res.status(response.status);
    copyResponseHeaders(response, res);
    return res.end();
  }

  const [probeBody, streamBody] = response.body.tee();
  const probeText = await readResponseProbe({ body: probeBody }, 2048, { cancel: false });

  if (looksLikeHtmlError(probeText)) {
    return sendProxyFailure(res, 415, "Rejected HTML/block page instead of media bytes.", {
      contentType,
      status: response.status
    });
  }

  res.status(response.status);
  copyResponseHeaders(response, res);

  const nodeStream = Readable.fromWeb(streamBody);

  nodeStream.on("error", (err) => {
    try {
      if (!res.headersSent) {
        sendProxyFailure(res, 504, err instanceof Error ? err.message : "stream error");
      } else {
        res.destroy(err);
      }
    } catch {
      // ignore shutdown races
    }
  });

  res.on("close", () => {
    try {
      nodeStream.destroy();
    } catch {
      // ignore shutdown races
    }
  });

  return nodeStream.pipe(res);
}


// NEW endpoint (primary relay for browser): /proxy?url=...
app.get("/proxy/probe", async (req, res) => {
  const targetUrl = typeof req.query?.url === "string" ? req.query.url : "";
  const normalizedTarget = unwrapProxyTarget(targetUrl);

  if (!normalizedTarget || !isHttpUrl(normalizedTarget)) {
    return res.status(400).json({ ok: false, error: "url is required" });
  }

  try {
    const { response, choice, contentType, resolvedUrl } = await fetchBestUpstream(req, normalizedTarget);
    const probeText = response.body ? await readResponseProbe(response) : "";
    const blockedBody = looksLikeHtmlError(probeText);
    const ok = !blockedBody && isAllowedStreamContentType(contentType, normalizedTarget);

    return res.status(ok ? 200 : 415).json({
      ok,
      url: normalizedTarget,
      resolvedUrl: resolvedUrl || normalizedTarget,
      status: response.status,
      contentType,
      selectedProxy: choice.proxyUrl || "local-relay",
      pool: choice.poolName,
      message: ok ? "Playable stream response detected." : "Rejected invalid stream response."
    });
  } catch (error) {
    return res.status(error?.statusCode || 502).json({
      ok: false,
      url: normalizedTarget,
      error: error instanceof Error ? error.message : "Stream probe failed."
    });
  }
});

app.get("/proxy", async (req, res) => {
  const targetUrl = typeof req.query?.url === "string" ? req.query.url : "";
  if (!targetUrl) {
    return res.status(400).json({ error: "url is required" });
  }

  try {
    return await proxyStreamToResponse(req, res, targetUrl);
  } catch (error) {
    return res.status(502).send(error instanceof Error ? error.message : "Stream proxy failed.");
  }
});

app.get("/stream", async (req, res) => {
  const targetUrl = typeof req.query?.url === "string" ? req.query.url : "";
  if (!targetUrl) {
    return res.status(400).json({ error: "url is required" });
  }

  try {
    return await proxyStreamToResponse(req, res, targetUrl);
  } catch (error) {
    return res.status(502).send(error instanceof Error ? error.message : "Stream proxy failed.");
  }
});

app.get("/m3u", async (req, res) => {
  const targetUrl = typeof req.query?.url === "string" ? req.query.url : "";
  const normalizedTarget = unwrapProxyTarget(targetUrl);

  if (!normalizedTarget || !isHttpUrl(normalizedTarget)) {
    return res.status(400).json({ error: "url is required" });
  }

  try {
    const text = await fetchText(
      normalizedTarget,
      25_000,
      "audio/x-mpegurl,application/vnd.apple.mpegurl,text/plain,*/*"
    );
    return res.type("application/vnd.apple.mpegurl").send(text);
  } catch (error) {
    return res.status(502).json({
      error: error instanceof Error ? error.message : "Playlist fetch failed."
    });
  }
});

app.get("/api/player/stream", async (req, res) => {
  const targetUrl = typeof req.query?.url === "string" ? req.query.url : "";
  if (!targetUrl) {
    return res.status(400).send('url is required');
  }

  try {
    // Legacy endpoint -> NEW proxy relay
    // Keep compatibility while migrating playback to /proxy.
    return res.redirect(307, buildProxyPath(req, targetUrl));
  } catch (error) {
    return res.status(502).send(error instanceof Error ? error.message : "Stream proxy failed.");
  }
});



app.get("/api/hls-proxy", async (req, res) => {
  const targetUrl = typeof req.query?.url === "string" ? req.query.url : "";

  try {
    return res.redirect(307, buildProxyPath(req, targetUrl));
  } catch (error) {
    return res.status(502).send(error instanceof Error ? error.message : "Stream proxy failed.");
  }
});

if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));

  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) {
      return next();
    }

    return res.sendFile(path.join(distPath, "index.html"));
  });
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isDirectRun) {
  app.listen(port, () => {
    console.log(`M3U Active Checker server listening on http://localhost:${port}`);
  });
}

export default app;
