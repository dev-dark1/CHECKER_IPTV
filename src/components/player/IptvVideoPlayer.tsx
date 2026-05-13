import {
  Activity,
  BarChart3,
  ChevronDown,
  ChevronUp,
  Expand,
  Gauge,
  LoaderCircle,
  Pause,
  PictureInPicture,
  Play,
  RefreshCcw,
  Settings,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX
} from "lucide-react";
import Hls from "hls.js";
import mpegts from "mpegts.js";
import shaka from "shaka-player/dist/shaka-player.compiled";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from "react";
import type { PointerEvent } from "react";

export interface IptvVideoPlayerHandle {
  reload: () => void;
  toggleFullscreen: () => void;
}

export interface PlayerSnapshot {
  status: "idle" | "loading" | "playing" | "buffering" | "error";
  bitrateKbps: number | null;
  muted: boolean;
  volume: number;
  engine: string | null;
  bufferSeconds: number;
  droppedFrames: number;
  decodedFrames: number;
  fps: number;
  resolution: string;
  liveLatency: number;
  reconnectAttempts: number;
  stallCount: number;
  networkKbps: number | null;
  qualityLabel: string;
}

interface IptvVideoPlayerProps {
  sourceUrl: string | null;
  title: string;
  mini?: boolean;
  defaultMuted?: boolean;
  defaultVolume?: number;
  logoUrl?: string | null;
  preloadUrl?: string | null;
  onPrevious?: () => void;
  onNext?: () => void;
  onSnapshotChange?: (snapshot: PlayerSnapshot) => void;
}

type PlaybackEngine = "hls" | "mpegts" | "shaka";
type QualityMode = "auto" | `hls-${number}` | `shaka-${number}`;

interface ProbePayload {
  ok?: boolean;
  contentType?: string;
  status?: number;
  selectedProxy?: string;
  pool?: string;
  error?: string;
  message?: string;
}

interface QualityOption {
  id: QualityMode;
  label: string;
  bitrateKbps: number | null;
  height: number | null;
}

interface VideoBufferInfo {
  ahead: number;
  behind: number;
  liveLatency: number;
  nextRangeStart: number | null;
  end: number | null;
}

interface PointerStart {
  id: number;
  x: number;
  y: number;
  time: number;
  volume: number;
  brightness: number;
  currentTime: number;
  zone: "left" | "center" | "right";
}

type WakeLockSentinelLike = {
  release: () => Promise<void>;
  addEventListener?: (type: "release", listener: () => void) => void;
};

const HLS_CONFIG = {
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
} satisfies Partial<Hls["config"]>;

const MPEGTS_CONFIG = {
  enableWorker: true,
  enableStashBuffer: true,
  stashInitialSize: 384 * 1024,
  lazyLoad: true,
  liveBufferLatencyChasing: true,
  liveBufferLatencyMaxLatency: 5,
  liveBufferLatencyMinRemain: 1,
  autoCleanupSourceBuffer: true,
  autoCleanupMaxBackwardDuration: 90,
  autoCleanupMinBackwardDuration: 60,
  fixAudioTimestampGap: true
};

const STATUS_TIMEOUT_MS = 16000;
const WATCHDOG_INTERVAL_MS = 1000;
const SOFT_STALL_MS = 3200;
const HARD_STALL_MS = 9500;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function extractProviderUrl(playbackUrl: string) {
  try {
    const parsed = new URL(playbackUrl, window.location.origin);
    const nestedUrl = parsed.searchParams.get("url");

    if (
      nestedUrl &&
      (parsed.pathname === "/proxy" ||
        parsed.pathname === "/proxy/probe" ||
        parsed.pathname === "/api/player/stream" ||
        parsed.pathname === "/api/hls-proxy")
    ) {
      return nestedUrl;
    }
  } catch {
    // fall through
  }

  return playbackUrl;
}

function getProviderPath(playbackUrl: string) {
  const providerUrl = extractProviderUrl(playbackUrl);

  try {
    return new URL(providerUrl).pathname.toLowerCase();
  } catch {
    return providerUrl.toLowerCase().split("?")[0];
  }
}

function engineFromUrl(playbackUrl: string): PlaybackEngine | null {
  const path = getProviderPath(playbackUrl);

  if (/\.m3u8?$/i.test(path)) return "hls";
  if (/\.(ts|mpegts)$/i.test(path)) return "mpegts";
  if (/\.mpd$/i.test(path)) return "shaka";

  return null;
}

function engineFromContentType(contentType: string | undefined): PlaybackEngine | null {
  const normalized = String(contentType || "").toLowerCase();

  if (/mpegurl|vnd\.apple\.mpegurl/.test(normalized)) return "hls";
  if (/video\/mp2t/.test(normalized)) return "mpegts";
  if (/dash\+xml/.test(normalized)) return "shaka";

  return null;
}

function buildAttemptUrl(sourceUrl: string, attempt: number) {
  const providerUrl = extractProviderUrl(sourceUrl);
  const url = new URL("/proxy", window.location.origin);
  url.searchParams.set("url", providerUrl);

  if (attempt > 0) {
    url.searchParams.set("retry", String(Math.min(3, attempt)));
  }

  return url.toString();
}

function buildProbeUrl(playbackUrl: string) {
  const parsed = new URL(playbackUrl, window.location.origin);
  const probe = new URL("/proxy/probe", window.location.origin);
  probe.searchParams.set("url", extractProviderUrl(playbackUrl));

  const retry = parsed.searchParams.get("retry");
  if (retry) {
    probe.searchParams.set("retry", retry);
  }

  return probe.toString();
}

function getConnectionKbps() {
  const connection = (navigator as Navigator & {
    connection?: { downlink?: number; effectiveType?: string; saveData?: boolean };
  }).connection;

  if (!connection?.downlink) {
    return null;
  }

  return Math.round(connection.downlink * 1000);
}

function getNetworkProfile() {
  const connection = (navigator as Navigator & {
    connection?: { downlink?: number; effectiveType?: string; saveData?: boolean };
  }).connection;
  const kbps = getConnectionKbps();
  const effectiveType = connection?.effectiveType || "unknown";
  const saveData = Boolean(connection?.saveData);

  if (saveData || /2g/i.test(effectiveType) || (kbps !== null && kbps < 1800)) {
    return { kbps, tier: "weak" as const, maxHeight: 720 };
  }

  if (/3g/i.test(effectiveType) || (kbps !== null && kbps < 5500)) {
    return { kbps, tier: "medium" as const, maxHeight: 1080 };
  }

  return { kbps, tier: "strong" as const, maxHeight: Infinity };
}

function getVideoBufferInfo(video: HTMLVideoElement): VideoBufferInfo {
  const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
  const buffered = video.buffered;
  let ahead = 0;
  let behind = 0;
  let nextRangeStart: number | null = null;
  let end: number | null = null;

  for (let index = 0; index < buffered.length; index += 1) {
    const start = buffered.start(index);
    const rangeEnd = buffered.end(index);
    end = rangeEnd;

    if (currentTime >= start - 0.05 && currentTime <= rangeEnd + 0.05) {
      ahead = Math.max(0, rangeEnd - currentTime);
      behind = Math.max(0, currentTime - start);
    } else if (start > currentTime && nextRangeStart === null) {
      nextRangeStart = start;
    }
  }

  return {
    ahead,
    behind,
    liveLatency: end === null ? 0 : Math.max(0, end - currentTime),
    nextRangeStart,
    end
  };
}

function getVideoQuality(video: HTMLVideoElement) {
  const htmlVideo = video as HTMLVideoElement & {
    webkitDecodedFrameCount?: number;
    webkitDroppedFrameCount?: number;
  };
  const quality = video.getVideoPlaybackQuality?.();

  return {
    decodedFrames: quality?.totalVideoFrames ?? htmlVideo.webkitDecodedFrameCount ?? 0,
    droppedFrames: quality?.droppedVideoFrames ?? htmlVideo.webkitDroppedFrameCount ?? 0
  };
}

function formatResolution(video: HTMLVideoElement) {
  if (!video.videoWidth || !video.videoHeight) {
    return "Unknown";
  }

  return `${video.videoWidth}x${video.videoHeight}`;
}

function formatQualityLabel(option: QualityOption | undefined) {
  return option?.label || "Auto";
}

function logPlayer(event: string, details: Record<string, unknown>) {
  console.log(`[player:${event}]`, details);
}

export const IptvVideoPlayer = forwardRef<IptvVideoPlayerHandle, IptvVideoPlayerProps>(
  function IptvVideoPlayer(
    {
      sourceUrl,
      title,
      mini = false,
      defaultMuted = false,
      defaultVolume = 0.85,
      logoUrl,
      preloadUrl,
      onPrevious,
      onNext,
      onSnapshotChange
    },
    ref
  ) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const hlsRef = useRef<Hls | null>(null);
    const mpegtsRef = useRef<ReturnType<typeof mpegts.createPlayer> | null>(null);
    const shakaRef = useRef<shaka.Player | null>(null);
    const watchdogTimerRef = useRef<number | null>(null);
    const retryTimerRef = useRef<number | null>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    const preloadControllerRef = useRef<AbortController | null>(null);
    const eventCleanupRef = useRef<Array<() => void>>([]);
    const loadStreamRef = useRef<(attempt?: number) => void>(() => undefined);
    const loadIdRef = useRef(0);
    const lastProgressAtRef = useRef(0);
    const lastMovingAtRef = useRef(0);
    const lastCurrentTimeRef = useRef(0);
    const lastFrameSampleRef = useRef({ decoded: 0, at: 0 });
    const recoveryLockRef = useRef(0);
    const reconnectAttemptsRef = useRef(0);
    const stallCountRef = useRef(0);
    const lastStatsLogAtRef = useRef(0);
    const pointerStartRef = useRef<PointerStart | null>(null);
    const lastTapRef = useRef({ at: 0, x: 0 });
    const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const audioGainRef = useRef<GainNode | null>(null);
    const audioSourceReadyRef = useRef(false);

    const [status, setStatus] = useState<PlayerSnapshot["status"]>("idle");
    const [error, setError] = useState("");
    const [engineLabel, setEngineLabel] = useState<string | null>(null);
    const [isMuted, setIsMuted] = useState(defaultMuted);
    const [volume, setVolume] = useState(defaultVolume);
    const [bitrateKbps, setBitrateKbps] = useState<number | null>(null);
    const [bufferSeconds, setBufferSeconds] = useState(0);
    const [droppedFrames, setDroppedFrames] = useState(0);
    const [decodedFrames, setDecodedFrames] = useState(0);
    const [fps, setFps] = useState(0);
    const [resolution, setResolution] = useState("Unknown");
    const [liveLatency, setLiveLatency] = useState(0);
    const [reconnectAttempts, setReconnectAttempts] = useState(0);
    const [stallCount, setStallCount] = useState(0);
    const [networkKbps, setNetworkKbps] = useState<number | null>(() => getConnectionKbps());
    const [qualityOptions, setQualityOptions] = useState<QualityOption[]>([
      { id: "auto", label: "Auto", bitrateKbps: null, height: null }
    ]);
    const [qualityMode, setQualityMode] = useState<QualityMode>("auto");
    const [showSettings, setShowSettings] = useState(false);
    const [showStats, setShowStats] = useState(false);
    const [controlsVisible, setControlsVisible] = useState(true);
    const [isPaused, setIsPaused] = useState(true);
    const [brightness, setBrightness] = useState(1.02);
    const [gestureHint, setGestureHint] = useState("");
    const [isSwitching, setIsSwitching] = useState(false);
    const statusValueRef = useRef(status);
    const engineLabelValueRef = useRef(engineLabel);
    const bitrateKbpsValueRef = useRef(bitrateKbps);

    const maxRetries = mini ? 2 : 4;
    const activeQuality = useMemo(
      () => qualityOptions.find((option) => option.id === qualityMode) || qualityOptions[0],
      [qualityMode, qualityOptions]
    );
    const qualityLabel = formatQualityLabel(activeQuality);

    const snapshot = useMemo<PlayerSnapshot>(
      () => ({
        status,
        bitrateKbps,
        muted: isMuted,
        volume,
        engine: engineLabel,
        bufferSeconds,
        droppedFrames,
        decodedFrames,
        fps,
        resolution,
        liveLatency,
        reconnectAttempts,
        stallCount,
        networkKbps,
        qualityLabel
      }),
      [
        status,
        bitrateKbps,
        isMuted,
        volume,
        engineLabel,
        bufferSeconds,
        droppedFrames,
        decodedFrames,
        fps,
        resolution,
        liveLatency,
        reconnectAttempts,
        stallCount,
        networkKbps,
        qualityLabel
      ]
    );

    useEffect(() => {
      onSnapshotChange?.(snapshot);
    }, [snapshot, onSnapshotChange]);

    useEffect(() => {
      statusValueRef.current = status;
    }, [status]);

    useEffect(() => {
      engineLabelValueRef.current = engineLabel;
    }, [engineLabel]);

    useEffect(() => {
      bitrateKbpsValueRef.current = bitrateKbps;
    }, [bitrateKbps]);

    useEffect(() => {
      setIsMuted(defaultMuted);
    }, [defaultMuted]);

    useEffect(() => {
      setVolume(defaultVolume);
    }, [defaultVolume]);

    useEffect(() => {
      const video = videoRef.current;
      if (!video) return;

      video.volume = volume;
      video.muted = isMuted;

      if (audioGainRef.current) {
        audioGainRef.current.gain.value = isMuted ? 0 : volume;
      }
    }, [isMuted, volume]);

    useEffect(() => {
      const updateConnection = () => setNetworkKbps(getConnectionKbps());
      const connection = (navigator as Navigator & {
        connection?: { addEventListener?: (event: "change", listener: () => void) => void; removeEventListener?: (event: "change", listener: () => void) => void };
      }).connection;

      connection?.addEventListener?.("change", updateConnection);
      return () => connection?.removeEventListener?.("change", updateConnection);
    }, []);

    const clearWatchdog = useCallback(() => {
      if (watchdogTimerRef.current) {
        window.clearInterval(watchdogTimerRef.current);
        watchdogTimerRef.current = null;
      }
    }, []);

    const clearRetryTimer = useCallback(() => {
      if (retryTimerRef.current) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    }, []);

    const clearMediaListeners = useCallback(() => {
      for (const cleanup of eventCleanupRef.current) {
        cleanup();
      }
      eventCleanupRef.current = [];
    }, []);

    const releaseWakeLock = useCallback(() => {
      const lock = wakeLockRef.current;
      wakeLockRef.current = null;
      void lock?.release().catch(() => undefined);
    }, []);

    const requestWakeLock = useCallback(async () => {
      if (mini || wakeLockRef.current) {
        return;
      }

      const wakeLock = (navigator as Navigator & {
        wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> };
      }).wakeLock;

      if (!wakeLock) {
        return;
      }

      try {
        wakeLockRef.current = await wakeLock.request("screen");
        wakeLockRef.current.addEventListener?.("release", () => {
          wakeLockRef.current = null;
        });
      } catch {
        // Wake lock support is opportunistic.
      }
    }, [mini]);

    const clearVideoSource = useCallback(() => {
      const video = videoRef.current;
      if (!video) return;

      try {
        video.pause();
      } catch {
        // ignore reset races
      }

      try {
        video.removeAttribute("src");
        video.load();
      } catch {
        // ignore reset races
      }
    }, []);

    const destroyPlayer = useCallback(
      (clearVideo = false) => {
        clearWatchdog();
        clearRetryTimer();
        clearMediaListeners();
        abortControllerRef.current?.abort();
        abortControllerRef.current = null;

        if (hlsRef.current) {
          hlsRef.current.destroy();
          hlsRef.current = null;
        }

        if (mpegtsRef.current) {
          try {
            mpegtsRef.current.unload();
            mpegtsRef.current.detachMediaElement();
            mpegtsRef.current.destroy();
          } catch {
            // ignore reset races
          }
          mpegtsRef.current = null;
        }

        if (shakaRef.current) {
          const oldShaka = shakaRef.current;
          shakaRef.current = null;
          void oldShaka.destroy().catch(() => undefined);
        }

        try {
          videoRef.current?.pause();
        } catch {
          // ignore reset races
        }

        if (clearVideo) {
          clearVideoSource();
        }
      },
      [clearMediaListeners, clearRetryTimer, clearVideoSource, clearWatchdog]
    );

    const setupAudioEngine = useCallback(async () => {
      const video = videoRef.current;
      if (!video || audioSourceReadyRef.current) {
        await audioContextRef.current?.resume().catch(() => undefined);
        return;
      }

      try {
        const AudioContextCtor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioContextCtor) return;

        const context = new AudioContextCtor();
        const source = context.createMediaElementSource(video);
        const gain = context.createGain();
        const compressor = context.createDynamicsCompressor();

        compressor.threshold.value = -18;
        compressor.knee.value = 18;
        compressor.ratio.value = 3;
        compressor.attack.value = 0.008;
        compressor.release.value = 0.18;
        gain.gain.value = isMuted ? 0 : volume;

        source.connect(compressor);
        compressor.connect(gain);
        gain.connect(context.destination);

        audioContextRef.current = context;
        audioGainRef.current = gain;
        audioSourceReadyRef.current = true;
        await context.resume().catch(() => undefined);
      } catch {
        audioSourceReadyRef.current = true;
      }
    }, [isMuted, volume]);

    const safePlay = useCallback(
      async (video: HTMLVideoElement) => {
        await setupAudioEngine();

        try {
          await video.play();
        } catch (playError) {
          if (playError instanceof DOMException && playError.name === "NotAllowedError") {
            video.muted = true;
            setIsMuted(true);
            await video.play();
            return;
          }

          throw playError;
        }
      },
      [setupAudioEngine]
    );

    const jumpBufferGap = useCallback((video: HTMLVideoElement, bufferInfo = getVideoBufferInfo(video)) => {
      if (bufferInfo.nextRangeStart === null) {
        return false;
      }

      const gap = bufferInfo.nextRangeStart - video.currentTime;
      if (gap > 0 && gap <= 4) {
        video.currentTime = bufferInfo.nextRangeStart + 0.08;
        logPlayer("gap-jump", { gapSeconds: Number(gap.toFixed(2)), target: video.currentTime });
        return true;
      }

      return false;
    }, []);

    const seekToLiveEdge = useCallback((video: HTMLVideoElement) => {
      const bufferInfo = getVideoBufferInfo(video);
      if (bufferInfo.end === null) {
        return false;
      }

      const target = Math.max(0, bufferInfo.end - 2.2);
      if (Number.isFinite(target) && Math.abs(video.currentTime - target) > 0.7) {
        video.currentTime = target;
        logPlayer("live-edge", { target: Number(target.toFixed(2)) });
        return true;
      }

      return false;
    }, []);

    const recoverStall = useCallback(
      (loadId: number, reason: string, fail: (reason: string) => void) => {
        const video = videoRef.current;
        if (!video || loadIdRef.current !== loadId) return;

        const now = Date.now();
        if (now - recoveryLockRef.current < 1400) {
          return;
        }
        recoveryLockRef.current = now;

        stallCountRef.current += 1;
        setStallCount(stallCountRef.current);

        const bufferInfo = getVideoBufferInfo(video);
        logPlayer("stall-detected", {
          reason,
          engine: engineLabelValueRef.current,
          currentTime: Number(video.currentTime.toFixed(2)),
          bufferAhead: Number(bufferInfo.ahead.toFixed(2)),
          liveLatency: Number(bufferInfo.liveLatency.toFixed(2)),
          stallCount: stallCountRef.current
        });

        if (jumpBufferGap(video, bufferInfo)) {
          void safePlay(video).catch(() => undefined);
          return;
        }

        if (bufferInfo.liveLatency > 12 && seekToLiveEdge(video)) {
          void safePlay(video).catch(() => undefined);
          return;
        }

        if (bufferInfo.ahead > 0.35) {
          video.currentTime += 0.18;
          logPlayer("nudge-forward", { target: Number(video.currentTime.toFixed(2)) });
          void safePlay(video).catch(() => undefined);
          return;
        }

        if (hlsRef.current) {
          try {
            const liveSyncPosition = hlsRef.current.liveSyncPosition;
            if (typeof liveSyncPosition === "number" && Number.isFinite(liveSyncPosition)) {
              video.currentTime = liveSyncPosition;
            }

            hlsRef.current.startLoad(-1);
            if (stallCountRef.current % 2 === 0) {
              hlsRef.current.recoverMediaError();
            }
            void safePlay(video).catch(() => undefined);
            logPlayer("hls-recover", { reason });
            return;
          } catch {
            // fall through to reconnect
          }
        }

        if (mpegtsRef.current) {
          try {
            mpegtsRef.current.unload();
            mpegtsRef.current.load();
            void Promise.resolve(mpegtsRef.current.play()).catch(() => undefined);
            logPlayer("mpegts-recover", { reason });
            return;
          } catch {
            // fall through to reconnect
          }
        }

        if (shakaRef.current) {
          try {
            (shakaRef.current as shaka.Player & { retryStreaming?: () => void }).retryStreaming?.();
            seekToLiveEdge(video);
            void safePlay(video).catch(() => undefined);
            logPlayer("shaka-recover", { reason });
            return;
          } catch {
            // fall through to reconnect
          }
        }

        fail(`watchdog reconnect: ${reason}`);
      },
      [jumpBufferGap, safePlay, seekToLiveEdge]
    );

    const setupMediaListeners = useCallback(
      (video: HTMLVideoElement, loadId: number, fail: (reason: string) => void) => {
        const add = (event: string, listener: EventListener) => {
          video.addEventListener(event, listener);
          eventCleanupRef.current.push(() => video.removeEventListener(event, listener));
        };

        add("playing", () => {
          if (loadIdRef.current !== loadId) return;
          lastProgressAtRef.current = Date.now();
          lastMovingAtRef.current = Date.now();
          setStatus("playing");
          setIsPaused(false);
          setIsSwitching(false);
          setError("");
          void requestWakeLock();
          logPlayer("state", { state: "playing" });
        });
        add("pause", () => {
          if (loadIdRef.current !== loadId) return;
          setIsPaused(true);
          releaseWakeLock();
        });
        add("waiting", () => {
          if (loadIdRef.current !== loadId) return;
          setStatus("buffering");
          logPlayer("state", { state: "waiting" });
        });
        add("stalled", () => {
          if (loadIdRef.current !== loadId) return;
          setStatus("buffering");
          recoverStall(loadId, "media element stalled", fail);
        });
        add("loadstart", () => {
          if (loadIdRef.current !== loadId) return;
          setStatus("loading");
          logPlayer("state", { state: "loadstart" });
        });
        add("canplay", () => {
          if (loadIdRef.current !== loadId) return;
          lastProgressAtRef.current = Date.now();
          setResolution(formatResolution(video));
          logPlayer("state", { state: "canplay" });
        });
        add("loadedmetadata", () => {
          if (loadIdRef.current !== loadId) return;
          setResolution(formatResolution(video));
        });
        add("timeupdate", () => {
          if (loadIdRef.current !== loadId) return;
          lastProgressAtRef.current = Date.now();
        });
        add("progress", () => {
          if (loadIdRef.current !== loadId) return;
          lastProgressAtRef.current = Date.now();
        });
        add("error", () => {
          if (loadIdRef.current !== loadId) return;
          const code = video.error?.code || 0;
          logPlayer("media-error", { code, message: video.error?.message });
          fail(`media element error ${code}`);
        });
      },
      [recoverStall, releaseWakeLock, requestWakeLock]
    );

    const startWatchdog = useCallback(
      (loadId: number, fail: (reason: string) => void) => {
        clearWatchdog();
        const now = Date.now();
        lastProgressAtRef.current = now;
        lastMovingAtRef.current = now;
        lastCurrentTimeRef.current = videoRef.current?.currentTime || 0;
        lastFrameSampleRef.current = { decoded: 0, at: now };

        watchdogTimerRef.current = window.setInterval(() => {
          const video = videoRef.current;
          if (!video || loadIdRef.current !== loadId) return;

          const bufferInfo = getVideoBufferInfo(video);
          const quality = getVideoQuality(video);
          const sampleNow = Date.now();
          const frameSample = lastFrameSampleRef.current;
          const frameDelta = Math.max(0, quality.decodedFrames - frameSample.decoded);
          const secondDelta = Math.max(0.001, (sampleNow - frameSample.at) / 1000);
          const currentFps = frameSample.at ? Math.round(frameDelta / secondDelta) : 0;
          const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
          const moved = Math.abs(currentTime - lastCurrentTimeRef.current) > 0.05;
          const currentStatus = statusValueRef.current;
          const activePlayback = !video.paused && !video.ended && currentStatus !== "idle" && currentStatus !== "error";

          setBufferSeconds(Number(bufferInfo.ahead.toFixed(1)));
          setLiveLatency(Number(bufferInfo.liveLatency.toFixed(1)));
          setDroppedFrames(quality.droppedFrames);
          setDecodedFrames(quality.decodedFrames);
          setFps(currentFps);
          setResolution(formatResolution(video));
          setNetworkKbps(getConnectionKbps());

          if (moved || !activePlayback) {
            lastMovingAtRef.current = sampleNow;
          }

          if (activePlayback && moved && currentStatus !== "playing") {
            setStatus("playing");
          }

          if (bufferInfo.nextRangeStart !== null) {
            jumpBufferGap(video, bufferInfo);
          }

          if (activePlayback && bufferInfo.liveLatency > 18 && bufferInfo.ahead < 1.2) {
            seekToLiveEdge(video);
          }

          const stuckForMs = sampleNow - lastMovingAtRef.current;
          const noUsefulBuffer = bufferInfo.ahead < 0.6 || video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA;
          const softStall = activePlayback && stuckForMs > SOFT_STALL_MS && noUsefulBuffer;
          const hardStall = activePlayback && stuckForMs > HARD_STALL_MS;
          const setupTimeout = sampleNow - lastProgressAtRef.current > STATUS_TIMEOUT_MS && currentStatus === "loading";

          if (softStall || hardStall) {
            setStatus("buffering");
            recoverStall(loadId, hardStall ? "hard freeze" : "low buffer freeze", fail);
          }

          if (setupTimeout) {
            fail("playback startup timeout");
          }

          if (sampleNow - lastStatsLogAtRef.current > 5000) {
            lastStatsLogAtRef.current = sampleNow;
            logPlayer("stats", {
              status: currentStatus,
              engine: engineLabelValueRef.current,
              bufferSeconds: Number(bufferInfo.ahead.toFixed(1)),
              liveLatency: Number(bufferInfo.liveLatency.toFixed(1)),
              bitrateKbps: bitrateKbpsValueRef.current,
              droppedFrames: quality.droppedFrames,
              fps: currentFps,
              resolution: formatResolution(video),
              reconnectAttempts: reconnectAttemptsRef.current
            });
          }

          lastCurrentTimeRef.current = currentTime;
          lastFrameSampleRef.current = { decoded: quality.decodedFrames, at: sampleNow };
        }, WATCHDOG_INTERVAL_MS);
      },
      [clearWatchdog, jumpBufferGap, recoverStall, seekToLiveEdge]
    );

    const probeBeforePlayback = useCallback(async (playbackUrl: string, signal: AbortSignal) => {
      const probeUrl = buildProbeUrl(playbackUrl);
      const response = await fetch(probeUrl, { signal });
      const payload = (await response.json().catch(() => ({}))) as ProbePayload;

      logPlayer("probe", {
        playbackUrl,
        probeUrl,
        ok: payload.ok,
        status: payload.status,
        contentType: payload.contentType,
        selectedProxy: payload.selectedProxy,
        pool: payload.pool
      });

      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || payload.message || `Proxy probe failed with ${response.status}`);
      }

      return payload;
    }, []);

    const applyHlsQuality = useCallback((hls: Hls, mode: QualityMode) => {
      const networkProfile = getNetworkProfile();
      if (mode === "auto") {
        hls.currentLevel = -1;
        const capIndex = hls.levels.reduce((bestIndex, level, index) => {
          if (!Number.isFinite(networkProfile.maxHeight) || (level.height || 0) <= networkProfile.maxHeight) {
            return index;
          }
          return bestIndex;
        }, -1);
        hls.autoLevelCapping = capIndex;
        return;
      }

      if (mode.startsWith("hls-")) {
        const level = Number(mode.replace("hls-", ""));
        hls.currentLevel = level;
        hls.nextLevel = level;
        hls.loadLevel = level;
      }
    }, []);

    const applyShakaQuality = useCallback((player: shaka.Player, mode: QualityMode) => {
      const playerWithTracks = player as shaka.Player & {
        getVariantTracks: () => Array<{ id: number; height?: number; bandwidth?: number }>;
        selectVariantTrack: (track: { id: number }, clearBuffer?: boolean) => void;
      };
      const networkProfile = getNetworkProfile();

      player.configure({
        abr: {
          enabled: mode === "auto",
          restrictions: {
            maxHeight: Number.isFinite(networkProfile.maxHeight) ? networkProfile.maxHeight : Infinity
          }
        }
      });

      if (mode.startsWith("shaka-")) {
        const id = Number(mode.replace("shaka-", ""));
        const track = playerWithTracks.getVariantTracks().find((item) => item.id === id);
        if (track) {
          playerWithTracks.selectVariantTrack(track, true);
        }
      }
    }, []);

    useEffect(() => {
      if (hlsRef.current) {
        applyHlsQuality(hlsRef.current, qualityMode);
      }

      if (shakaRef.current) {
        applyShakaQuality(shakaRef.current, qualityMode);
      }
    }, [applyHlsQuality, applyShakaQuality, qualityMode]);

    const scheduleRetry = useCallback(
      (attempt: number, reason: string) => {
        clearWatchdog();
        clearRetryTimer();

        if (attempt >= maxRetries) {
          setStatus("error");
          setIsSwitching(false);
          setError(`Playback failed after proxy and engine retries: ${reason}`);
          logPlayer("failed", { reason, attempts: attempt + 1 });
          return;
        }

        const nextAttempt = attempt + 1;
        reconnectAttemptsRef.current += 1;
        setReconnectAttempts(reconnectAttemptsRef.current);
        setStatus("buffering");
        setError(`Retry ${nextAttempt}/${maxRetries}: ${reason}`);
        logPlayer("retry", { attempt: nextAttempt, reason });

        retryTimerRef.current = window.setTimeout(() => {
          loadStreamRef.current(nextAttempt);
        }, Math.min(3000, 650 + nextAttempt * 450));
      },
      [clearRetryTimer, clearWatchdog, maxRetries]
    );

    const loadHls = useCallback(
      (video: HTMLVideoElement, playbackUrl: string, loadId: number, fail: (reason: string) => void) => {
        if (!Hls.isSupported()) {
          fail("HLS.js is not supported in this browser");
          return;
        }

        const hls = new Hls(HLS_CONFIG);

        hls.on(Hls.Events.MEDIA_ATTACHED, () => {
          logPlayer("hls-attached", { playbackUrl });
          hls.loadSource(playbackUrl);
        });

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (loadIdRef.current !== loadId) return;
          const levels = hls.levels.map<QualityOption>((level, index) => ({
            id: `hls-${index}`,
            label: `${level.height || "Auto"}p${level.bitrate ? ` / ${Math.round(level.bitrate / 1000)} kbps` : ""}`,
            bitrateKbps: level.bitrate ? Math.round(level.bitrate / 1000) : null,
            height: level.height || null
          }));

          setQualityOptions([{ id: "auto", label: "Auto", bitrateKbps: null, height: null }, ...levels]);
          applyHlsQuality(hls, qualityMode);
          logPlayer("hls-manifest", { levels: hls.levels.length, quality: qualityMode });
          void safePlay(video).catch((playError) => fail(playError instanceof Error ? playError.message : "play rejected"));
        });

        hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
          const level = hls.levels[data.level];
          setBitrateKbps(level?.bitrate ? Math.round(level.bitrate / 1000) : null);
        });

        hls.on(Hls.Events.FRAG_BUFFERED, () => {
          if (loadIdRef.current !== loadId) return;
          lastProgressAtRef.current = Date.now();
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          logPlayer("hls-error", {
            type: data.type,
            details: data.details,
            fatal: data.fatal,
            response: data.response
          });

          if (String(data.details || "").includes("buffer")) {
            recoverStall(loadId, String(data.details), fail);
          }

          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            try {
              hls.startLoad(-1);
              return;
            } catch {
              // fall through to retry
            }
          }

          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            try {
              hls.recoverMediaError();
              hls.startLoad(-1);
              return;
            } catch {
              // fall through to retry
            }
          }

          if (data.fatal) {
            fail(data.details || "fatal HLS.js error");
          }
        });

        hls.attachMedia(video);
        hlsRef.current = hls;
      },
      [applyHlsQuality, qualityMode, recoverStall, safePlay]
    );

    const loadMpegTs = useCallback(
      (video: HTMLVideoElement, playbackUrl: string, fail: (reason: string) => void) => {
        if (!mpegts.isSupported()) {
          fail("MPEGTS.js is not supported in this browser");
          return;
        }

        setQualityOptions([{ id: "auto", label: "Source", bitrateKbps: null, height: null }]);
        setQualityMode("auto");

        const player = mpegts.createPlayer(
          {
            type: "mpegts",
            isLive: true,
            cors: false,
            url: playbackUrl
          },
          MPEGTS_CONFIG
        );

        player.on(mpegts.Events.ERROR, (type: string, detail: string, info: unknown) => {
          logPlayer("mpegts-error", { type, detail, info });
          fail(detail || type || "MPEGTS.js error");
        });

        player.on(mpegts.Events.MEDIA_INFO, (mediaInfo: { videoDataRate?: number; width?: number; height?: number }) => {
          if (mediaInfo.videoDataRate) {
            setBitrateKbps(Math.round(mediaInfo.videoDataRate));
          }
          if (mediaInfo.width && mediaInfo.height) {
            setResolution(`${mediaInfo.width}x${mediaInfo.height}`);
          }
          logPlayer("mpegts-media-info", { mediaInfo });
        });

        player.on(mpegts.Events.LOADING_COMPLETE, () => {
          fail("MPEGTS stream ended");
        });

        player.attachMediaElement(video);
        player.load();
        void safePlay(video).catch((playError) => {
          fail(playError instanceof Error ? playError.message : "play rejected");
        });
        mpegtsRef.current = player;
      },
      [safePlay]
    );

    const loadShaka = useCallback(
      async (video: HTMLVideoElement, playbackUrl: string, fail: (reason: string) => void) => {
        shaka.polyfill.installAll();

        if (!shaka.Player.isBrowserSupported()) {
          fail("Shaka Player is not supported in this browser");
          return;
        }

        const player = new shaka.Player(video);
        const networkProfile = getNetworkProfile();

        player.configure({
          streaming: {
            bufferingGoal: 60,
            rebufferingGoal: 2,
            bufferBehind: 90,
            lowLatencyMode: false,
            retryParameters: {
              timeout: 18000,
              maxAttempts: 10,
              baseDelay: 1000,
              backoffFactor: 1.4,
              fuzzFactor: 0.25
            }
          },
          abr: {
            enabled: qualityMode === "auto",
            restrictions: {
              maxHeight: Number.isFinite(networkProfile.maxHeight) ? networkProfile.maxHeight : Infinity
            }
          }
        });

        player.addEventListener("error", (event: Event) => {
          const detail = (event as CustomEvent).detail;
          logPlayer("shaka-error", { detail });
          if (detail?.severity === shaka.util.Error.Severity.RECOVERABLE) {
            (player as shaka.Player & { retryStreaming?: () => void }).retryStreaming?.();
            return;
          }
          fail(detail?.message || detail?.code || "Shaka Player error");
        });

        player.getNetworkingEngine()?.registerRequestFilter((_type, request) => {
          request.uris = request.uris.map((uri) => {
            if (/^\/proxy\?url=/.test(uri)) return new URL(uri, window.location.origin).toString();
            if (/^https?:\/\//i.test(uri)) {
              const proxyUrl = new URL("/proxy", window.location.origin);
              proxyUrl.searchParams.set("url", uri);
              return proxyUrl.toString();
            }
            return uri;
          });
        });

        shakaRef.current = player;
        await player.load(playbackUrl);

        const playerWithTracks = player as shaka.Player & {
          getVariantTracks: () => Array<{ id: number; height?: number; bandwidth?: number; active?: boolean }>;
        };
        const tracks = playerWithTracks.getVariantTracks();
        const qualityTracks = tracks.map<QualityOption>((track) => ({
          id: `shaka-${track.id}`,
          label: `${track.height || "Auto"}p${track.bandwidth ? ` / ${Math.round(track.bandwidth / 1000)} kbps` : ""}`,
          bitrateKbps: track.bandwidth ? Math.round(track.bandwidth / 1000) : null,
          height: track.height || null
        }));

        setQualityOptions([{ id: "auto", label: "Auto", bitrateKbps: null, height: null }, ...qualityTracks]);
        applyShakaQuality(player, qualityMode);
        await safePlay(video);
      },
      [applyShakaQuality, qualityMode, safePlay]
    );

    const loadStream = useCallback(
      async (attempt = 0) => {
        const video = videoRef.current;

        if (!video || !sourceUrl) {
          destroyPlayer(true);
          setStatus("idle");
          setError("");
          engineLabelValueRef.current = null;
          setEngineLabel(null);
          bitrateKbpsValueRef.current = null;
          setBitrateKbps(null);
          setIsSwitching(false);
          return;
        }

        const loadId = loadIdRef.current + 1;
        loadIdRef.current = loadId;
        destroyPlayer(false);

        const playbackUrl = buildAttemptUrl(sourceUrl, attempt);
        const controller = new AbortController();
        abortControllerRef.current = controller;
        setError("");
        setStatus("loading");
        setIsSwitching(true);
        bitrateKbpsValueRef.current = null;
        setBitrateKbps(null);
        setResolution("Unknown");
        setQualityOptions([{ id: "auto", label: "Auto", bitrateKbps: null, height: null }]);

        if (attempt === 0) {
          reconnectAttemptsRef.current = 0;
          stallCountRef.current = 0;
          setReconnectAttempts(0);
          setStallCount(0);
        }

        const fail = (reason: string) => {
          if (loadIdRef.current !== loadId) return;
          scheduleRetry(attempt, reason);
        };

        setupMediaListeners(video, loadId, fail);

        try {
          const probe = await probeBeforePlayback(playbackUrl, controller.signal);
          const selectedEngine = engineFromUrl(playbackUrl) || engineFromContentType(probe.contentType);

          if (!selectedEngine) {
            fail("no strict playback engine matched this stream URL/content-type");
            return;
          }

          const engineName = selectedEngine.toUpperCase();
          engineLabelValueRef.current = engineName;
          setEngineLabel(engineName);
          logPlayer("engine", {
            engine: selectedEngine,
            playbackUrl,
            providerUrl: extractProviderUrl(playbackUrl),
            contentType: probe.contentType,
            attempt
          });

          startWatchdog(loadId, fail);

          if (selectedEngine === "hls") {
            loadHls(video, playbackUrl, loadId, fail);
            return;
          }

          if (selectedEngine === "mpegts") {
            loadMpegTs(video, playbackUrl, fail);
            return;
          }

          await loadShaka(video, playbackUrl, fail);
        } catch (loadError) {
          if (controller.signal.aborted || loadIdRef.current !== loadId) return;
          fail(loadError instanceof Error ? loadError.message : "playback setup failed");
        }
      },
      [
        destroyPlayer,
        loadHls,
        loadMpegTs,
        loadShaka,
        probeBeforePlayback,
        scheduleRetry,
        setupMediaListeners,
        sourceUrl,
        startWatchdog
      ]
    );

    useEffect(() => {
      loadStreamRef.current = (attempt = 0) => {
        void loadStream(attempt);
      };
    }, [loadStream]);

    useImperativeHandle(
      ref,
      () => ({
        reload: () => {
          void loadStream(0);
        },
        toggleFullscreen: () => {
          const video = videoRef.current;
          if (!video) return;

          if (document.fullscreenElement) {
            void document.exitFullscreen();
          } else {
            void video.requestFullscreen();
          }
        }
      }),
      [loadStream]
    );

    useEffect(() => {
      void loadStream(0);

      return () => {
        loadIdRef.current += 1;
        destroyPlayer(true);
        releaseWakeLock();
      };
    }, [sourceUrl]);

    useEffect(() => {
      preloadControllerRef.current?.abort();
      preloadControllerRef.current = null;

      if (!preloadUrl || mini) {
        return;
      }

      const controller = new AbortController();
      preloadControllerRef.current = controller;
      const playbackUrl = buildAttemptUrl(preloadUrl, 0);

      window.setTimeout(() => {
        if (controller.signal.aborted) return;
        void fetch(buildProbeUrl(playbackUrl), { signal: controller.signal })
          .then(() => logPlayer("preload-next", { playbackUrl }))
          .catch(() => undefined);
      }, 350);

      return () => controller.abort();
    }, [mini, preloadUrl]);

    useEffect(() => {
      if (!("mediaSession" in navigator)) {
        return;
      }

      navigator.mediaSession.metadata = new MediaMetadata({
        title,
        artist: engineLabel ? `${engineLabel} IPTV` : "IPTV",
        album: "CHECKER IPTV",
        artwork: logoUrl
          ? [
              { src: logoUrl, sizes: "96x96", type: "image/png" },
              { src: logoUrl, sizes: "512x512", type: "image/png" }
            ]
          : []
      });

      navigator.mediaSession.setActionHandler("play", () => {
        const video = videoRef.current;
        if (video) void safePlay(video).catch(() => undefined);
      });
      navigator.mediaSession.setActionHandler("pause", () => videoRef.current?.pause());
      navigator.mediaSession.setActionHandler("previoustrack", onPrevious || null);
      navigator.mediaSession.setActionHandler("nexttrack", onNext || null);

      return () => {
        navigator.mediaSession.setActionHandler("play", null);
        navigator.mediaSession.setActionHandler("pause", null);
        navigator.mediaSession.setActionHandler("previoustrack", null);
        navigator.mediaSession.setActionHandler("nexttrack", null);
      };
    }, [engineLabel, logoUrl, onNext, onPrevious, safePlay, title]);

    const togglePlay = useCallback(() => {
      const video = videoRef.current;
      if (!video) return;

      if (video.paused) {
        void safePlay(video).catch((playError) => {
          setError(playError instanceof Error ? playError.message : "Play request failed.");
        });
      } else {
        video.pause();
      }
    }, [safePlay]);

    const togglePictureInPicture = useCallback(async () => {
      const video = videoRef.current;
      if (!video || !document.pictureInPictureEnabled) {
        return;
      }

      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else {
          await video.requestPictureInPicture();
        }
      } catch (pipError) {
        setError(pipError instanceof Error ? pipError.message : "Picture-in-picture unavailable.");
      }
    }, []);

    const toggleFullscreen = useCallback(() => {
      if (document.fullscreenElement) {
        void document.exitFullscreen();
      } else {
        void videoRef.current?.requestFullscreen();
      }
    }, []);

    const seekBy = useCallback((seconds: number) => {
      const video = videoRef.current;
      if (!video) return;

      const bufferInfo = getVideoBufferInfo(video);
      const upperBound = bufferInfo.end ?? video.duration;
      const target = clamp(video.currentTime + seconds, 0, Number.isFinite(upperBound) ? upperBound : video.currentTime + seconds);
      video.currentTime = target;
      void safePlay(video).catch(() => undefined);
    }, [safePlay]);

    const handlePointerDown = useCallback(
      (event: PointerEvent<HTMLDivElement>) => {
        if (event.pointerType === "mouse") {
          setControlsVisible(true);
          return;
        }

        const rect = event.currentTarget.getBoundingClientRect();
        const relativeX = event.clientX - rect.left;
        const zone = relativeX < rect.width * 0.33 ? "left" : relativeX > rect.width * 0.66 ? "right" : "center";
        pointerStartRef.current = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          time: Date.now(),
          volume,
          brightness,
          currentTime: videoRef.current?.currentTime || 0,
          zone
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      [brightness, volume]
    );

    const handlePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
      const start = pointerStartRef.current;
      if (!start || start.id !== event.pointerId || event.pointerType === "mouse") {
        return;
      }

      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      const video = videoRef.current;

      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 18 && start.zone === "center" && video) {
        const seconds = Math.round(dx / 14);
        const bufferInfo = getVideoBufferInfo(video);
        const upperBound = bufferInfo.end ?? video.duration;
        video.currentTime = clamp(start.currentTime + seconds, 0, Number.isFinite(upperBound) ? upperBound : start.currentTime + seconds);
        setGestureHint(`${seconds > 0 ? "+" : ""}${seconds}s`);
        return;
      }

      if (Math.abs(dy) > 18 && start.zone === "right") {
        const nextVolume = clamp(start.volume - dy / 240, 0, 1);
        setVolume(nextVolume);
        setIsMuted(nextVolume <= 0.01);
        setGestureHint(`Volume ${Math.round(nextVolume * 100)}%`);
        return;
      }

      if (Math.abs(dy) > 18 && start.zone === "left") {
        const nextBrightness = clamp(start.brightness - dy / 320, 0.72, 1.35);
        setBrightness(nextBrightness);
        setGestureHint(`Brightness ${Math.round(nextBrightness * 100)}%`);
      }
    }, []);

    const handlePointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
      const start = pointerStartRef.current;
      pointerStartRef.current = null;

      if (event.pointerType === "mouse") {
        return;
      }

      const now = Date.now();
      const dx = event.clientX - (start?.x || event.clientX);
      const dy = event.clientY - (start?.y || event.clientY);
      const isTap = Math.abs(dx) < 14 && Math.abs(dy) < 14 && start && now - start.time < 260;

      if (isTap) {
        const lastTap = lastTapRef.current;
        const doubleTap = now - lastTap.at < 320 && Math.abs(event.clientX - lastTap.x) < 80;
        if (doubleTap) {
          const rect = event.currentTarget.getBoundingClientRect();
          const leftSide = event.clientX - rect.left < rect.width / 2;
          seekBy(leftSide ? -10 : 10);
          setGestureHint(leftSide ? "-10s" : "+10s");
          lastTapRef.current = { at: 0, x: 0 };
        } else {
          lastTapRef.current = { at: now, x: event.clientX };
          setControlsVisible((current) => !current);
        }
      }

      window.setTimeout(() => setGestureHint(""), 850);
    }, [seekBy]);

    const videoFilter = `saturate(1.1) contrast(1.05) brightness(${brightness})`;

    return (
      <div
        className={`iptv-player-shell overflow-hidden border border-white/10 bg-black/45 shadow-[0_28px_100px_rgba(0,0,0,0.45)] backdrop-blur-2xl ${
          mini ? "rounded-lg" : "rounded-xl"
        }`}
      >
        <div
          className="group/player relative touch-none overflow-hidden bg-black"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={() => {
            pointerStartRef.current = null;
            setGestureHint("");
          }}
          onMouseMove={() => setControlsVisible(true)}
          onMouseLeave={() => setControlsVisible(false)}
        >
          <video
            ref={videoRef}
            className={`iptv-video w-full bg-black object-contain transition-opacity duration-300 ${
              mini ? "aspect-video" : "aspect-video min-h-[340px] xl:min-h-[520px]"
            } ${isSwitching ? "opacity-75" : "opacity-100"}`}
            style={{ filter: videoFilter }}
            controls={false}
            playsInline
            preload="auto"
            muted={isMuted}
            crossOrigin="anonymous"
          />

          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/20" />

          {isSwitching ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/10">
              <div className="rounded-full border border-white/10 bg-black/55 p-4 text-white shadow-neon backdrop-blur-xl">
                <LoaderCircle className="h-7 w-7 animate-spin" />
              </div>
            </div>
          ) : null}

          {gestureHint ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="rounded-full border border-white/15 bg-black/65 px-5 py-3 font-mono text-xs uppercase tracking-[0.2em] text-white shadow-neon backdrop-blur-xl">
                {gestureHint}
              </div>
            </div>
          ) : null}

          <div className="absolute left-4 top-4 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/55 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.18em] text-white backdrop-blur-xl">
              <span className={`h-2 w-2 rounded-full ${status === "playing" ? "bg-neon-green" : status === "error" ? "bg-neon-red" : "bg-neon-amber"}`} />
              {status}
            </span>
            <span className="rounded-full border border-neon-red/30 bg-neon-red/10 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.18em] text-neon-red">
              Live
            </span>
            {engineLabel ? (
              <span className="rounded-full border border-white/10 bg-black/55 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.18em] text-neon-green backdrop-blur-xl">
                {engineLabel}
              </span>
            ) : null}
            {bitrateKbps ? (
              <span className="rounded-full border border-white/10 bg-black/55 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.18em] text-neon-cyan backdrop-blur-xl">
                {bitrateKbps} kbps
              </span>
            ) : null}
          </div>

          {!mini ? (
            <div className="absolute right-4 top-4 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowStats((current) => !current)}
                className="rounded-full border border-white/10 bg-black/55 p-2 text-slate-100 backdrop-blur-xl transition hover:border-neon-cyan/40 hover:text-neon-cyan"
                aria-label="Toggle playback statistics"
              >
                <BarChart3 className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setShowSettings((current) => !current)}
                className="rounded-full border border-white/10 bg-black/55 p-2 text-slate-100 backdrop-blur-xl transition hover:border-neon-cyan/40 hover:text-neon-cyan"
                aria-label="Open player settings"
              >
                <Settings className="h-4 w-4" />
              </button>
            </div>
          ) : null}

          {showStats && !mini ? (
            <div className="absolute right-4 top-16 min-w-[260px] max-w-[320px] rounded-lg border border-white/10 bg-black/70 p-3 font-mono text-[11px] uppercase tracking-[0.12em] text-slate-300 shadow-glow backdrop-blur-2xl">
              <div className="mb-2 flex items-center justify-between text-neon-cyan">
                <span>Stats for nerds</span>
                <Activity className="h-4 w-4" />
              </div>
              {[
                ["Engine", engineLabel || "Detecting"],
                ["Resolution", resolution],
                ["Bitrate", bitrateKbps ? `${bitrateKbps} kbps` : "Auto"],
                ["FPS", fps ? String(fps) : "0"],
                ["Dropped", String(droppedFrames)],
                ["Buffer", `${bufferSeconds.toFixed(1)}s`],
                ["Live edge", `${liveLatency.toFixed(1)}s`],
                ["Network", networkKbps ? `${networkKbps} kbps` : "Unknown"],
                ["Reconnects", String(reconnectAttempts)],
                ["Stalls", String(stallCount)],
                ["Quality", qualityLabel]
              ].map(([label, value]) => (
                <div key={label} className="flex items-center justify-between gap-4 border-t border-white/8 py-1.5">
                  <span className="text-slate-500">{label}</span>
                  <span className="text-right text-white">{value}</span>
                </div>
              ))}
            </div>
          ) : null}

          {showSettings && !mini ? (
            <div className="absolute right-4 top-16 w-[280px] rounded-lg border border-white/10 bg-black/72 p-3 shadow-glow backdrop-blur-2xl">
              <div className="mb-3 flex items-center justify-between gap-3">
                <p className="font-mono text-xs uppercase tracking-[0.18em] text-neon-cyan">Quality</p>
                <Gauge className="h-4 w-4 text-neon-cyan" />
              </div>
              <div className="grid max-h-56 gap-2 overflow-y-auto pr-1">
                {qualityOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setQualityMode(option.id)}
                    className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-left font-mono text-[11px] uppercase tracking-[0.12em] transition ${
                      qualityMode === option.id
                        ? "border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan"
                        : "border-white/10 bg-white/[0.04] text-slate-300 hover:border-white/20"
                    }`}
                  >
                    <span>{option.label}</span>
                    {option.height ? <span className="text-slate-500">{option.height}p</span> : null}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div
            className={`absolute inset-x-0 bottom-0 transition duration-300 ${
              controlsVisible || status !== "playing" ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
            }`}
          >
            <div className="bg-gradient-to-t from-black via-black/70 to-transparent px-4 pb-4 pt-16">
              <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-neon-cyan via-neon-green to-neon-amber transition-all"
                  style={{ width: `${clamp((bufferSeconds / 60) * 100, 3, 100)}%` }}
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-display text-sm text-white">{title}</p>
                  {error ? <p className="mt-1 font-mono text-xs text-neon-red">{error}</p> : null}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {onPrevious ? (
                    <button
                      type="button"
                      onClick={onPrevious}
                      className="rounded-full border border-white/10 bg-white/[0.06] p-2 text-slate-100 transition hover:border-neon-cyan/40 hover:text-neon-cyan"
                      aria-label="Previous channel"
                    >
                      <SkipBack className="h-4 w-4" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => seekBy(-10)}
                    className="rounded-full border border-white/10 bg-white/[0.06] p-2 text-slate-100 transition hover:border-neon-cyan/40 hover:text-neon-cyan"
                    aria-label="Seek backward"
                  >
                    <ChevronDown className="h-4 w-4 rotate-90" />
                  </button>
                  <button
                    type="button"
                    onClick={togglePlay}
                    className="rounded-full border border-neon-cyan/40 bg-neon-cyan/10 p-3 text-neon-cyan shadow-neon transition hover:bg-neon-cyan/20"
                    aria-label="Play or pause"
                  >
                    {isPaused ? <Play className="h-5 w-5" /> : <Pause className="h-5 w-5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => seekBy(10)}
                    className="rounded-full border border-white/10 bg-white/[0.06] p-2 text-slate-100 transition hover:border-neon-cyan/40 hover:text-neon-cyan"
                    aria-label="Seek forward"
                  >
                    <ChevronUp className="h-4 w-4 rotate-90" />
                  </button>
                  {onNext ? (
                    <button
                      type="button"
                      onClick={onNext}
                      className="rounded-full border border-white/10 bg-white/[0.06] p-2 text-slate-100 transition hover:border-neon-cyan/40 hover:text-neon-cyan"
                      aria-label="Next channel"
                    >
                      <SkipForward className="h-4 w-4" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void loadStream(0)}
                    className="rounded-full border border-white/10 bg-white/[0.06] p-2 text-slate-100 transition hover:border-neon-cyan/40 hover:text-neon-cyan"
                    aria-label="Reload stream"
                  >
                    <RefreshCcw className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsMuted((current) => !current)}
                    className="rounded-full border border-white/10 bg-white/[0.06] p-2 text-slate-100 transition hover:border-neon-cyan/40 hover:text-neon-cyan"
                    aria-label="Mute stream"
                  >
                    {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                  </button>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={volume}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      setVolume(next);
                      setIsMuted(next <= 0.01);
                    }}
                    className="h-2 w-24 accent-[#12D9FF]"
                    aria-label="Volume"
                  />
                  {!mini ? (
                    <>
                      <button
                        type="button"
                        onClick={togglePictureInPicture}
                        className="rounded-full border border-white/10 bg-white/[0.06] p-2 text-slate-100 transition hover:border-neon-cyan/40 hover:text-neon-cyan"
                        aria-label="Picture in picture"
                      >
                        <PictureInPicture className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={toggleFullscreen}
                        className="rounded-full border border-white/10 bg-white/[0.06] p-2 text-slate-100 transition hover:border-neon-cyan/40 hover:text-neon-cyan"
                        aria-label="Fullscreen"
                      >
                        <Expand className="h-4 w-4" />
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
);
