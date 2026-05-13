import { ExternalLink, PlaySquare, Tv } from "lucide-react";
import { Link } from "react-router-dom";
import { buildMxUrl, buildVlcUrl } from "../lib/playerUrl";
import type { CheckResult, Language, PlayerStatus } from "../types";

interface ResultLabels {
  activeBadge: string;
  deadBadge: string;
  expiredBadge: string;
  workingPlayer: string;
  deadStream: string;
  buffering: string;
  blockedStream: string;
  timeout: string;
  notTested: string;
  accountStatus: string;
  expirationDate: string;
  remainingDays: string;
  activeConnections: string;
  maxConnections: string;
  isTrial: string;
  xtreamApi: string;
  streamSample: string;
  miniPreview: string;
  playerVerdict: string;
  days: string;
  unknown: string;
  copy: string;
  rawStatus: string;
  responseTime: string;
  statusCode: string;
  openPlayer: string;
  testPlayer: string;
  vlc: string;
  mx: string;
}

interface ActiveResultCardProps {
  item: CheckResult;
  lang: Language;
  labels: ResultLabels;
  onCopy: (value: string) => void;
  onOpenMiniPlayer: (item: CheckResult) => void;
}

const playerTone: Record<PlayerStatus, string> = {
  working_player: "border-neon-green/40 bg-neon-green/10 text-neon-green shadow-success",
  dead_stream: "border-neon-red/40 bg-neon-red/10 text-neon-red",
  buffering: "border-neon-amber/40 bg-neon-amber/10 text-neon-amber",
  blocked_stream: "border-neon-red/40 bg-neon-red/10 text-neon-red",
  timeout: "border-neon-amber/40 bg-neon-amber/10 text-neon-amber",
  expired: "border-neon-red/40 bg-neon-red/10 text-neon-red",
  not_tested: "border-white/15 bg-white/[0.04] text-slate-300"
};

function getHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function getDateLabel(value: string | null, lang: Language, fallback: string) {
  if (!value) {
    return fallback;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(lang === "ar" ? "ar-MA" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function getPlayerLabel(status: PlayerStatus, labels: ResultLabels) {
  const map: Record<PlayerStatus, string> = {
    working_player: labels.workingPlayer,
    dead_stream: labels.deadStream,
    buffering: labels.buffering,
    blocked_stream: labels.blockedStream,
    timeout: labels.timeout,
    expired: labels.expiredBadge,
    not_tested: labels.notTested
  };

  return map[status] || labels.notTested;
}

export function ActiveResultCard({
  item,
  lang,
  labels,
  onCopy,
  onOpenMiniPlayer
}: ActiveResultCardProps) {
  const account = item.account;
  const stream = item.stream;
  const host = getHost(item.url);
  const isExpired = Boolean(account?.isExpired);
  const isAccountActive = !isExpired && String(account?.status || "").toLowerCase() === "active";
  const topBadge = isExpired
    ? labels.expiredBadge
    : isAccountActive || item.verdict === "active"
      ? labels.activeBadge
      : labels.deadBadge;
  const topBadgeTone =
    isExpired || item.verdict === "dead"
      ? "border-neon-red/40 bg-neon-red/10 text-neon-red"
      : "border-neon-green/40 bg-neon-green/10 text-neon-green shadow-success";
  const playerStatus = stream?.status || "not_tested";
  const streamUrl = stream?.streamUrl || null;

  return (
    <article className="glass-panel group rounded-[24px] p-5 transition hover:-translate-y-1 hover:shadow-success">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-mono text-xs uppercase tracking-[0.24em] text-neon-cyan">{host}</p>
          <h3 className="mt-2 text-lg font-semibold text-white">
            {isExpired && account?.expDate
              ? `${labels.expiredBadge} ${getDateLabel(account.expDate, lang, labels.unknown)}`
              : isAccountActive && account?.remainingDays !== null
                ? `${labels.activeBadge} ${account?.remainingDays ?? 0} ${labels.days}`
                : topBadge}
          </h3>
        </div>
        <span className={`shrink-0 rounded-full border px-3 py-1 font-mono text-xs uppercase tracking-[0.22em] ${topBadgeTone}`}>
          {topBadge}
        </span>
      </div>

      <p className="break-all rounded-md border border-white/10 bg-black/20 px-4 py-4 font-mono text-sm leading-7 text-slate-100">
        {item.url}
      </p>

      <div className="mt-4 grid gap-3 text-sm text-slate-300 md:grid-cols-2">
        <div className="rounded-md border border-white/10 bg-white/[0.03] px-4 py-3">
          <p className="font-mono text-[0.72rem] uppercase tracking-[0.2em] text-slate-500">{labels.accountStatus}</p>
          <p className={`mt-2 font-mono ${isExpired ? "text-neon-red" : isAccountActive ? "text-neon-green" : "text-white"}`}>
            {account?.status || labels.unknown}
          </p>
        </div>
        <div className="rounded-md border border-white/10 bg-white/[0.03] px-4 py-3">
          <p className="font-mono text-[0.72rem] uppercase tracking-[0.2em] text-slate-500">{labels.expirationDate}</p>
          <p className="mt-2 font-mono text-white">{getDateLabel(account?.expDate ?? null, lang, labels.unknown)}</p>
        </div>
        <div className="rounded-md border border-white/10 bg-white/[0.03] px-4 py-3">
          <p className="font-mono text-[0.72rem] uppercase tracking-[0.2em] text-slate-500">{labels.remainingDays}</p>
          <p className={`mt-2 font-mono ${isExpired ? "text-neon-red" : "text-neon-green"}`}>
            {account?.remainingDays ?? labels.unknown}
            {typeof account?.remainingDays === "number" ? ` ${labels.days}` : ""}
          </p>
        </div>
        <div className="rounded-md border border-white/10 bg-white/[0.03] px-4 py-3">
          <p className="font-mono text-[0.72rem] uppercase tracking-[0.2em] text-slate-500">{labels.activeConnections}</p>
          <p className="mt-2 font-mono text-white">
            {account?.activeConnections ?? labels.unknown} / {account?.maxConnections ?? labels.unknown}
          </p>
        </div>
        <div className="rounded-md border border-white/10 bg-white/[0.03] px-4 py-3">
          <p className="font-mono text-[0.72rem] uppercase tracking-[0.2em] text-slate-500">{labels.isTrial}</p>
          <p className="mt-2 font-mono text-white">{account?.isTrial === null || account?.isTrial === undefined ? labels.unknown : account.isTrial ? "YES" : "NO"}</p>
        </div>
        <div className="rounded-md border border-white/10 bg-white/[0.03] px-4 py-3">
          <p className="font-mono text-[0.72rem] uppercase tracking-[0.2em] text-slate-500">{labels.rawStatus}</p>
          <p className="mt-2 font-mono text-neon-cyan">{item.checkerStatus}</p>
        </div>
      </div>

      <div className="mt-4 rounded-md border border-white/10 bg-black/20 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <p className="font-mono text-[0.72rem] uppercase tracking-[0.2em] text-slate-500">{labels.playerVerdict}</p>
          <span className={`rounded-full border px-3 py-1 font-mono text-xs uppercase tracking-[0.2em] ${playerTone[playerStatus]}`}>
            {getPlayerLabel(playerStatus, labels)}
          </span>
        </div>
        <p className="break-all font-mono text-sm leading-6 text-slate-200">{stream?.message || labels.unknown}</p>
        {stream?.streamName || stream?.streamUrl ? (
          <p className="mt-2 break-all font-mono text-xs leading-5 text-slate-500">
            {labels.streamSample}: {stream.streamName || stream.streamUrl}
          </p>
        ) : null}
        <p className="mt-2 font-mono text-xs text-slate-500">
          {labels.statusCode} {stream?.httpCode ?? item.httpCode ?? "--"} · {labels.responseTime} {stream?.responseMs ?? item.timeMs ?? "--"} ms
        </p>
      </div>

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => onCopy(item.url)}
          className="inline-flex items-center gap-2 rounded-full border border-neon-cyan/40 bg-neon-cyan/10 px-4 py-2 font-mono text-xs uppercase tracking-[0.22em] text-neon-cyan transition hover:bg-neon-cyan/20"
        >
          {labels.copy}
        </button>
        {streamUrl ? (
          <button
            type="button"
            onClick={() => onOpenMiniPlayer(item)}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-4 py-2 font-mono text-xs uppercase tracking-[0.22em] text-slate-100 transition hover:border-neon-cyan/30"
          >
            <PlaySquare className="h-4 w-4" />
            {labels.testPlayer}
          </button>
        ) : null}
        <Link
          to={`/player?source=${encodeURIComponent(item.url)}`}
          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-4 py-2 font-mono text-xs uppercase tracking-[0.22em] text-slate-100 transition hover:border-neon-green/30 hover:text-neon-green"
        >
          <Tv className="h-4 w-4" />
          {labels.openPlayer}
        </Link>
        {streamUrl ? (
          <>
            <a
              href={buildVlcUrl(streamUrl)}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-4 py-2 font-mono text-xs uppercase tracking-[0.22em] text-slate-100 transition hover:border-neon-cyan/30"
            >
              <ExternalLink className="h-4 w-4" />
              {labels.vlc}
            </a>
            <a
              href={buildMxUrl(streamUrl)}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-4 py-2 font-mono text-xs uppercase tracking-[0.22em] text-slate-100 transition hover:border-neon-green/30"
            >
              <ExternalLink className="h-4 w-4" />
              {labels.mx}
            </a>
          </>
        ) : null}
      </div>

      {item.xtreamApiUrl ? (
        <p className="mt-4 break-all rounded-md border border-white/10 bg-white/[0.03] px-4 py-3 font-mono text-xs leading-6 text-slate-400">
          {labels.xtreamApi}: {item.xtreamApiUrl}
        </p>
      ) : null}
    </article>
  );
}
