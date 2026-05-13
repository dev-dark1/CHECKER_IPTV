import { useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import type { Language } from "../types";

interface UploadDropzoneProps {
  rawText: string;
  lang: Language;
  hint: string;
  subhint: string;
  placeholder: string;
  chooseFileLabel: string;
  runLabel: string;
  fileLabel: string;
  lastFileName: string;
  canRun: boolean;
  isBusy: boolean;
  onFilePicked: (file: File) => void;
  onRawTextChange: (value: string) => void;
  onRun: () => void;
}

export function UploadDropzone({
  rawText,
  lang,
  hint,
  subhint,
  placeholder,
  chooseFileLabel,
  runLabel,
  fileLabel,
  lastFileName,
  canRun,
  isBusy,
  onFilePicked,
  onRawTextChange,
  onRun
}: UploadDropzoneProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFiles = (files: FileList | null) => {
    const file = files?.[0];

    if (file) {
      onFilePicked(file);
    }
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    handleFiles(event.target.files);
    event.target.value = "";
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    handleFiles(event.dataTransfer.files);
  };

  return (
    <div className="space-y-5">
      <div
        role="button"
        tabIndex={0}
        aria-label={chooseFileLabel}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            inputRef.current?.click();
          }
        }}
        className={`group relative overflow-hidden rounded-[24px] border border-white/12 bg-white/[0.03] p-6 transition duration-300 ${
          isDragging ? "scale-[1.01] border-neon-cyan/60 shadow-neon" : "hover:border-neon-cyan/40"
        }`}
      >
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-neon-cyan/80 to-transparent opacity-80" />
        <div className="absolute inset-0 opacity-0 transition group-hover:opacity-100">
          <div className="absolute inset-y-0 left-[-25%] w-1/3 bg-gradient-to-r from-transparent via-neon-cyan/10 to-transparent animate-scan" />
        </div>
        <div className="relative flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="max-w-2xl">
            <p className="font-display text-2xl text-white">{hint}</p>
            <p className="mt-2 text-sm leading-7 text-slate-300">{subhint}</p>
            <p className="mt-4 inline-flex rounded-full border border-neon-green/30 bg-neon-green/10 px-3 py-1 font-mono text-xs text-neon-green">
              {fileLabel}: {lastFileName || "TXT"}
            </p>
          </div>

          <div className={`flex flex-wrap gap-3 ${lang === "ar" ? "md:justify-start" : "md:justify-end"}`}>
            <button
              type="button"
              className="rounded-full border border-white/15 bg-white/[0.08] px-5 py-3 font-mono text-xs uppercase tracking-[0.24em] text-white transition hover:border-neon-cyan/50 hover:text-neon-cyan"
            >
              {chooseFileLabel}
            </button>
          </div>
        </div>
        <input ref={inputRef} type="file" accept=".txt,text/plain" hidden onChange={handleChange} />
      </div>

      <div className="grid gap-4">
        <textarea
          value={rawText}
          onChange={(event) => onRawTextChange(event.target.value)}
          placeholder={placeholder}
          className="min-h-[220px] rounded-[24px] border border-white/10 bg-[#06101f]/80 p-5 font-mono text-sm leading-7 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-neon-cyan/50"
        />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-slate-400">
            `/get.php?username=` + `type=m3u`
          </p>
          <button
            type="button"
            disabled={!canRun || isBusy}
            onClick={onRun}
            className="inline-flex items-center gap-2 rounded-full border border-neon-cyan/50 bg-neon-cyan/20 px-5 py-3 font-mono text-xs uppercase tracking-[0.24em] text-neon-cyan transition hover:border-neon-cyan hover:bg-neon-cyan/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className={isBusy ? "h-2 w-2 rounded-full bg-neon-green animate-pulse" : "h-2 w-2 rounded-full bg-neon-cyan"} />
            {runLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
