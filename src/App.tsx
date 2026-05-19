import { SignInButton, SignedIn, SignedOut, UserButton } from "@clerk/clerk-react";
import { motion } from "framer-motion";
import { Radio, SearchCheck } from "lucide-react";
import { Suspense, lazy, useEffect, useState } from "react";
import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";
import { ParticleField } from "./components/ParticleField";
import type { Language } from "./types";
import { translations } from "./lib/translations";

const CheckerPage = lazy(() =>
  import("./pages/CheckerPage").then((module) => ({ default: module.CheckerPage }))
);
const PlayerPage = lazy(() =>
  import("./pages/PlayerPage").then((module) => ({ default: module.PlayerPage }))
);
const MiniPlayerModal = lazy(() =>
  import("./components/player/MiniPlayerModal").then((module) => ({ default: module.MiniPlayerModal }))
);

export function App() {
  const [lang, setLang] = useState<Language>("en");
  const t = translations[lang];
  const clerkEnabled = Boolean(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  }, [lang]);

  return (
    <BrowserRouter>
      <div className="relative min-h-screen overflow-hidden bg-night text-slate-100">
        <ParticleField />

        <div className="relative mx-auto flex min-h-screen w-full max-w-7xl flex-col px-4 py-6 md:px-6 lg:px-8">
          <motion.header
            initial={{ opacity: 0, y: -18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: "easeOut" }}
            className="mb-6 flex flex-col gap-4 border border-white/10 bg-black/20 px-4 py-4 backdrop-blur-xl md:flex-row md:items-center md:justify-between"
          >
            <nav aria-label="Primary navigation" className="flex flex-wrap items-center gap-3">
              <NavLink
                to="/"
                end
                className={({ isActive }) =>
                  `inline-flex items-center gap-2 border px-4 py-3 font-mono text-xs uppercase tracking-[0.22em] transition ${
                    isActive
                      ? "border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan"
                      : "border-white/10 bg-white/[0.05] text-slate-100"
                  }`
                }
              >
                <SearchCheck className="h-4 w-4" />
                {t.navChecker}
              </NavLink>
              <NavLink
                to="/player"
                className={({ isActive }) =>
                  `inline-flex items-center gap-2 border px-4 py-3 font-mono text-xs uppercase tracking-[0.22em] transition ${
                    isActive
                      ? "border-neon-green/40 bg-neon-green/10 text-neon-green"
                      : "border-white/10 bg-white/[0.05] text-slate-100"
                  }`
                }
              >
                <Radio className="h-4 w-4" />
                {t.navPlayer}
              </NavLink>
            </nav>

            <div className="flex flex-wrap items-center gap-3 self-start md:self-auto">
              <div className="rounded-full border border-white/10 bg-white/[0.05] px-4 py-3 font-mono text-[11px] uppercase tracking-[0.2em] text-slate-300">
                {import.meta.env.VITE_API_BASE_URL ? "Railway API linked" : "Local API mode"}
              </div>

              {clerkEnabled ? (
                <>
                  <SignedOut>
                    <SignInButton mode="modal">
                      <button
                        type="button"
                        className="inline-flex items-center gap-3 border border-white/10 bg-white/[0.05] px-4 py-3 font-mono text-xs uppercase tracking-[0.25em] text-slate-100 transition hover:border-neon-green/40 hover:text-neon-green"
                      >
                        Sign In
                      </button>
                    </SignInButton>
                  </SignedOut>
                  <SignedIn>
                    <div className="rounded-full border border-white/10 bg-white/[0.05] p-1">
                      <UserButton afterSignOutUrl="/" />
                    </div>
                  </SignedIn>
                </>
              ) : (
                <div className="rounded-full border border-white/10 bg-white/[0.05] px-4 py-3 font-mono text-[11px] uppercase tracking-[0.2em] text-slate-400">
                  Guest mode
                </div>
              )}

              <button
                type="button"
                onClick={() => setLang(lang === "en" ? "ar" : "en")}
                className="inline-flex items-center gap-3 border border-white/10 bg-white/[0.05] px-4 py-3 font-mono text-xs uppercase tracking-[0.25em] text-slate-100 transition hover:border-neon-cyan/40 hover:text-neon-cyan"
                aria-label={`Switch language to ${t.otherLocale}`}
              >
                <span>{t.locale}</span>
                <span className="text-slate-500">/</span>
                <span className="text-slate-400">{t.otherLocale}</span>
              </button>
            </div>
          </motion.header>

          <motion.main
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: "easeOut", delay: 0.05 }}
            className="flex-1"
          >
            <Suspense
              fallback={
                <div className="flex min-h-[40vh] items-center justify-center border border-white/10 bg-black/20 font-mono text-xs uppercase tracking-[0.24em] text-neon-cyan">
                  Loading module
                </div>
              }
            >
              <Routes>
                <Route path="/" element={<CheckerPage lang={lang} />} />
                <Route path="/player" element={<PlayerPage lang={lang} />} />
              </Routes>
            </Suspense>
          </motion.main>

          <footer className="mt-8 border-t border-white/10 py-6 text-center font-mono text-xs uppercase tracking-[0.22em] text-slate-500">
            {t.footer}
          </footer>
        </div>

        <Suspense fallback={null}>
          <MiniPlayerModal />
        </Suspense>
      </div>
    </BrowserRouter>
  );
}
