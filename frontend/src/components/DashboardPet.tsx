"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { Printer } from "@/lib/types";

const STORAGE_HIDE = "printfarm_dashboard_pet_hidden";

/** Швидкість наближення до цілі (експонента за секунду); менше — повільніше. */
const SMOOTH_LAMBDA = 0.9;
const ARRIVE_EPS = 0.6;
/** Як часто обирати нову ціль (мс) — більше, щоб встигав доповзти повільним ходом. */
const PICK_TARGET_MS = 5200;

/** Лише «потрібна увага»: прапорці SP/AI та помилка друку — без очистки столу, обслуговування, паузи як такої. */
function needsAttentionPrinterIds(printers: Printer[]): number[] {
  const ids: number[] = [];
  for (const p of printers) {
    if (!p.is_active) continue;
    const flags = p.flags ?? [];
    if (flags.includes("requires_attention")) {
      ids.push(p.id);
      continue;
    }
    if (flags.includes("ai_detected_high") || flags.includes("ai_detected_low")) {
      ids.push(p.id);
      continue;
    }
    if (p.state === "error") ids.push(p.id);
  }
  return ids;
}

function cardCenter(id: number): { x: number; y: number } | null {
  const el = document.querySelector<HTMLElement>(`[data-printer-id="${id}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 8 || r.height < 8) return null;
  return {
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
  };
}

/** Власний простий піксельний маскот (не копія Claude Code). */
function PixelSprite({ flip }: { flip: boolean }) {
  return (
    <svg
      width={28}
      height={28}
      viewBox="0 0 14 14"
      shapeRendering="crispEdges"
      className={flip ? "scale-x-[-1]" : ""}
      style={{ imageRendering: "pixelated" }}
      aria-hidden
    >
      <rect x="4" y="6" width="6" height="6" fill="#6366f1" />
      <rect x="3" y="7" width="1" height="4" fill="#6366f1" />
      <rect x="10" y="7" width="1" height="4" fill="#6366f1" />
      <rect x="4" y="2" width="6" height="4" fill="#818cf8" />
      <rect x="3" y="3" width="1" height="2" fill="#818cf8" />
      <rect x="10" y="3" width="1" height="2" fill="#818cf8" />
      <rect x="5" y="3" width="1" height="1" fill="#0f172a" className="dark:fill-white" />
      <rect x="8" y="3" width="1" height="1" fill="#0f172a" className="dark:fill-white" />
      <rect x="6" y="0" width="2" height="2" fill="#f472b6" />
      <rect x="7" y="1" width="1" height="1" fill="#fbbf24" />
    </svg>
  );
}

export function DashboardPet({ printers }: { printers: Printer[] }) {
  const [hidden, setHidden] = useState(false);
  const [renderPos, setRenderPos] = useState({ x: 80, y: 140 });
  const [flip, setFlip] = useState(false);
  const pos = useRef({ x: 80, y: 140 });
  const target = useRef({ x: 200, y: 200 });
  const targetId = useRef<number | null>(null);
  const idx = useRef(0);
  const lastFlip = useRef(false);

  useEffect(() => {
    try {
      setHidden(localStorage.getItem(STORAGE_HIDE) === "1");
    } catch {
      /* ignore */
    }
  }, []);

  const pickTarget = useCallback(() => {
    const ids = needsAttentionPrinterIds(printers);
    if (ids.length === 0) {
      targetId.current = null;
      const w = window.innerWidth;
      const h = window.innerHeight;
      target.current = {
        x: Math.round(48 + Math.random() * (w - 120)),
        y: Math.round(80 + Math.random() * (h - 200)),
      };
      return;
    }
    idx.current = (idx.current + 1) % ids.length;
    const id = ids[idx.current];
    targetId.current = id;
    const c = cardCenter(id);
    if (c) target.current = { x: c.x, y: c.y };
  }, [printers]);

  useEffect(() => {
    pickTarget();
    const interval = window.setInterval(pickTarget, PICK_TARGET_MS);
    return () => window.clearInterval(interval);
  }, [pickTarget]);

  useEffect(() => {
    const syncCard = () => {
      if (targetId.current != null) {
        const c = cardCenter(targetId.current);
        if (c) target.current = { x: c.x, y: c.y };
      }
    };
    window.addEventListener("scroll", syncCard, true);
    window.addEventListener("resize", syncCard);
    return () => {
      window.removeEventListener("scroll", syncCard, true);
      window.removeEventListener("resize", syncCard);
    };
  }, []);

  useEffect(() => {
    if (hidden) return;
    const w = typeof window !== "undefined" ? window.innerWidth : 400;
    pos.current = { x: Math.round(w - 100), y: 140 };
    setRenderPos({ x: pos.current.x, y: pos.current.y });

    let raf = 0;
    let lastT = performance.now();
    function step(now: number) {
      const dt = Math.min(48, now - lastT) / 1000;
      lastT = now;

      const p = pos.current;
      const t = target.current;
      let dx = t.x - p.x;
      let dy = t.y - p.y;
      const dist = Math.hypot(dx, dy);

      if (dist < ARRIVE_EPS) {
        p.x = t.x;
        p.y = t.y;
      } else {
        const k = 1 - Math.exp(-SMOOTH_LAMBDA * dt);
        p.x += dx * k;
        p.y += dy * k;
      }

      dx = t.x - p.x;
      if (Math.abs(dx) > 6) {
        const nf = dx < 0;
        if (nf !== lastFlip.current) {
          lastFlip.current = nf;
          setFlip(nf);
        }
      }

      setRenderPos({ x: Math.round(p.x), y: Math.round(p.y) });
      raf = requestAnimationFrame(step);
    }
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [hidden, printers]);

  function hide() {
    setHidden(true);
    try {
      localStorage.setItem(STORAGE_HIDE, "1");
    } catch {
      /* ignore */
    }
  }

  if (hidden) return null;
  if (printers.length === 0) return null;

  const hasAttention = needsAttentionPrinterIds(printers).length > 0;
  const { x, y } = renderPos;

  return (
    <div
      className="pointer-events-none fixed z-[35] select-none"
      style={{ left: x - 14, top: y - 14 }}
      aria-hidden
    >
      <div className="pointer-events-auto relative flex flex-col items-center">
        <button
          type="button"
          onClick={hide}
          className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full border border-neutral-300 bg-white text-[10px] text-neutral-500 shadow hover:bg-neutral-100 dark:border-neutral-600 dark:bg-neutral-900 dark:hover:bg-neutral-800"
          title="Приховати помічника"
        >
          ×
        </button>
        <div className="rounded-md border border-indigo-200 bg-white/90 p-0.5 shadow-lg backdrop-blur-sm dark:border-indigo-800 dark:bg-neutral-900/90">
          <PixelSprite flip={flip} />
        </div>
        {hasAttention && (
          <span className="mt-0.5 max-w-[100px] truncate rounded bg-amber-100 px-1 py-0.5 text-[9px] font-medium text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
            увага
          </span>
        )}
      </div>
    </div>
  );
}
