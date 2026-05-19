import crypto from "node:crypto";
import { query } from "./db.js";

function normalizeSessionId(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw ? raw.slice(0, 120) : "anonymous";
}

export function getSessionId(req) {
  const headerValue =
    typeof req.headers["x-session-id"] === "string" ? req.headers["x-session-id"] : "";
  return normalizeSessionId(headerValue);
}

export async function loadPlaylistsFromDatabase(sessionId) {
  const result = await query(
    `
      select id, name, source_type, source_value, imported_at, updated_at, channel_count, groups, channels
      from playlists
      where session_id = $1
      order by updated_at desc
    `,
    [sessionId]
  );

  if (!result) {
    return null;
  }

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    sourceType: row.source_type,
    sourceValue: row.source_value,
    importedAt: new Date(row.imported_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    channelCount: row.channel_count,
    groups: Array.isArray(row.groups) ? row.groups : [],
    channels: Array.isArray(row.channels) ? row.channels : []
  }));
}

export async function savePlaylistToDatabase(sessionId, playlist) {
  return query(
    `
      insert into playlists (
        id, session_id, name, source_type, source_value, imported_at, updated_at, channel_count, groups, channels
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
      on conflict (id) do update
      set
        session_id = excluded.session_id,
        name = excluded.name,
        source_type = excluded.source_type,
        source_value = excluded.source_value,
        imported_at = excluded.imported_at,
        updated_at = excluded.updated_at,
        channel_count = excluded.channel_count,
        groups = excluded.groups,
        channels = excluded.channels
    `,
    [
      playlist.id,
      sessionId,
      playlist.name,
      playlist.sourceType,
      playlist.sourceValue,
      playlist.importedAt,
      playlist.updatedAt,
      playlist.channelCount,
      JSON.stringify(playlist.groups || []),
      JSON.stringify(playlist.channels || [])
    ]
  );
}

export async function deletePlaylistFromDatabase(sessionId, playlistId) {
  return query("delete from playlists where session_id = $1 and id = $2", [sessionId, playlistId]);
}

export async function loadHistoryFromDatabase(sessionId) {
  const result = await query(
    `
      select playlist_id, channel_id, name, url, logo, category, played_at
      from recent_views
      where session_id = $1
      order by played_at desc
      limit 60
    `,
    [sessionId]
  );

  if (!result) {
    return null;
  }

  const seen = new Set();
  const history = [];

  for (const row of result.rows) {
    const key = `${row.playlist_id}:${row.channel_id}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    history.push({
      playlistId: row.playlist_id,
      channelId: row.channel_id,
      name: row.name,
      url: row.url,
      logo: row.logo,
      group: row.category,
      playedAt: new Date(row.played_at).toISOString()
    });
  }

  return history;
}

export async function saveHistoryEntryToDatabase(sessionId, entry) {
  return query(
    `
      insert into recent_views (session_id, playlist_id, channel_id, name, url, logo, category, played_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      sessionId,
      entry.playlistId,
      entry.channelId,
      entry.name,
      entry.url,
      entry.logo,
      entry.group,
      entry.playedAt
    ]
  );
}

export async function loadFavoritesFromDatabase(sessionId) {
  const result = await query(
    `
      select playlist_id, channel_id
      from favorites
      where session_id = $1
      order by created_at desc
    `,
    [sessionId]
  );

  if (!result) {
    return null;
  }

  return result.rows.map((row) => `${row.playlist_id}:${row.channel_id}`);
}

export async function saveFavoritesToDatabase(sessionId, favorites) {
  const keys = Array.isArray(favorites) ? favorites : [];

  const clientResult = await query("delete from favorites where session_id = $1", [sessionId]);
  if (clientResult === null || keys.length === 0) {
    return clientResult;
  }

  for (const key of keys) {
    const [playlistId, channelId] = String(key).split(":");
    if (!playlistId || !channelId) {
      continue;
    }

    await query(
      `
        insert into favorites (session_id, playlist_id, channel_id)
        values ($1, $2, $3)
        on conflict (session_id, playlist_id, channel_id) do nothing
      `,
      [sessionId, playlistId, channelId]
    );
  }

  return true;
}

export async function recordScanHistory(sessionId, payload) {
  return query(
    `
      insert into scan_history (id, session_id, input_count, active_count, dead_count, payload)
      values ($1, $2, $3, $4, $5, $6::jsonb)
    `,
    [
      crypto.randomUUID(),
      sessionId,
      Number(payload?.inputCount || 0),
      Number(payload?.activeCount || 0),
      Number(payload?.deadCount || 0),
      JSON.stringify(payload || {})
    ]
  );
}

export async function recordCheckerReport(sessionId, payload) {
  return query(
    `
      insert into checker_reports (id, session_id, source_name, total_count, active_count, dead_count, payload)
      values ($1, $2, $3, $4, $5, $6, $7::jsonb)
    `,
    [
      crypto.randomUUID(),
      sessionId,
      payload?.sourceName || "CHECKER IPTV",
      Number(payload?.totalCount || 0),
      Number(payload?.activeCount || 0),
      Number(payload?.deadCount || 0),
      JSON.stringify(payload || {})
    ]
  );
}

export async function recordExportedFile(sessionId, payload) {
  return query(
    `
      insert into exported_files (id, session_id, format, active_count, payload)
      values ($1, $2, $3, $4, $5::jsonb)
    `,
    [
      crypto.randomUUID(),
      sessionId,
      payload?.format || "txt",
      Number(payload?.activeCount || 0),
      JSON.stringify(payload || {})
    ]
  );
}

export async function upsertStreamDiagnostics(payload) {
  const streamUrl = typeof payload?.streamUrl === "string" ? payload.streamUrl.trim() : "";

  if (!streamUrl) {
    return null;
  }

  return query(
    `
      insert into streams (
        stream_url, stream_name, source_kind, last_status, last_http_code, last_content_type, last_response_ms, last_seen_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, now())
      on conflict (stream_url) do update
      set
        stream_name = excluded.stream_name,
        source_kind = excluded.source_kind,
        last_status = excluded.last_status,
        last_http_code = excluded.last_http_code,
        last_content_type = excluded.last_content_type,
        last_response_ms = excluded.last_response_ms,
        last_seen_at = now()
    `,
    [
      streamUrl,
      payload?.streamName || null,
      payload?.sourceKind || null,
      payload?.status || null,
      payload?.httpCode || null,
      payload?.contentType || null,
      payload?.responseMs || null
    ]
  );
}
