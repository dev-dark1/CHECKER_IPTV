import type { ReactNode } from "react";

interface GlassPanelProps {
  eyebrow: string;
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function GlassPanel({ eyebrow, title, action, children, className = "" }: GlassPanelProps) {
  return (
    <section className={`glass-panel rounded-[28px] p-6 md:p-7 ${className}`}>
      <div className="mb-5 flex flex-col gap-4 border-b border-white/10 pb-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="mb-2 text-[0.7rem] uppercase tracking-[0.35em] text-neon-cyan/75">{eyebrow}</p>
          <h2 className="font-display text-2xl text-white">{title}</h2>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
