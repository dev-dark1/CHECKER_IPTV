import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";

interface MiniHlsPlayerProps {
  sourceUrl: string | null;
  title: string;
}

export function MiniHlsPlayer({ sourceUrl, title }: MiniHlsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const video = videoRef.current;

    if (!video || !sourceUrl) {
      return;
    }

    setError("");

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 90,
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 10,
        liveDurationInfinity: true,
        highBufferWatchdogPeriod: 2,
        nudgeOffset: 0.1,
        nudgeMaxRetry: 10,
        manifestLoadingRetryDelay: 1000,
        fragLoadingRetryDelay: 1000,
        fragLoadingMaxRetry: 10,
        levelLoadingMaxRetry: 10,
        appendErrorMaxRetry: 10,
        progressive: true
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          setError(data.details || "HLS preview failed.");
        }
      });
      hls.loadSource(sourceUrl);
      hls.attachMedia(video);

      return () => {
        hls.destroy();
      };
    }

    setError("HLS.js is required for IPTV preview playback.");
  }, [sourceUrl]);

  if (!sourceUrl) {
    return (
      <div className="flex aspect-video items-center justify-center rounded-md border border-white/10 bg-black/30 px-4 text-center font-mono text-xs uppercase tracking-[0.18em] text-slate-500">
        {title}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border border-white/10 bg-black/40">
      <video
        ref={videoRef}
        className="aspect-video w-full bg-black object-contain"
        controls
        muted
        playsInline
        preload="metadata"
        title={title}
      />
      {error ? (
        <div className="border-t border-white/10 px-3 py-2 font-mono text-xs text-neon-red">{error}</div>
      ) : null}
    </div>
  );
}
