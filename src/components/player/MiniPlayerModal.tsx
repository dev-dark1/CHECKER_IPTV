import { ExternalLink, X } from "lucide-react";
import { useMemo } from "react";
import { IptvVideoPlayer } from "./IptvVideoPlayer";
import { buildMxUrl, buildVlcUrl } from "../../lib/playerUrl";
import { usePlayerStore } from "../../store/usePlayerStore";

export function MiniPlayerModal() {
  const miniPlayer = usePlayerStore((state) => state.miniPlayer);
  const closeMiniPlayer = usePlayerStore((state) => state.closeMiniPlayer);

  const externalLinks = useMemo(() => {
    const source = miniPlayer?.externalUrl || miniPlayer?.sourceUrl;
    if (!source) {
      return null;
    }

    return {
      vlc: buildVlcUrl(source),
      mx: buildMxUrl(source)
    };
  }, [miniPlayer]);

  if (!miniPlayer) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm md:items-center">
      <div className="glass-panel w-full max-w-3xl rounded-xl p-4">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <p className="font-display text-lg text-white">{miniPlayer.title}</p>
            {miniPlayer.playlistUrl ? (
              <p className="font-mono text-xs text-slate-400">{miniPlayer.playlistUrl}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={closeMiniPlayer}
            className="rounded-full border border-white/10 bg-white/[0.06] p-2 text-slate-100 transition hover:border-neon-red/40 hover:text-neon-red"
            aria-label="Close mini player"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <IptvVideoPlayer sourceUrl={miniPlayer.sourceUrl} title={miniPlayer.title} mini />

        {externalLinks ? (
          <div className="mt-4 flex flex-wrap gap-3">
            <a
              href={externalLinks.vlc}
              className="inline-flex items-center gap-2 rounded-full border border-neon-cyan/40 bg-neon-cyan/10 px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-neon-cyan transition hover:bg-neon-cyan/20"
            >
              <ExternalLink className="h-4 w-4" />
              VLC
            </a>
            <a
              href={externalLinks.mx}
              className="inline-flex items-center gap-2 rounded-full border border-neon-green/40 bg-neon-green/10 px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-neon-green transition hover:bg-neon-green/20"
            >
              <ExternalLink className="h-4 w-4" />
              MX
            </a>
          </div>
        ) : null}
      </div>
    </div>
  );
}
