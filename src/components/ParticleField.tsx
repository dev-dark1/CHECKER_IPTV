const PARTICLES = [
  { left: "6%", top: "12%", size: 12, delay: "0s", duration: "8s" },
  { left: "18%", top: "72%", size: 8, delay: "1s", duration: "11s" },
  { left: "28%", top: "30%", size: 14, delay: "2s", duration: "9s" },
  { left: "39%", top: "82%", size: 9, delay: "3s", duration: "12s" },
  { left: "52%", top: "24%", size: 10, delay: "1.4s", duration: "10s" },
  { left: "61%", top: "66%", size: 16, delay: "2.5s", duration: "13s" },
  { left: "74%", top: "18%", size: 8, delay: "0.8s", duration: "8.5s" },
  { left: "86%", top: "76%", size: 11, delay: "2.2s", duration: "10.5s" },
  { left: "91%", top: "42%", size: 7, delay: "1.8s", duration: "7.5s" }
];

export function ParticleField() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute -top-24 left-1/2 h-80 w-80 -translate-x-1/2 rounded-full bg-neon-cyan/20 blur-3xl" />
      <div className="absolute left-[8%] top-[32%] h-56 w-56 rounded-full bg-neon-green/10 blur-3xl" />
      <div className="absolute bottom-[8%] right-[8%] h-64 w-64 rounded-full bg-[#5d4dff]/10 blur-3xl" />
      {PARTICLES.map((particle) => (
        <span
          key={`${particle.left}-${particle.top}`}
          className="absolute rounded-full bg-neon-cyan/40 shadow-[0_0_16px_rgba(76,242,255,0.55)]"
          style={{
            left: particle.left,
            top: particle.top,
            width: `${particle.size}px`,
            height: `${particle.size}px`,
            animation: `float ${particle.duration} ease-in-out ${particle.delay} infinite`
          }}
        />
      ))}
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:72px_72px] opacity-20" />
    </div>
  );
}
