import { motion } from "framer-motion";
import { useDeferredValue, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { ActiveResultCard } from "../components/ActiveResultCard";
import { GlassPanel } from "../components/GlassPanel";
import { LogsConsole } from "../components/LogsConsole";
import { buildApiUrl } from "../lib/api";
import { buildSessionHeaders } from "../lib/session";
import { UploadDropzone } from "../components/UploadDropzone";
import { extractM3uLinks } from "../lib/extractM3uLinks";
import { formatMessage, translations } from "../lib/translations";
import { usePlayerStore } from "../store/usePlayerStore";
import type { CheckResult, ConsoleEntry, ExtractionSummary, Language } from "../types";

interface CheckerPageProps {
  lang: Language;
}

function createLog(tone: ConsoleEntry["tone"], text: string): ConsoleEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    tone,
    text
  };
}

function downloadTextFile(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function downloadJsonFile(payload: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json;charset=utf-8"
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function buildPlaylistExport(urls: string[]) {
  return `#EXTM3U\n${urls
    .map((url, index) => `#EXTINF:-1 tvg-id=\"active-${index + 1}\" group-title=\"Active Links\",Active Link ${index + 1}\n${url}`)
    .join("\n")}`;
}

export function CheckerPage({ lang }: CheckerPageProps) {
  const [rawText, setRawText] = useState("");
  const [lastFileName, setLastFileName] = useState("");
  const [extraction, setExtraction] = useState<ExtractionSummary>({
    links: [],
    rawMatches: 0,
    duplicatesRemoved: 0,
    invalidRemoved: 0,
    nonEmptyLineCount: 0
  });
  const [cleaningLogs, setCleaningLogs] = useState<ConsoleEntry[]>([]);
  const [runtimeLogs, setRuntimeLogs] = useState<ConsoleEntry[]>([]);
  const [results, setResults] = useState<CheckResult[]>([]);
  const [currentUrl, setCurrentUrl] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [isChecking, setIsChecking] = useState(false);
  const [healthOk, setHealthOk] = useState(false);
  const [isPending, startTransition] = useTransition();
  const deferredSearch = useDeferredValue(searchQuery);
  const abortRef = useRef<AbortController | null>(null);
  const openMiniPlayer = usePlayerStore((state) => state.openMiniPlayer);

  const t = translations[lang];

  useEffect(() => {
    const controller = new AbortController();

    void fetch(buildApiUrl("/api/health"), {
      signal: controller.signal,
      headers: buildSessionHeaders()
    })
      .then((response) => response.json())
      .then((payload) => {
        setHealthOk(Boolean(payload?.ok));
      })
      .catch(() => {
        setHealthOk(false);
      });

    return () => {
      controller.abort();
    };
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const activeResults = useMemo(
    () => results.filter((item) => item.verdict === "active"),
    [results]
  );
  const filteredResults = useMemo(
    () =>
      results.filter((item) =>
        !deferredSearch.trim()
          ? true
          : [item.url, item.checkerStatus, item.account?.status, item.stream?.status]
              .filter(Boolean)
              .join(" ")
              .toLowerCase()
              .includes(deferredSearch.trim().toLowerCase())
      ),
    [results, deferredSearch]
  );
  const resultLabels = useMemo(
    () => ({
      activeBadge: t.activeBadge,
      deadBadge: t.deadBadge,
      expiredBadge: t.expiredBadge,
      workingPlayer: t.workingPlayer,
      deadStream: t.deadStream,
      buffering: t.buffering,
      blockedStream: t.blockedStream,
      timeout: t.timeout,
      notTested: t.notTested,
      accountStatus: t.accountStatus,
      expirationDate: t.expirationDate,
      remainingDays: t.remainingDays,
      activeConnections: t.activeConnections,
      maxConnections: t.maxConnections,
      isTrial: t.isTrial,
      xtreamApi: t.xtreamApi,
      streamSample: t.streamSample,
      miniPreview: t.miniPreview,
      playerVerdict: t.playerVerdict,
      days: t.days,
      unknown: t.unknown,
      copy: t.copy,
      rawStatus: t.rawStatus,
      responseTime: t.responseTime,
      statusCode: t.statusCode,
      openPlayer: t.openPlayer,
      testPlayer: t.testPlayer,
      vlc: t.vlc,
      mx: t.mx
    }),
    [t]
  );
  const checkedCount = results.length;
  const activeCount = activeResults.length;
  const deadCount = results.filter((item) => item.verdict === "dead").length;
  const progressValue = extraction.links.length
    ? Math.min(100, Math.round((checkedCount / extraction.links.length) * 100))
    : 0;

  const statCards = [
    { label: t.statsRaw, value: extraction.rawMatches, color: "text-neon-cyan" },
    { label: t.statsClean, value: extraction.links.length, color: "text-white" },
    { label: t.statsActive, value: activeCount, color: "text-neon-green" },
    { label: t.statsDead, value: deadCount, color: "text-neon-red" },
    { label: t.statsDuplicates, value: extraction.duplicatesRemoved, color: "text-slate-200" },
    { label: t.statsInvalid, value: extraction.invalidRemoved, color: "text-slate-200" }
  ];

  const appendRuntimeLog = (entry: ConsoleEntry) => {
    setRuntimeLogs((current) => [...current, entry]);
  };

  const persistScanSummary = async (payload: Record<string, unknown>) => {
    try {
      await fetch(buildApiUrl("/api/checker/scan-history"), {
        method: "POST",
        headers: buildSessionHeaders({
          "Content-Type": "application/json"
        }),
        body: JSON.stringify(payload)
      });
    } catch {
      // analytics persistence is best-effort
    }
  };

  const persistExportEvent = async (format: string, activeUrls: string[]) => {
    try {
      await fetch(buildApiUrl("/api/checker/export"), {
        method: "POST",
        headers: buildSessionHeaders({
          "Content-Type": "application/json"
        }),
        body: JSON.stringify({
          format,
          activeCount: activeUrls.length,
          urls: activeUrls.slice(0, 50)
        })
      });
    } catch {
      // export persistence is best-effort
    }
  };

  const copyToClipboard = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      appendRuntimeLog(createLog("success", `${t.copy}: ${value}`));
    } catch {
      appendRuntimeLog(createLog("error", "Clipboard permission denied."));
    }
  };

  const exportActiveLinks = (format: "txt" | "m3u" | "m3u8" | "json" | "report") => {
    const activeUrls = activeResults.map((item) => item.url);

    if (activeUrls.length === 0) {
      return;
    }

    if (format === "json") {
      downloadJsonFile(activeResults, "active-m3u-links.json");
    } else if (format === "m3u" || format === "m3u8") {
      downloadTextFile(buildPlaylistExport(activeUrls), `active-links.${format}`);
    } else if (format === "report") {
      downloadTextFile(
        [
          "CHECKER IPTV REPORT",
          `Generated: ${new Date().toISOString()}`,
          `Active: ${activeCount}`,
          `Dead: ${deadCount}`,
          `Total: ${results.length}`,
          "",
          ...activeResults.map((item) => `${item.url} | ${item.message}`)
        ].join("\n"),
        "active-links-report.txt"
      );
    } else {
      downloadTextFile(activeUrls.join("\n"), "active-m3u-links.txt");
    }

    void persistExportEvent(format, activeUrls);
  };

  const copyAllActive = () => {
    void copyToClipboard(activeResults.map((item) => item.url).join("\n"));
  };

  const stopChecking = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsChecking(false);
    appendRuntimeLog(createLog("warn", t.logStopped));
  };

  const runRemoteChecks = async (links: string[], initialLogs: ConsoleEntry[]) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setResults([]);
    setRuntimeLogs(initialLogs);
    setIsChecking(true);
    setCurrentUrl("");

    let activeHits = 0;
    let deadHits = 0;
    const collectedResults: CheckResult[] = [];
    const concurrency = Math.min(4, links.length);

    try {
      let nextIndex = 0;

      const worker = async () => {
        while (!controller.signal.aborted) {
          const index = nextIndex;
          nextIndex += 1;

          if (index >= links.length) {
            return;
          }

          const url = links[index];
          setCurrentUrl(url);
          appendRuntimeLog(
            createLog(
              "info",
              `${formatMessage(t.logChecking, { index: index + 1, count: links.length })}: ${url}`
            )
          );

          let result: CheckResult;

          try {
            const response = await fetch(buildApiUrl("/api/check"), {
              method: "POST",
              headers: buildSessionHeaders({
                "Content-Type": "application/json"
              }),
              body: JSON.stringify({ url }),
              signal: controller.signal
            });

            result = (await response.json()) as CheckResult;
          } catch (error) {
            if (controller.signal.aborted) {
              return;
            }

            result = {
              url,
              status: "error",
              verdict: "dead",
              checkerStatus: "error",
              httpCode: null,
              timeMs: null,
              message: error instanceof Error ? error.message : "Unexpected request failure.",
              xtreamApiUrl: null,
              account: null,
              stream: {
                status: "not_tested",
                streamUrl: null,
                streamName: null,
                httpCode: null,
                contentType: null,
                responseMs: null,
                previewUrl: null,
                message: "Advanced validation was not completed."
              }
            };
          }

          collectedResults.push(result);
          setResults((current) => [...current, result]);

          if (result.verdict === "active") {
            activeHits += 1;
            appendRuntimeLog(createLog("success", `${t.logActive}: ${result.url} (${result.message})`));
          } else {
            deadHits += 1;
            appendRuntimeLog(createLog("error", `${t.logDead}: ${result.url} (${result.checkerStatus})`));
          }

          await new Promise((resolve) => window.setTimeout(resolve, 90));
        }
      };

      await Promise.all(Array.from({ length: concurrency }, () => worker()));
    } finally {
      setCurrentUrl("");
      setIsChecking(false);
      abortRef.current = null;

      if (!controller.signal.aborted) {
        appendRuntimeLog(createLog("success", formatMessage(t.logFinished, { active: activeHits })));
        void persistScanSummary({
          inputCount: links.length,
          activeCount: activeHits,
          deadCount: deadHits,
          results: collectedResults.slice(0, 100)
        });
      }
    }
  };

  const buildCleaningLogs = (summary: ExtractionSummary) => {
    const skipped = summary.duplicatesRemoved + summary.invalidRemoved;

    return [
      createLog("info", formatMessage(t.logPrepared, { count: summary.links.length })),
      createLog("warn", formatMessage(t.logSkipped, { count: skipped })),
      createLog("info", `${t.statsRaw}: ${summary.rawMatches}`),
      createLog("info", `${t.statsDuplicates}: ${summary.duplicatesRemoved}`),
      createLog("info", `${t.statsInvalid}: ${summary.invalidRemoved}`)
    ];
  };

  const cleanAndQueue = async (input: string, autoStartMessage: string) => {
    const summary = extractM3uLinks(input);
    const nextCleaningLogs = buildCleaningLogs(summary);

    startTransition(() => {
      setExtraction(summary);
      setCleaningLogs(nextCleaningLogs);
    });

    if (summary.links.length === 0) {
      setResults([]);
      setRuntimeLogs([createLog("warn", t.logEmpty)]);
      return;
    }

    const initialLogs = [
      createLog("info", autoStartMessage),
      createLog("info", formatMessage(t.logPrepared, { count: summary.links.length })),
      createLog(
        "warn",
        formatMessage(t.logSkipped, {
          count: summary.duplicatesRemoved + summary.invalidRemoved
        })
      ),
      createLog("info", t.logRemote)
    ];

    await runRemoteChecks(summary.links, initialLogs);
  };

  const handleFilePicked = async (file: File) => {
    const text = await file.text();
    setLastFileName(file.name);
    setRawText(text);
    await cleanAndQueue(text, t.autoStarted);
  };

  return (
    <motion.div
      className="grid gap-6"
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: "easeOut" }}
    >
      <header className="relative overflow-hidden border border-white/10 bg-white/[0.035] p-6 shadow-glow backdrop-blur-xl md:p-10">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(76,242,255,0.18),transparent_48%),linear-gradient(135deg,rgba(10,16,31,0.95),rgba(8,14,27,0.72))]" />
        <div className="relative flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <p className="mb-4 font-mono text-xs uppercase tracking-[0.42em] text-neon-cyan/80">{t.heroTag}</p>
            <h1 className="font-display text-4xl uppercase leading-tight text-white md:text-6xl">{t.heroTitle}</h1>
            <p className="mt-5 max-w-2xl text-base leading-8 text-slate-300 md:text-lg">{t.heroBody}</p>
            <div className="mt-6 flex flex-wrap gap-3">
              {[t.heroChipOne, t.heroChipTwo, t.heroChipThree].map((chip) => (
                <span
                  key={chip}
                  className="rounded-full border border-white/10 bg-white/[0.05] px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-slate-200"
                >
                  {chip}
                </span>
              ))}
            </div>
          </div>

          <div
            className={`inline-flex items-center gap-3 border px-4 py-3 font-mono text-xs uppercase tracking-[0.25em] ${
              healthOk
                ? "border-neon-green/30 bg-neon-green/10 text-neon-green"
                : "border-neon-red/30 bg-neon-red/10 text-neon-red"
            }`}
          >
            <span className={`h-2.5 w-2.5 rounded-full ${healthOk ? "bg-neon-green" : "bg-neon-red"}`} />
            {healthOk ? t.backendReady : t.backendDown}
          </div>
        </div>
      </header>

      <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <GlassPanel eyebrow={t.uploadEyebrow} title={t.uploadTitle}>
          <UploadDropzone
            rawText={rawText}
            lang={lang}
            hint={t.uploadHint}
            subhint={t.uploadSubhint}
            placeholder={t.inputPlaceholder}
            chooseFileLabel={t.chooseFile}
            runLabel={t.cleanAndCheck}
            fileLabel={t.lastFile}
            lastFileName={lastFileName}
            canRun={rawText.trim().length > 0}
            isBusy={isChecking || isPending}
            onFilePicked={handleFilePicked}
            onRawTextChange={setRawText}
            onRun={() => {
              void cleanAndQueue(rawText, t.pasteRun);
            }}
          />
        </GlassPanel>

        <GlassPanel eyebrow={t.cleaningEyebrow} title={t.cleaningTitle}>
          <div className="grid gap-4 md:grid-cols-2">
            {statCards.map((card) => (
              <div
                key={card.label}
                className="rounded-[22px] border border-white/8 bg-white/[0.04] px-5 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
              >
                <p className="font-mono text-[0.72rem] uppercase tracking-[0.24em] text-slate-500">{card.label}</p>
                <p className={`mt-3 font-display text-3xl ${card.color}`}>{card.value}</p>
              </div>
            ))}
          </div>

          <div className="mt-5 grid gap-5 lg:grid-cols-[0.95fr_1.05fr]">
            <LogsConsole entries={cleaningLogs} emptyLabel={t.noCleaned} />
            <div className="rounded-[24px] border border-white/10 bg-[#06101f]/75 p-4">
              <p className="mb-3 font-mono text-xs uppercase tracking-[0.25em] text-neon-cyan">{t.cleanedPreview}</p>
              <div className="max-h-[300px] overflow-y-auto rounded-[18px] border border-white/5 bg-black/20 p-4 font-mono text-sm leading-7 text-slate-200">
                {extraction.links.length === 0 ? (
                  <p className="text-slate-500">{t.noCleaned}</p>
                ) : (
                  extraction.links.map((link) => (
                    <p key={link} className="break-all border-b border-white/5 py-2 last:border-b-0">
                      {link}
                    </p>
                  ))
                )}
              </div>
            </div>
          </div>
        </GlassPanel>
      </div>

      <div className="grid gap-6 xl:grid-cols-[0.92fr_1.08fr]">
        <GlassPanel
          eyebrow={t.progressEyebrow}
          title={t.progressTitle}
          action={
            isChecking ? (
              <button
                type="button"
                onClick={stopChecking}
                className="rounded-full border border-neon-red/40 bg-neon-red/10 px-4 py-2 font-mono text-xs uppercase tracking-[0.24em] text-neon-red transition hover:bg-neon-red/20"
              >
                {t.stop}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  void cleanAndQueue(rawText, t.pasteRun);
                }}
                disabled={rawText.trim().length === 0}
                className="rounded-full border border-neon-cyan/40 bg-neon-cyan/10 px-4 py-2 font-mono text-xs uppercase tracking-[0.24em] text-neon-cyan transition hover:bg-neon-cyan/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t.startManual}
              </button>
            )
          }
        >
          <div className="rounded-[24px] border border-white/10 bg-black/25 p-5">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="font-mono text-xs uppercase tracking-[0.25em] text-slate-500">{t.checkingNow}</p>
                <p className="mt-2 break-all font-mono text-sm text-white">{currentUrl || t.checkingIdle}</p>
              </div>
              <div className="inline-flex items-center gap-3 rounded-full border border-white/10 bg-white/[0.04] px-4 py-3">
                <span className={`h-2.5 w-2.5 rounded-full ${isChecking ? "bg-neon-green animate-pulse" : "bg-slate-500"}`} />
                <span className="font-mono text-xs uppercase tracking-[0.24em] text-slate-200">
                  {isChecking ? t.checkingPulse : `${checkedCount}/${extraction.links.length} ${t.progressDone}`}
                </span>
              </div>
            </div>

            <div className="mt-5 overflow-hidden rounded-full border border-white/8 bg-[#071221]">
              <div className="relative h-4">
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-neon-cyan via-[#65d6ff] to-neon-green transition-all duration-500"
                  style={{ width: `${progressValue}%` }}
                />
                <div className="progress-sheen absolute inset-y-0 left-0 w-1/3 rounded-full" />
              </div>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <div className="rounded-2xl border border-neon-green/20 bg-neon-green/10 px-4 py-3">
                <p className="font-mono text-[0.72rem] uppercase tracking-[0.2em] text-neon-green/80">{t.statsActive}</p>
                <p className="mt-2 font-display text-2xl text-neon-green">{activeCount}</p>
              </div>
              <div className="rounded-2xl border border-neon-red/20 bg-neon-red/10 px-4 py-3">
                <p className="font-mono text-[0.72rem] uppercase tracking-[0.2em] text-neon-red/80">{t.statsDead}</p>
                <p className="mt-2 font-display text-2xl text-neon-red">{deadCount}</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
                <p className="font-mono text-[0.72rem] uppercase tracking-[0.2em] text-slate-500">{t.statsClean}</p>
                <p className="mt-2 font-display text-2xl text-white">{extraction.links.length}</p>
              </div>
            </div>
          </div>
        </GlassPanel>

        <GlassPanel eyebrow={t.terminalEyebrow} title={t.terminalTitle}>
          <LogsConsole entries={runtimeLogs} emptyLabel={t.checkingIdle} />
        </GlassPanel>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.08fr_0.92fr]">
        <GlassPanel
          eyebrow={t.resultsEyebrow}
          title={t.resultsTitle}
          action={
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t.searchPlaceholder}
              aria-label={t.searchPlaceholder}
              className="w-full rounded-full border border-white/10 bg-white/[0.04] px-4 py-3 font-mono text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-neon-cyan/40 md:w-80"
            />
          }
        >
          {filteredResults.length === 0 ? (
            <div className="rounded-[24px] border border-dashed border-white/10 bg-black/20 px-6 py-14 text-center">
              <p className="font-display text-2xl text-white">{t.noResults}</p>
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {filteredResults.map((item) => (
                <ActiveResultCard
                  key={item.url}
                  item={item}
                  lang={lang}
                  labels={resultLabels}
                  onCopy={(value) => {
                    void copyToClipboard(value);
                  }}
                  onOpenMiniPlayer={(result) => {
                    const sourceUrl = result.stream.streamUrl || result.stream.previewUrl;
                    if (!sourceUrl) {
                      return;
                    }
                    openMiniPlayer({
                      title: result.stream.streamName || result.url,
                      sourceUrl,
                      externalUrl: sourceUrl,
                      playlistUrl: result.url
                    });
                  }}
                />
              ))}
            </div>
          )}
        </GlassPanel>

        <GlassPanel eyebrow={t.exportEyebrow} title={t.exportTitle}>
          <div className="flex h-full flex-col justify-between gap-6">
            <div className="rounded-[24px] border border-white/10 bg-black/20 p-5">
              <p className="font-display text-3xl text-white">{activeCount}</p>
              <p className="mt-3 max-w-xl leading-7 text-slate-300">{t.exportSummary}</p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <button
                type="button"
                onClick={copyAllActive}
                disabled={activeCount === 0}
                className="rounded-[22px] border border-neon-green/40 bg-neon-green/10 px-5 py-4 text-left transition hover:bg-neon-green/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <p className="font-mono text-xs uppercase tracking-[0.24em] text-neon-green">{t.copyAll}</p>
                <p className="mt-2 text-sm text-slate-200">{activeCount} URLs</p>
              </button>

              <button
                type="button"
                onClick={() => exportActiveLinks("txt")}
                disabled={activeCount === 0}
                className="rounded-[22px] border border-neon-cyan/40 bg-neon-cyan/10 px-5 py-4 text-left transition hover:bg-neon-cyan/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <p className="font-mono text-xs uppercase tracking-[0.24em] text-neon-cyan">{t.exportTxt}</p>
                <p className="mt-2 text-sm text-slate-200">active-m3u-links.txt</p>
              </button>

              <button
                type="button"
                onClick={() => exportActiveLinks("m3u")}
                disabled={activeCount === 0}
                className="rounded-[22px] border border-white/10 bg-white/[0.05] px-5 py-4 text-left transition hover:border-neon-cyan/30 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <p className="font-mono text-xs uppercase tracking-[0.24em] text-slate-200">Export M3U</p>
                <p className="mt-2 text-sm text-slate-400">active-links.m3u</p>
              </button>

              <button
                type="button"
                onClick={() => exportActiveLinks("m3u8")}
                disabled={activeCount === 0}
                className="rounded-[22px] border border-white/10 bg-white/[0.05] px-5 py-4 text-left transition hover:border-neon-green/30 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <p className="font-mono text-xs uppercase tracking-[0.24em] text-slate-200">Export M3U8</p>
                <p className="mt-2 text-sm text-slate-400">active-links.m3u8</p>
              </button>

              <button
                type="button"
                onClick={() => exportActiveLinks("json")}
                disabled={activeCount === 0}
                className="rounded-[22px] border border-white/10 bg-white/[0.05] px-5 py-4 text-left transition hover:border-neon-cyan/30 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <p className="font-mono text-xs uppercase tracking-[0.24em] text-slate-200">Export JSON</p>
                <p className="mt-2 text-sm text-slate-400">active-m3u-links.json</p>
              </button>

              <button
                type="button"
                onClick={() => exportActiveLinks("report")}
                disabled={activeCount === 0}
                className="rounded-[22px] border border-white/10 bg-white/[0.05] px-5 py-4 text-left transition hover:border-neon-cyan/30 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <p className="font-mono text-xs uppercase tracking-[0.24em] text-slate-200">Export Report</p>
                <p className="mt-2 text-sm text-slate-400">active-links-report.txt</p>
              </button>
            </div>
          </div>
        </GlassPanel>
      </div>

      <section className="glass-panel rounded-xl p-6 md:p-8">
        <div className="max-w-5xl space-y-6 text-slate-200">
          <div>
            <h2 className="font-display text-3xl text-white">Free IPTV Link Checker - Frequently Asked Questions</h2>
          </div>

          <div className="space-y-3">
            <h3 className="font-display text-xl text-white">How to Use the Free Online IPTV Checker?</h3>
            <p>Our free online IPTV link checker is the best tool to verify M3U playlists and Xtream Codes URLs. Follow these steps to test your IPTV streams:</p>
            <ol className="list-decimal space-y-2 pl-5">
              <li>Paste your IPTV links (M3U or Xtream Codes) into the text area above.</li>
              <li>Click the "SCAN ALL" button to start the real-time testing process.</li>
              <li>The tool will automatically check if each link is online, unauthorized, or invalid.</li>
              <li>Use the filter chips to view only active links and export your valid playlist.</li>
            </ol>
          </div>

          <div className="space-y-3">
            <h3 className="font-display text-xl text-white">What is an M3U Playlist & Xtream Codes?</h3>
            <p>M3U is a computer file format for a multimedia playlist. One common use of the M3U file format is creating a single-entry playlist file that points to a stream on the Internet. Xtream Codes is a popular IPTV management system that uses an API to deliver streams to users.</p>
          </div>

          <div className="space-y-3">
            <h3 className="font-display text-xl text-white">Why Use Our IPTV Stream Tester?</h3>
            <p>Using an IPTV link validator ensures that your playlist is always fresh and functional. Our tool is optimized for speed and accuracy, checking hundreds of links in seconds. It detects common errors like "Unauthorized" (bad credentials) and "Unreachable" (offline servers), saving you time and frustration.</p>
          </div>

          <div className="space-y-3">
            <h3 className="font-display text-xl text-white">Understanding IPTV Checker Results</h3>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-lg border border-white/10 bg-black/20 p-4">
                <p className="font-mono text-xs uppercase tracking-[0.18em] text-neon-green">Active:</p>
                <p className="mt-2 text-sm text-slate-300">The IPTV stream is online and working perfectly.</p>
              </div>
              <div className="rounded-lg border border-white/10 bg-black/20 p-4">
                <p className="font-mono text-xs uppercase tracking-[0.18em] text-neon-red">Unauthorized:</p>
                <p className="mt-2 text-sm text-slate-300">The username or password for the IPTV account has expired or is incorrect.</p>
              </div>
              <div className="rounded-lg border border-white/10 bg-black/20 p-4">
                <p className="font-mono text-xs uppercase tracking-[0.18em] text-neon-amber">Unreachable:</p>
                <p className="mt-2 text-sm text-slate-300">The server is currently offline or unreachable from our location.</p>
              </div>
              <div className="rounded-lg border border-white/10 bg-black/20 p-4">
                <p className="font-mono text-xs uppercase tracking-[0.18em] text-neon-cyan">Invalid:</p>
                <p className="mt-2 text-sm text-slate-300">The link format is incorrect or doesn't point to a valid IPTV playlist.</p>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="font-display text-xl text-white">Disclaimer</h3>
            <p>This free IPTV tool is for educational and diagnostic purposes only. We do not host, provide, or sell any IPTV content or subscriptions. It is the user's responsibility to ensure they have the legal right to use any IPTV links they check with this utility.</p>
          </div>

          <div className="flex flex-wrap gap-3 font-mono text-xs uppercase tracking-[0.22em] text-slate-400">
            <span>PRIVACY POLICY</span>
            <span>TERMS OF SERVICE</span>
            <span>CONTACT US</span>
          </div>

          <p className="font-mono text-xs uppercase tracking-[0.22em] text-slate-500">© 2026 IPTV LINK CHECKER. ALL RIGHTS RESERVED.</p>
        </div>
      </section>
    </motion.div>
  );
}
