import { Heart, History, Play } from "lucide-react";
import { memo } from "react";
import { List, type RowComponentProps } from "react-window";
import { getCachedLogoUrl } from "../../lib/playerApi";
import type { PlaylistChannel, RecentChannel } from "../../player/types";

interface VirtualChannelListProps {
  channels: PlaylistChannel[];
  favorites: string[];
  recentLookup: Map<string, RecentChannel>;
  activeChannelId: string | null;
  height: number;
  onSelect: (channel: PlaylistChannel) => void;
  onToggleFavorite: (channel: PlaylistChannel) => void;
}

interface ChannelRowProps {
  channels: PlaylistChannel[];
  favorites: string[];
  recentLookup: Map<string, RecentChannel>;
  activeChannelId: string | null;
  onSelect: (channel: PlaylistChannel) => void;
  onToggleFavorite: (channel: PlaylistChannel) => void;
}

const ChannelRow = memo(function ChannelRow({
  channels,
  favorites,
  recentLookup,
  activeChannelId,
  onSelect,
  onToggleFavorite,
  index,
  style
}: RowComponentProps<ChannelRowProps>) {
  const channel = channels[index];
  const favoriteKey = `${channel.playlistId}:${channel.id}`;
  const isFavorite = favorites.includes(favoriteKey);
  const isActive = activeChannelId === channel.id;
  const wasRecent = recentLookup.has(favoriteKey);
  const logoUrl = getCachedLogoUrl(channel.logo);
  const selectChannel = () => onSelect(channel);

  return (
    <div style={style} className="px-2 py-1">
      <div
        role="button"
        tabIndex={0}
        onClick={selectChannel}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            selectChannel();
          }
        }}
        className={`flex w-full items-center gap-3 rounded-lg border px-3 py-3 text-left transition ${
          isActive
            ? "border-neon-cyan/50 bg-neon-cyan/12 text-white"
            : "border-white/8 bg-white/[0.03] text-slate-200 hover:border-white/15"
        }`}
      >
        <div className="h-10 w-10 shrink-0 overflow-hidden rounded-md border border-white/8 bg-black/30">
          {logoUrl ? (
            <img
              src={logoUrl}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
              onError={(event) => {
                event.currentTarget.style.display = "none";
              }}
            />
          ) : null}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{channel.name}</p>
          <p className="truncate font-mono text-[11px] uppercase tracking-[0.16em] text-slate-500">
            {channel.group}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {wasRecent ? <History className="h-4 w-4 text-neon-cyan/70" /> : null}
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggleFavorite(channel);
            }}
            className={`rounded-full p-1 ${isFavorite ? "text-neon-green" : "text-slate-500 hover:text-neon-green"}`}
            aria-label="Toggle favorite"
          >
            <Heart className={`h-4 w-4 ${isFavorite ? "fill-current" : ""}`} />
          </button>
          <Play className="h-4 w-4 text-slate-500" />
        </div>
      </div>
    </div>
  );
});

export function VirtualChannelList({
  channels,
  favorites,
  recentLookup,
  activeChannelId,
  height,
  onSelect,
  onToggleFavorite
}: VirtualChannelListProps) {
  if (channels.length === 0) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-white/10 text-center font-mono text-xs uppercase tracking-[0.18em] text-slate-500">
        No channels
      </div>
    );
  }

  return (
    <List
      rowComponent={ChannelRow}
      rowCount={channels.length}
      rowHeight={74}
      rowProps={{
        channels,
        favorites,
        recentLookup,
        activeChannelId,
        onSelect,
        onToggleFavorite
      }}
      defaultHeight={height}
      style={{ height, width: "100%" }}
    />
  );
}
