export type PlaylistSourceType = "file" | "url" | "manual" | "checker";
export type PlayerSidebarView = "all" | "favorites" | "recent";

export interface PlaylistChannel {
  id: string;
  playlistId: string;
  name: string;
  url: string;
  logo: string | null;
  group: string;
  tvgId: string | null;
  extinf: string | null;
  importedAt: string;
}

export interface CachedPlaylist {
  id: string;
  name: string;
  sourceType: PlaylistSourceType;
  sourceValue: string;
  importedAt: string;
  updatedAt: string;
  channelCount: number;
  groups: string[];
  channels: PlaylistChannel[];
}

export interface RecentChannel {
  playlistId: string;
  channelId: string;
  name: string;
  url: string;
  logo: string | null;
  group: string;
  playedAt: string;
}

export interface PlayerSettings {
  volume: number;
  muted: boolean;
  lastPlaylistId: string | null;
  lastChannelId: string | null;
  lastSidebarView: PlayerSidebarView;
}

export interface PlaylistParseRequest {
  name: string;
  rawText: string;
  sourceType: PlaylistSourceType;
  sourceValue: string;
}

export interface PlaylistParseResult {
  playlist: CachedPlaylist;
  stats: {
    totalLines: number;
    parsedChannels: number;
    groups: number;
  };
}

export interface MiniPlayerSession {
  title: string;
  sourceUrl: string;
  externalUrl?: string;
  playlistUrl?: string | null;
}
