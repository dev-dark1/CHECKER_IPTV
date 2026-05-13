import type { CachedPlaylist, RecentChannel } from "../player/types";

export async function fetchRemotePlaylistText(url: string) {
  const response = await fetch("/api/player/fetch-url", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ url })
  });

  if (!response.ok) {
    throw new Error((await response.json()).error || "Unable to fetch remote playlist.");
  }

  return response.json() as Promise<{ url: string; text: string; suggestedName: string }>;
}

export async function savePlaylistToServerCache(playlist: CachedPlaylist) {
  await fetch("/api/player/cache/playlist", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ playlist })
  });
}

export async function fetchServerCachedPlaylists() {
  const response = await fetch("/api/player/cache/playlists");
  const payload = (await response.json()) as { playlists: CachedPlaylist[] };
  return payload.playlists || [];
}

export async function deletePlaylistFromServerCache(id: string) {
  await fetch(`/api/player/cache/playlist/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}

export async function saveHistoryToServer(entry: RecentChannel) {
  await fetch("/api/player/cache/history", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ entry })
  });
}

export async function fetchServerHistory() {
  const response = await fetch("/api/player/cache/history");
  const payload = (await response.json()) as { history: RecentChannel[] };
  return payload.history || [];
}

export function getCachedLogoUrl(sourceUrl: string | null) {
  return sourceUrl ? `/api/player/cache/logo?url=${encodeURIComponent(sourceUrl)}` : "";
}

export function getPlayableStreamUrl(sourceUrl: string | null) {
  const cleaned = sourceUrl?.trim();
  if (!cleaned) return "";

  try {
    const parsed = new URL(cleaned, window.location.origin);
    const nestedUrl = parsed.searchParams.get("url");

    if (
      nestedUrl &&
      (parsed.pathname === "/proxy" ||
        parsed.pathname === "/api/player/stream" ||
        parsed.pathname === "/api/hls-proxy")
    ) {
      return `/proxy?url=${encodeURIComponent(nestedUrl)}`;
    }
  } catch {
    // fall through to encode the raw provider URL once
  }

  return `/proxy?url=${encodeURIComponent(cleaned)}`;
}
