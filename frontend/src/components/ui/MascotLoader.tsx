"use client";

import { PixelSprite } from "@/components/dashboard/DashboardPet";

/**
 * Full-screen init/loading screen with the Monofarm mascot in a "thinking" pose:
 * the pet gently floats while a thought bubble pulses animated dots above it.
 * Reuses the canonical mascot art (PixelSprite) — no duplicate sprite.
 */
export function MascotLoader({ label = "Завантаження…" }: { label?: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-[var(--bg)]">
      <style>{`
        @keyframes mascotFloat { 0%,100% { transform: translateY(0) scale(2.6); } 50% { transform: translateY(-7px) scale(2.6); } }
        @keyframes thinkDot   { 0%,70%,100% { opacity:.25; transform: translateY(0); } 35% { opacity:1; transform: translateY(-3px); } }
        @keyframes bubbleBob  { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
        @keyframes mascotShadow { 0%,100% { transform: scaleX(1); opacity:.35; } 50% { transform: scaleX(.78); opacity:.2; } }
      `}</style>

      <div className="relative flex h-32 w-40 items-end justify-center">
        {/* Thought bubble */}
        <div
          className="absolute right-6 top-0 flex items-center gap-1 rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1.5 shadow-lg"
          style={{ animation: "bubbleBob 2.6s ease-in-out infinite" }}
        >
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="size-1.5 rounded-full bg-[var(--accent)]"
              style={{ animation: `thinkDot 1.3s ease-in-out ${i * 0.2}s infinite` }}
            />
          ))}
          {/* little tails */}
          <span className="absolute -bottom-1 left-3 size-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-elevated)]" />
          <span className="absolute -bottom-2.5 left-1.5 size-1 rounded-full border border-[var(--border)] bg-[var(--bg-elevated)]" />
        </div>

        {/* Floating mascot */}
        <div className="origin-bottom" style={{ animation: "mascotFloat 2.8s ease-in-out infinite" }}>
          <PixelSprite hasAlert={false} flip={false} walkFrame={false} antOn waveFrame={false} isWaving={false} />
        </div>

        {/* Ground shadow */}
        <div
          className="absolute bottom-0 h-1.5 w-12 rounded-full bg-[var(--accent)] blur-[2px]"
          style={{ animation: "mascotShadow 2.8s ease-in-out infinite" }}
        />
      </div>

      <p className="text-sm text-[var(--text-muted)]">{label}</p>
    </div>
  );
}
