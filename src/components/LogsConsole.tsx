import { useEffect, useRef } from "react";
import type { ConsoleEntry } from "../types";

interface LogsConsoleProps {
  entries: ConsoleEntry[];
  emptyLabel: string;
}

const toneClasses = {
  info: "text-slate-200",
  success: "text-neon-green",
  error: "text-neon-red",
  warn: "text-neon-cyan"
};

export function LogsConsole({ entries, emptyLabel }: LogsConsoleProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const viewport = viewportRef.current;

    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [entries]);

  return (
    <div
      ref={viewportRef}
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      className="console-panel max-h-[360px] min-h-[260px] overflow-y-auto rounded-[24px] border border-white/10 bg-[#020611]/90 p-4 font-mono text-sm"
    >
      {entries.length === 0 ? (
        <div className="flex h-full items-center justify-center text-center text-slate-500">{emptyLabel}</div>
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => (
            <div key={entry.id} className="flex gap-3 rounded-2xl border border-white/5 bg-white/[0.02] px-4 py-3">
              <span className="mt-1 text-neon-cyan">$</span>
              <p className={`leading-6 ${toneClasses[entry.tone]}`}>{entry.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
