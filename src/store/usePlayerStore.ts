import { create } from "zustand";
import { deletePlaylistFromServerCache, fetchRemotePlaylistText, fetchServerCachedPlaylists, fetchServerHistory, getPlayableStreamUrl, saveHistoryToServer, savePlaylistToServerCache } from "../lib/playerApi";
import { getAllPlaylistsFromDb, getFavoritesFromDb, getPlayerSettingsFromDb, getRecentChannelsFromDb, saveFavoritesToDb, savePlayerSettingsToDb, savePlaylistToDb, saveRecentChannelsToDb, deletePlaylistFromDb } from "../lib/playerPersistence";
import { parsePlaylistInWorker } from "../lib/parsePlaylistInWorker";
import { buildBrowserPlayableUrl } from "../lib/playerUrl";
import type { CachedPlaylist, MiniPlayerSession, PlayerSettings, PlaylistChannel, PlayerSidebarView, PlaylistSourceType, RecentChannel } from "../player/types";

function completeM3uUrl(value: string) {
  const trimmed = value.trim();

  try {
    const parsed = new URL(trimmed);

    if (/\/get\.php$/i.test(parsed.pathname)) {
      if (!parsed.searchParams.get("type")) {
        parsed.searchParams.set("type", "m3u_plus");
      }

      if (!parsed.searchParams.get("output")) {
        parsed.searchParams.set("output", "ts");
      }

      return parsed.toString();
    }
  } catch {
    return trimmed;
  }

  return trimmed;
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

function sanitizePlaylist(playlist: CachedPlaylist): CachedPlaylist {
  const channels = playlist.channels.filter((channel) => !isPlaylistAccountUrl(channel.url));
  const groups = Array.from(new Set(channels.map((channel) => channel.group))).sort((a, b) => a.localeCompare(b));

  if (channels.length === playlist.channels.length && groups.length === playlist.groups.length) {
    return playlist;
  }

  return {
    ...playlist,
    channels,
    groups,
    channelCount: channels.length
  };
}

interface ImportPayload {
  name: string;
  rawText: string;
  sourceType: PlaylistSourceType;
  sourceValue: string;
}

interface PlayerStoreState {
  ready: boolean;
  loading: boolean;
  importing: boolean;
  playlists: CachedPlaylist[];
  activePlaylistId: string | null;
  activeChannelId: string | null;
  favorites: string[];
  recentChannels: RecentChannel[];
  sidebarView: PlayerSidebarView;
  searchQuery: string;
  selectedGroup: string;
  settings: PlayerSettings;
  miniPlayer: MiniPlayerSession | null;
  bootstrap: () => Promise<void>;
  importFromText: (payload: ImportPayload) => Promise<CachedPlaylist | null>;
  importFromUrl: (url: string) => Promise<CachedPlaylist | null>;
  importDirectStream: (url: string) => Promise<CachedPlaylist | null>;
  removePlaylist: (id: string) => Promise<void>;
  setActivePlaylist: (id: string | null) => void;
  setActiveChannel: (channelId: string | null) => void;
  selectChannel: (channel: PlaylistChannel) => Promise<void>;
  toggleFavorite: (channel: PlaylistChannel) => Promise<void>;
  setSidebarView: (view: PlayerSidebarView) => Promise<void>;
  setSearchQuery: (value: string) => void;
  setSelectedGroup: (value: string) => void;
  setSettings: (patch: Partial<PlayerSettings>) => Promise<void>;
  openMiniPlayer: (session: MiniPlayerSession) => void;
  closeMiniPlayer: () => void;
}

export const usePlayerStore = create<PlayerStoreState>((set, get) => ({
  ready: false,
  loading: false,
  importing: false,
  playlists: [],
  activePlaylistId: null,
  activeChannelId: null,
  favorites: [],
  recentChannels: [],
  sidebarView: "all",
  searchQuery: "",
  selectedGroup: "All",
  settings: {
    volume: 0.8,
    muted: false,
    lastPlaylistId: null,
    lastChannelId: null,
    lastSidebarView: "all"
  },
  miniPlayer: null,
  bootstrap: async () => {
    if (get().ready || get().loading) {
      return;
    }

    set({ loading: true });

    try {
      const [localPlaylists, serverPlaylists, favorites, settings, dbHistory, serverHistory] =
        await Promise.all([
          getAllPlaylistsFromDb(),
          fetchServerCachedPlaylists(),
          getFavoritesFromDb(),
          getPlayerSettingsFromDb(),
          getRecentChannelsFromDb(),
          fetchServerHistory()
        ]);

      const mergedPlaylists = new Map<string, CachedPlaylist>();
      for (const playlist of [...serverPlaylists, ...localPlaylists].map(sanitizePlaylist)) {
        if (playlist.channels.length === 0) {
          continue;
        }

        const existing = mergedPlaylists.get(playlist.id);
        if (!existing || String(playlist.updatedAt) > String(existing.updatedAt)) {
          mergedPlaylists.set(playlist.id, playlist);
        }
      }

      const history = [...serverHistory, ...dbHistory]
        .filter((entry) => !isPlaylistAccountUrl(entry.url))
        .sort((a, b) => String(b.playedAt).localeCompare(String(a.playedAt)))
        .filter((entry, index, array) => array.findIndex((item) => item.channelId === entry.channelId && item.playlistId === entry.playlistId) === index)
        .slice(0, 40);
      const playlists = Array.from(mergedPlaylists.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const activePlaylist =
        playlists.find((playlist) => playlist.id === settings.lastPlaylistId) ||
        playlists[0] ||
        null;
      const activeChannel =
        activePlaylist?.channels.find((channel) => channel.id === settings.lastChannelId) ||
        activePlaylist?.channels[0] ||
        null;

      set({
        ready: true,
        loading: false,
        playlists,
        favorites,
        recentChannels: history,
        activePlaylistId: activePlaylist?.id || null,
        activeChannelId: activeChannel?.id || null,
        sidebarView: settings.lastSidebarView,
        settings
      });

      if (activePlaylist?.id !== settings.lastPlaylistId || activeChannel?.id !== settings.lastChannelId) {
        await get().setSettings({
          lastPlaylistId: activePlaylist?.id || null,
          lastChannelId: activeChannel?.id || null
        });
      }
    } catch {
      set({ ready: true, loading: false });
    }
  },
  importFromText: async ({ name, rawText, sourceType, sourceValue }) => {
    set({ importing: true });

    try {
      const parsed = await parsePlaylistInWorker({
        name,
        rawText,
        sourceType,
        sourceValue
      });

      const playlist = sanitizePlaylist(parsed.playlist);
      if (playlist.channels.length === 0) {
        set({ importing: false });
        return null;
      }
      await Promise.all([savePlaylistToDb(playlist), savePlaylistToServerCache(playlist)]);

      set((state) => ({
        importing: false,
        playlists: [playlist, ...state.playlists.filter((item) => item.id !== playlist.id)],
        activePlaylistId: playlist.id,
        activeChannelId: playlist.channels[0]?.id || null,
        selectedGroup: "All"
      }));

      await get().setSettings({
        lastPlaylistId: playlist.id,
        lastChannelId: playlist.channels[0]?.id || null
      });

      return playlist;
    } catch {
      set({ importing: false });
      return null;
    }
  },
  importFromUrl: async (url) => {
    const completedUrl = completeM3uUrl(url);
    const remote = await fetchRemotePlaylistText(completedUrl);
    return get().importFromText({
      name: remote.suggestedName || "Remote Playlist",
      rawText: remote.text,
      sourceType: "url",
      sourceValue: completedUrl
    });
  },
  importDirectStream: async (url) => {
    const completedUrl = completeM3uUrl(url);
    return get().importFromText({
      name: "Direct Stream",
      rawText: `#EXTM3U\n#EXTINF:-1 group-title="Direct Streams",Direct Stream\n${completedUrl}`,
      sourceType: "manual",
      sourceValue: completedUrl
    });
  },
  removePlaylist: async (id) => {
    await Promise.all([deletePlaylistFromDb(id), deletePlaylistFromServerCache(id)]);

    set((state) => {
      const nextPlaylists = state.playlists.filter((playlist) => playlist.id !== id);
      const nextActivePlaylistId =
        state.activePlaylistId === id ? nextPlaylists[0]?.id || null : state.activePlaylistId;
      const nextActiveChannelId =
        nextActivePlaylistId === state.activePlaylistId
          ? state.activeChannelId
          : nextPlaylists[0]?.channels[0]?.id || null;

      return {
        playlists: nextPlaylists,
        activePlaylistId: nextActivePlaylistId,
        activeChannelId: nextActiveChannelId
      };
    });
  },
  setActivePlaylist: (id) => {
    const playlist = get().playlists.find((item) => item.id === id);
    set({
      activePlaylistId: id,
      activeChannelId: playlist?.channels[0]?.id || null,
      selectedGroup: "All"
    });
    void get().setSettings({
      lastPlaylistId: id,
      lastChannelId: playlist?.channels[0]?.id || null
    });
  },
  setActiveChannel: (channelId) => {
    set({ activeChannelId: channelId });
  },
  selectChannel: async (channel) => {
    const recentEntry: RecentChannel = {
      playlistId: channel.playlistId,
      channelId: channel.id,
      name: channel.name,
      url: channel.url,
      logo: channel.logo,
      group: channel.group,
      playedAt: new Date().toISOString()
    };

    const nextHistory = [
      recentEntry,
      ...get().recentChannels.filter(
        (item) => item.channelId !== channel.id || item.playlistId !== channel.playlistId
      )
    ].slice(0, 40);

    set({
      activePlaylistId: channel.playlistId,
      activeChannelId: channel.id,
      recentChannels: nextHistory
    });

    await Promise.all([
      saveRecentChannelsToDb(nextHistory),
      saveHistoryToServer(recentEntry),
      get().setSettings({
        lastPlaylistId: channel.playlistId,
        lastChannelId: channel.id
      })
    ]);
  },
  toggleFavorite: async (channel) => {
    const key = `${channel.playlistId}:${channel.id}`;
    const next = get().favorites.includes(key)
      ? get().favorites.filter((value) => value !== key)
      : [key, ...get().favorites];
    set({ favorites: next });
    await saveFavoritesToDb(next);
  },
  setSidebarView: async (view) => {
    set({ sidebarView: view });
    await get().setSettings({ lastSidebarView: view });
  },
  setSearchQuery: (value) => {
    set({ searchQuery: value });
  },
  setSelectedGroup: (value) => {
    set({ selectedGroup: value });
  },
  setSettings: async (patch) => {
    const nextSettings = { ...get().settings, ...patch };
    set({ settings: nextSettings });
    await savePlayerSettingsToDb(nextSettings);
  },
  openMiniPlayer: (session) => {
    set({
      miniPlayer: {
        ...session,
        sourceUrl: getPlayableStreamUrl(buildBrowserPlayableUrl(session.sourceUrl)) || session.sourceUrl
      }
    });
  },
  closeMiniPlayer: () => {
    set({ miniPlayer: null });
  }
}));
