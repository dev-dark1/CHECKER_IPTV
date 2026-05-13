import Fuse from "fuse.js";
import {
  Download,
  ExternalLink,
  FileUp,
  Gauge,
  Heart,
  History,
  Import,
  ListVideo,
  Monitor,
  RefreshCcw,
  Search,
  SignalHigh,
  Wifi,
  Zap
} from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { IptvVideoPlayer, type IptvVideoPlayerHandle, type PlayerSnapshot } from "../components/player/IptvVideoPlayer";
import { VirtualChannelList } from "../components/player/VirtualChannelList";
import { buildMxUrl, buildVlcUrl, buildBrowserPlayableUrl } from "../lib/playerUrl";
import { usePlayerStore } from "../store/usePlayerStore";
import { getCachedLogoUrl, getPlayableStreamUrl } from "../lib/playerApi";
import type { Language } from "../types";
import type { PlaylistChannel } from "../player/types";

interface PlayerPageProps {
  lang: Language;
}

function completeUrl(value: string) {
  try {
    const parsed = new URL(value.trim());

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
    return value.trim();
  }

  return value.trim();
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

const initialSnapshot: PlayerSnapshot = {
  status: "idle",
  bitrateKbps: null,
  muted: false,
  volume: 0.8,
  engine: null,
  bufferSeconds: 0,
  droppedFrames: 0,
  decodedFrames: 0,
  fps: 0,
  resolution: "Unknown",
  liveLatency: 0,
  reconnectAttempts: 0,
  stallCount: 0,
  networkKbps: null,
  qualityLabel: "Auto"
};

export function PlayerPage({ lang }: PlayerPageProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const playerRef = useRef<IptvVideoPlayerHandle | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [urlInput, setUrlInput] = useState("");
  const [manualText, setManualText] = useState("");
  const [snapshot, setSnapshot] = useState<PlayerSnapshot>(initialSnapshot);

  const bootstrap = usePlayerStore((state) => state.bootstrap);
  const loading = usePlayerStore((state) => state.loading);
  const importing = usePlayerStore((state) => state.importing);
  const playlists = usePlayerStore((state) => state.playlists);
  const activePlaylistId = usePlayerStore((state) => state.activePlaylistId);
  const activeChannelId = usePlayerStore((state) => state.activeChannelId);
  const favorites = usePlayerStore((state) => state.favorites);
  const recentChannels = usePlayerStore((state) => state.recentChannels);
  const sidebarView = usePlayerStore((state) => state.sidebarView);
  const searchQuery = usePlayerStore((state) => state.searchQuery);
  const selectedGroup = usePlayerStore((state) => state.selectedGroup);
  const settings = usePlayerStore((state) => state.settings);
  const setSearchQuery = usePlayerStore((state) => state.setSearchQuery);
  const setSelectedGroup = usePlayerStore((state) => state.setSelectedGroup);
  const setSidebarView = usePlayerStore((state) => state.setSidebarView);
  const setSettings = usePlayerStore((state) => state.setSettings);
  const setActivePlaylist = usePlayerStore((state) => state.setActivePlaylist);
  const selectChannel = usePlayerStore((state) => state.selectChannel);
  const toggleFavorite = usePlayerStore((state) => state.toggleFavorite);
  const importFromText = usePlayerStore((state) => state.importFromText);
  const importFromUrl = usePlayerStore((state) => state.importFromUrl);
  const importDirectStream = usePlayerStore((state) => state.importDirectStream);
  const removePlaylist = usePlayerStore((state) => state.removePlaylist);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    void setSettings({
      volume: snapshot.volume,
      muted: snapshot.muted
    });
  }, [snapshot.volume, snapshot.muted, setSettings]);

  useEffect(() => {
    const source = searchParams.get("source");
    if (!source) {
      return;
    }

    const alreadyExists = playlists.some((playlist) => playlist.sourceValue === source);
    if (!alreadyExists) {
      void importFromUrl(source);
    }

    searchParams.delete("source");
    setSearchParams(searchParams, { replace: true });
  }, [searchParams, setSearchParams, playlists, importFromUrl]);

  const activePlaylist = useMemo(
    () => playlists.find((playlist) => playlist.id === activePlaylistId) || playlists[0] || null,
    [playlists, activePlaylistId]
  );

  const activeChannel = useMemo(
    () => {
      const playableChannels = activePlaylist?.channels.filter((channel) => !isPlaylistAccountUrl(channel.url)) || [];
      return playableChannels.find((channel) => channel.id === activeChannelId) || playableChannels[0] || null;
    },
    [activePlaylist, activeChannelId]
  );

  const deferredSearch = useDeferredValue(searchQuery);
  const favoritesSet = useMemo(() => new Set(favorites), [favorites]);
  const recentLookup = useMemo(
    () =>
      new Map(
        recentChannels.map((entry) => [`${entry.playlistId}:${entry.channelId}`, entry])
      ),
    [recentChannels]
  );

  const playlistChannels = useMemo(
    () => activePlaylist?.channels.filter((channel) => !isPlaylistAccountUrl(channel.url)) || [],
    [activePlaylist]
  );
  const fuse = useMemo(
    () =>
      new Fuse(playlistChannels, {
        keys: ["name", "group"],
        threshold: 0.24,
        ignoreLocation: true
      }),
    [playlistChannels]
  );

  const filteredChannels = useMemo(() => {
    let next: PlaylistChannel[] = playlistChannels;

    if (sidebarView === "favorites") {
      next = next.filter((channel) => favoritesSet.has(`${channel.playlistId}:${channel.id}`));
    } else if (sidebarView === "recent") {
      next = recentChannels
        .map((entry) =>
          playlistChannels.find(
            (channel) => channel.playlistId === entry.playlistId && channel.id === entry.channelId
          )
        )
        .filter(Boolean) as PlaylistChannel[];
    }

    if (selectedGroup !== "All") {
      next = next.filter((channel) => channel.group === selectedGroup);
    }

    const query = deferredSearch.trim();
    if (!query) {
      return next;
    }

    const searchSource = sidebarView === "all" && selectedGroup === "All" ? fuse.search(query).map((item) => item.item) : next;
    return searchSource.filter((channel) =>
      `${channel.name} ${channel.group}`.toLowerCase().includes(query.toLowerCase())
    );
  }, [playlistChannels, sidebarView, selectedGroup, deferredSearch, fuse, favoritesSet, recentChannels]);

  const currentIndex = filteredChannels.findIndex((channel) => channel.id === activeChannel?.id);
  const nextChannel = currentIndex >= 0 ? filteredChannels[currentIndex + 1] || null : null;
  const currentPlayableUrl = activeChannel
    ? getPlayableStreamUrl(buildBrowserPlayableUrl(activeChannel.url))
    : null;
  const nextPlayableUrl = nextChannel
    ? getPlayableStreamUrl(buildBrowserPlayableUrl(nextChannel.url))
    : null;
  const activeChannelLogo = activeChannel ? getCachedLogoUrl(activeChannel.logo) : null;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!activeChannel || filteredChannels.length === 0) {
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        const nextChannel = filteredChannels[Math.min(filteredChannels.length - 1, currentIndex + 1)];
        if (nextChannel) {
          void selectChannel(nextChannel);
        }
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        const nextChannel = filteredChannels[Math.max(0, currentIndex - 1)];
        if (nextChannel) {
          void selectChannel(nextChannel);
        }
      }

      if (event.key.toLowerCase() === "r") {
        playerRef.current?.reload();
      }

      if (event.key.toLowerCase() === "f") {
        playerRef.current?.toggleFullscreen();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeChannel, filteredChannels, currentIndex, selectChannel]);

  const handleFileImport = async (file: File) => {
    const rawText = await file.text();
    await importFromText({
      name: file.name.replace(/\.m3u8?$/i, "") || file.name,
      rawText,
      sourceType: "file",
      sourceValue: file.name
    });
  };

  const handleUrlImport = async () => {
    const completed = completeUrl(urlInput);
    if (!completed) {
      return;
    }
    await importFromUrl(completed);
    setUrlInput("");
  };

  const handleManualImport = async () => {
    if (!manualText.trim()) {
      return;
    }

    await importFromText({
      name: "Manual Playlist",
      rawText: manualText,
      sourceType: "manual",
      sourceValue: "manual-text"
    });
    setManualText("");
  };

  const handleDirectStreamImport = async () => {
    const completed = completeUrl(urlInput);
    if (!completed) {
      return;
    }
    await importDirectStream(completed);
    setUrlInput("");
  };

  return (
    <div className="grid gap-6">
      <section
        className="glass-panel grid gap-5 rounded-xl p-5 md:grid-cols-[1.1fr_0.9fr]"
        onDragOver={(event) => {
          event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          const file = event.dataTransfer.files?.[0];
          if (file) {
            void handleFileImport(file);
          }
        }}
      >
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-neon-cyan/80">PLAYER MODULE</p>
          <h1 className="mt-3 font-display text-4xl text-white">Pro Max IPTV Player</h1>
          <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { label: "Engine", value: snapshot.engine || "Auto", icon: <Zap className="h-4 w-4" />, tone: "text-neon-green" },
              { label: "Buffer", value: `${snapshot.bufferSeconds.toFixed(1)}s`, icon: <Gauge className="h-4 w-4" />, tone: "text-neon-cyan" },
              { label: "Quality", value: snapshot.qualityLabel, icon: <Monitor className="h-4 w-4" />, tone: "text-neon-amber" },
              { label: "Network", value: snapshot.networkKbps ? `${snapshot.networkKbps} kbps` : "Detecting", icon: <Wifi className="h-4 w-4" />, tone: "text-slate-200" }
            ].map((item) => (
              <div key={item.label} className="rounded-lg border border-white/10 bg-black/25 px-4 py-3 shadow-neon backdrop-blur-xl">
                <div className={`flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] ${item.tone}`}>
                  {item.icon}
                  {item.label}
                </div>
                <p className="mt-2 truncate text-sm text-white">{item.value}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="grid gap-3">
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="inline-flex items-center gap-2 border border-neon-cyan/40 bg-neon-cyan/10 px-4 py-3 font-mono text-xs uppercase tracking-[0.22em] text-neon-cyan transition hover:bg-neon-cyan/20"
            >
              <FileUp className="h-4 w-4" />
              Import M3U
            </button>
            <button
              type="button"
              onClick={handleUrlImport}
              disabled={!urlInput.trim() || importing}
              className="inline-flex items-center gap-2 border border-neon-green/40 bg-neon-green/10 px-4 py-3 font-mono text-xs uppercase tracking-[0.22em] text-neon-green transition hover:bg-neon-green/20 disabled:opacity-40"
            >
              <Import className="h-4 w-4" />
              Load URL
            </button>
            <input
              ref={inputRef}
              type="file"
              accept=".m3u,.m3u8,.txt"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  void handleFileImport(file);
                }
                event.target.value = "";
              }}
            />
          </div>

          <div className="grid gap-3 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="grid gap-2">
              <input
                value={urlInput}
                onChange={(event) => setUrlInput(event.target.value)}
                onBlur={() => setUrlInput((current) => completeUrl(current))}
                placeholder="http://server/get.php?username=user&password=pass&type=m3u_plus"
                className="border border-white/10 bg-black/20 px-4 py-3 font-mono text-sm text-white outline-none transition focus:border-neon-cyan/40"
              />
              {urlInput.trim() && completeUrl(urlInput) !== urlInput.trim() ? (
                <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-slate-500">
                  {completeUrl(urlInput)}
                </p>
              ) : null}
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={handleDirectStreamImport}
                  disabled={!urlInput.trim() || importing}
                  className="inline-flex items-center gap-2 border border-white/10 bg-white/[0.05] px-4 py-3 font-mono text-xs uppercase tracking-[0.2em] text-slate-100 transition hover:border-neon-cyan/30 disabled:opacity-40"
                >
                  <Download className="h-4 w-4" />
                  Paste Stream
                </button>
                <button
                  type="button"
                  onClick={() => setUrlInput((current) => completeUrl(current))}
                  className="inline-flex items-center gap-2 border border-white/10 bg-white/[0.05] px-4 py-3 font-mono text-xs uppercase tracking-[0.2em] text-slate-100 transition hover:border-neon-cyan/30"
                >
                  <RefreshCcw className="h-4 w-4" />
                  Auto Complete
                </button>
              </div>
            </div>

            <div className="grid gap-2">
              <textarea
                value={manualText}
                onChange={(event) => setManualText(event.target.value)}
                placeholder="#EXTM3U or pasted playlist text"
                className="min-h-[108px] border border-white/10 bg-black/20 px-4 py-3 font-mono text-sm text-white outline-none transition focus:border-neon-cyan/40"
              />
              <button
                type="button"
                onClick={handleManualImport}
                disabled={!manualText.trim() || importing}
                className="inline-flex items-center justify-center gap-2 border border-white/10 bg-white/[0.05] px-4 py-3 font-mono text-xs uppercase tracking-[0.2em] text-slate-100 transition hover:border-neon-cyan/30 disabled:opacity-40"
              >
                <ListVideo className="h-4 w-4" />
                Parse Text
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
        <aside className="glass-panel rounded-xl p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="font-mono text-xs uppercase tracking-[0.22em] text-neon-cyan">Playlists</p>
            <span className="font-mono text-xs text-slate-500">{playlists.length}</span>
          </div>

          <div className="mt-3 grid gap-2">
            {playlists.length === 0 ? (
              <div className="border border-dashed border-white/10 px-4 py-8 text-center font-mono text-xs uppercase tracking-[0.2em] text-slate-500">
                {loading ? "Loading cache..." : "Import a playlist"}
              </div>
            ) : (
              playlists.map((playlist) => (
                <div key={playlist.id} className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setActivePlaylist(playlist.id)}
                    className={`min-w-0 flex-1 border px-3 py-3 text-left transition ${
                      activePlaylist?.id === playlist.id
                        ? "border-neon-cyan/40 bg-neon-cyan/10"
                        : "border-white/10 bg-black/20 hover:border-white/20"
                    }`}
                  >
                    <p className="truncate text-sm text-white">{playlist.name}</p>
                    <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-slate-500">
                      {playlist.channelCount} channels
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void removePlaylist(playlist.id);
                    }}
                    className="border border-white/10 bg-black/20 px-3 py-3 font-mono text-xs uppercase tracking-[0.18em] text-slate-400 transition hover:border-neon-red/30 hover:text-neon-red"
                  >
                    X
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="mt-5 flex gap-2">
            {[
              { id: "all", label: "All", icon: <ListVideo className="h-4 w-4" /> },
              { id: "favorites", label: "Favorites", icon: <Heart className="h-4 w-4" /> },
              { id: "recent", label: "Recent", icon: <History className="h-4 w-4" /> }
            ].map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  void setSidebarView(item.id as "all" | "favorites" | "recent");
                }}
                className={`inline-flex flex-1 items-center justify-center gap-2 border px-3 py-3 font-mono text-xs uppercase tracking-[0.18em] transition ${
                  sidebarView === item.id
                    ? "border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan"
                    : "border-white/10 bg-black/20 text-slate-300"
                }`}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </div>

          <div className="mt-4 rounded-lg border border-white/10 bg-black/25 px-3 py-3">
            <div className="flex items-center gap-2">
              <Search className="h-4 w-4 text-slate-500" />
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search channels"
                className="w-full bg-transparent font-mono text-sm text-white outline-none placeholder:text-slate-500"
              />
            </div>
          </div>

          <div className="mt-4 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {["All", ...(activePlaylist?.groups || [])].map((group) => (
              <button
                key={group}
                type="button"
                onClick={() => setSelectedGroup(group)}
                className={`shrink-0 border px-3 py-2 font-mono text-[11px] uppercase tracking-[0.16em] transition ${
                  selectedGroup === group
                    ? "border-neon-green/40 bg-neon-green/10 text-neon-green"
                    : "border-white/10 bg-black/20 text-slate-400"
                }`}
              >
                {group}
              </button>
            ))}
          </div>

          <div className="mt-4">
            <VirtualChannelList
              channels={filteredChannels}
              favorites={favorites}
              recentLookup={recentLookup}
              activeChannelId={activeChannel?.id || null}
              height={Math.max(360, typeof window !== "undefined" ? window.innerHeight - 430 : 420)}
              onSelect={(channel) => {
                void selectChannel(channel);
              }}
              onToggleFavorite={(channel) => {
                void toggleFavorite(channel);
              }}
            />
          </div>
        </aside>

        <section className="grid gap-5">
          <div className="glass-panel rounded-xl p-4">
            <IptvVideoPlayer
              ref={playerRef}
              sourceUrl={currentPlayableUrl}
              title={activeChannel?.name || "Select a channel"}
              logoUrl={activeChannelLogo}
              preloadUrl={nextPlayableUrl}
              defaultMuted={settings.muted}
              defaultVolume={settings.volume}
              onPrevious={
                currentIndex > 0
                  ? () => {
                      void selectChannel(filteredChannels[currentIndex - 1]);
                    }
                  : undefined
              }
              onNext={
                currentIndex >= 0 && currentIndex < filteredChannels.length - 1
                  ? () => {
                      void selectChannel(filteredChannels[currentIndex + 1]);
                    }
                  : undefined
              }
              onSnapshotChange={setSnapshot}
            />
          </div>

          <div className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="glass-panel rounded-xl p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-mono text-xs uppercase tracking-[0.22em] text-neon-cyan">Now Playing</p>
                  <h2 className="mt-2 font-display text-2xl text-white">{activeChannel?.name || "Waiting for channel"}</h2>
                </div>
                <div className="rounded-full border border-white/10 bg-black/25 px-3 py-1 font-mono text-xs uppercase tracking-[0.18em] text-slate-300">
                  {snapshot.status}
                </div>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <div className="rounded-lg border border-white/10 bg-black/25 px-4 py-3">
                  <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-slate-500">Playlist</p>
                  <p className="mt-2 text-sm text-white">{activePlaylist?.name || "None"}</p>
                </div>
                <div className="rounded-lg border border-white/10 bg-black/25 px-4 py-3">
                  <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-slate-500">Group</p>
                  <p className="mt-2 text-sm text-white">{activeChannel?.group || "None"}</p>
                </div>
                <div className="rounded-lg border border-white/10 bg-black/25 px-4 py-3">
                  <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-slate-500">Bitrate</p>
                  <p className="mt-2 text-sm text-white">{snapshot.bitrateKbps ? `${snapshot.bitrateKbps} kbps` : "Auto"}</p>
                </div>
                <div className="rounded-lg border border-white/10 bg-black/25 px-4 py-3">
                  <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-slate-500">Resolution</p>
                  <p className="mt-2 text-sm text-white">{snapshot.resolution}</p>
                </div>
              </div>

              {activeChannel ? (
                <div className="mt-4 flex flex-wrap gap-3">
                  <a
                    href={buildVlcUrl(activeChannel.url)}
                    className="inline-flex items-center gap-2 border border-neon-cyan/40 bg-neon-cyan/10 px-4 py-3 font-mono text-xs uppercase tracking-[0.2em] text-neon-cyan transition hover:bg-neon-cyan/20"
                  >
                    <ExternalLink className="h-4 w-4" />
                    VLC
                  </a>
                  <a
                    href={buildMxUrl(activeChannel.url)}
                    className="inline-flex items-center gap-2 border border-neon-green/40 bg-neon-green/10 px-4 py-3 font-mono text-xs uppercase tracking-[0.2em] text-neon-green transition hover:bg-neon-green/20"
                  >
                    <ExternalLink className="h-4 w-4" />
                    MX
                  </a>
                  <button
                    type="button"
                    onClick={() => playerRef.current?.reload()}
                    className="inline-flex items-center gap-2 border border-white/10 bg-white/[0.05] px-4 py-3 font-mono text-xs uppercase tracking-[0.2em] text-slate-100 transition hover:border-neon-cyan/30"
                  >
                    <RefreshCcw className="h-4 w-4" />
                    Reload
                  </button>
                </div>
              ) : null}
            </div>

            <div className="glass-panel rounded-xl p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="font-mono text-xs uppercase tracking-[0.22em] text-neon-cyan">Stream Health</p>
                <SignalHigh className="h-4 w-4 text-neon-green" />
              </div>
              <div className="mt-4 grid gap-3 font-mono text-xs uppercase tracking-[0.16em] text-slate-300">
                {[
                  ["FPS", snapshot.fps ? `${snapshot.fps}` : "0"],
                  ["Dropped", `${snapshot.droppedFrames}`],
                  ["Live edge", `${snapshot.liveLatency.toFixed(1)}s`],
                  ["Reconnects", `${snapshot.reconnectAttempts}`],
                  ["Stalls", `${snapshot.stallCount}`],
                  ["Volume", `${Math.round(snapshot.volume * 100)}%`]
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between rounded-lg border border-white/10 bg-black/25 px-4 py-3">
                    <span>{label}</span>
                    <span className="text-neon-cyan">{value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      </section>
    </div>
  );
}
