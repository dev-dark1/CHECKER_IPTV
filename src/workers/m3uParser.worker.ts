import type { CachedPlaylist, PlaylistChannel, PlaylistParseRequest, PlaylistParseResult } from "../player/types";

interface WorkerMessage {
  id: string;
  payload: PlaylistParseRequest;
}

function sanitizeLabel(value: string) {
  return value.replace(/[^\x20-\x7E\u0600-\u06FF]/g, "").trim();
}

function parseExtinfAttributes(line: string) {
  const attributes: Record<string, string> = {};
  const attributeRegex = /([a-z0-9-]+)="([^"]*)"/gi;
  let match = attributeRegex.exec(line);

  while (match) {
    attributes[match[1].toLowerCase()] = match[2];
    match = attributeRegex.exec(line);
  }

  return attributes;
}

function buildPlaylistId(name: string, sourceValue: string) {
  const basis = `${name}-${sourceValue}-${Date.now()}`;
  return basis
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function isPlaylistAccountUrl(value: string) {
  try {
    const parsed = new URL(value);
    const type = (parsed.searchParams.get("type") || "").toLowerCase();

    return /\/get\.php$/i.test(parsed.pathname) && type.includes("m3u");
  } catch {
    return false;
  }
}

function parseChannels(playlistId: string, rawText: string) {
  const channels: PlaylistChannel[] = [];
  const groups = new Set<string>();
  const lines = rawText.split(/\r?\n/);
  let pendingMeta: {
    name: string;
    logo: string | null;
    group: string;
    tvgId: string | null;
    extinf: string | null;
  } | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("#EXTINF")) {
      const attributes = parseExtinfAttributes(line);
      const channelName = sanitizeLabel(line.split(",").slice(1).join(",") || "Channel");
      pendingMeta = {
        name: channelName || "Channel",
        logo: attributes["tvg-logo"] || null,
        group: sanitizeLabel(attributes["group-title"] || "Ungrouped") || "Ungrouped",
        tvgId: attributes["tvg-id"] || null,
        extinf: line
      };
      groups.add(pendingMeta.group);
      continue;
    }

    if (line.startsWith("#")) {
      continue;
    }

    if (!/^https?:\/\//i.test(line)) {
      continue;
    }

    if (isPlaylistAccountUrl(line)) {
      pendingMeta = null;
      continue;
    }

    const meta = pendingMeta || {
      name: sanitizeLabel(line.split("/").pop() || "Stream") || "Stream",
      logo: null,
      group: "Direct Streams",
      tvgId: null,
      extinf: null
    };

    groups.add(meta.group);
    channels.push({
      id: `${playlistId}-${channels.length + 1}`,
      playlistId,
      name: meta.name,
      url: line,
      logo: meta.logo,
      group: meta.group,
      tvgId: meta.tvgId,
      extinf: meta.extinf,
      importedAt: new Date().toISOString()
    });
    pendingMeta = null;
  }

  return {
    channels,
    groups: Array.from(groups).sort((a, b) => a.localeCompare(b))
  };
}

function parsePlaylist(payload: PlaylistParseRequest): PlaylistParseResult {
  const playlistId = buildPlaylistId(payload.name, payload.sourceValue);
  const { channels, groups } = parseChannels(playlistId, payload.rawText);

  const playlist: CachedPlaylist = {
    id: playlistId,
    name: sanitizeLabel(payload.name) || "Imported Playlist",
    sourceType: payload.sourceType,
    sourceValue: payload.sourceValue,
    importedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    channelCount: channels.length,
    groups,
    channels
  };

  return {
    playlist,
    stats: {
      totalLines: payload.rawText.split(/\r?\n/).length,
      parsedChannels: channels.length,
      groups: groups.length
    }
  };
}

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const result = parsePlaylist(event.data.payload);
  self.postMessage({
    id: event.data.id,
    result
  });
};
