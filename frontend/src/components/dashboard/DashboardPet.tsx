"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { Printer } from "@/lib/types";

const STORAGE_HIDE = "monofarm_dashboard_pet_hidden";
const SMOOTH_LAMBDA = 0.5;
const MAX_PX_PER_S = 180;
const ARRIVE_EPS = 0.6;
const PICK_TARGET_MS = 7000;

function needsAttentionPrinterIds(printers: Printer[]): number[] {
  const ids: number[] = [];
  for (const p of printers) {
    if (!p.is_active) continue;
    const flags = p.flags ?? [];
    if (flags.includes("requires_attention")) { ids.push(p.id); continue; }
    if (flags.includes("ai_detected_high") || flags.includes("ai_detected_low")) { ids.push(p.id); continue; }
    if (p.state === "error") ids.push(p.id);
  }
  return ids;
}

function cardCenter(id: number): { x: number; y: number } | null {
  const el = document.querySelector<HTMLElement>(`[data-printer-id="${id}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 8 || r.height < 8) return null;
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}

/*
  10×13 pixel grid rendered at 30×39px (3× scale).
  Two leg frames for walking animation.
  Colors follow the project's cyan design system.
*/
export function PixelSprite({
  hasAlert,
  flip,
  walkFrame,
  antOn,
  waveFrame,
  isWaving,
}: {
  hasAlert: boolean;
  flip: boolean;
  walkFrame: boolean;
  antOn: boolean;
  waveFrame: boolean;
  isWaving: boolean;
}) {
  const B = "#0891b2"; // body — cyan-600
  const S = "#0e7490"; // shadow — cyan-700
  const F = "#cffafe"; // face — cyan-50
  const E = "#083344"; // eye dark
  const A = hasAlert ? (antOn ? "#ef4444" : "#fbbf24") : "#22d3ee"; // red↔amber blink when alert, cyan when idle

  return (
    <svg
      width={30}
      height={39}
      viewBox="0 0 10 13"
      shapeRendering="crispEdges"
      style={{ imageRendering: "pixelated", transform: flip ? "scaleX(-1)" : undefined }}
      aria-hidden
    >
      {/* Antenna */}
      <rect x="4" y="0" width="2" height="1" fill={A} />
      <rect x="4" y="1" width="2" height="1" fill={B} />

      {/* Head */}
      <rect x="2" y="2" width="6" height="1" fill={F} />
      <rect x="1" y="3" width="8" height="3" fill={F} />
      <rect x="2" y="6" width="6" height="1" fill={F} />

      {/* Eyes — 2×2 each with shine */}
      <rect x="2" y="4" width="2" height="2" fill={E} />
      <rect x="6" y="4" width="2" height="2" fill={E} />
      <rect x="3" y="4" width="1" height="1" fill="white" opacity="0.65" />
      <rect x="7" y="4" width="1" height="1" fill="white" opacity="0.65" />

      {/* Blush dots */}
      <rect x="1" y="5" width="1" height="1" fill="#f9a8d4" opacity="0.6" />
      <rect x="8" y="5" width="1" height="1" fill="#f9a8d4" opacity="0.6" />

      {/* Mouth — smile or flat-worried */}
      {hasAlert ? (
        <rect x="3" y="6" width="4" height="1" fill={S} opacity="0.5" />
      ) : (
        <>
          <rect x="3" y="7" width="1" height="1" fill={S} opacity="0.45" />
          <rect x="6" y="7" width="1" height="1" fill={S} opacity="0.45" />
        </>
      )}

      {/* Body */}
      <rect x="2" y="7" width="6" height="3" fill={B} />
      {/* Body chest line */}
      <rect x="3" y="8" width="4" height="1" fill={S} opacity="0.35" />

      {/* Arms — wave when scrolling, otherwise alternate with legs */}
      <rect x="0" y={isWaving ? (waveFrame ? 6 : 8) : 7} width="2" height="2" fill={B} />
      <rect x="8" y={isWaving ? (waveFrame ? 8 : 6) : 7} width="2" height="2" fill={B} />

      {/* Legs — alternate between two frames when walking */}
      {walkFrame ? (
        <>
          <rect x="3" y="10" width="2" height="2" fill={S} />
          <rect x="5" y="11" width="2" height="2" fill={S} />
        </>
      ) : (
        <>
          <rect x="3" y="11" width="2" height="2" fill={S} />
          <rect x="5" y="10" width="2" height="2" fill={S} />
        </>
      )}
    </svg>
  );
}

export function DashboardPet({ printers }: { printers: Printer[] }) {
  const [hidden, setHidden] = useState(false);
  const [renderPos, setRenderPos] = useState({ x: 80, y: 140 });
  const [flip, setFlip] = useState(false);
  const [walkFrame, setWalkFrame] = useState(false);
  const [isMoving, setIsMoving] = useState(false);
  const [antOn, setAntOn] = useState(true);
  const [waveFrame, setWaveFrame] = useState(false);
  const [isWaving, setIsWaving] = useState(false);
  const [isDraggingState, setIsDraggingState] = useState(false);
  const pos = useRef({ x: 80, y: 140 });
  const target = useRef({ x: 200, y: 200 });
  const targetId = useRef<number | null>(null);
  const idx = useRef(0);
  const lastFlip = useRef(false);
  const walkTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const blinkTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const waveTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const waveStopTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasAlertRef = useRef(false);
  const isMovingRef = useRef(false);
  const isDragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const posInitialized = useRef(false);

  useEffect(() => {
    try { setHidden(localStorage.getItem(STORAGE_HIDE) === "1"); } catch { /* ignore */ }
  }, []);

  /* Toggle walk frame while moving */
  useEffect(() => {
    if (isMoving) {
      walkTimer.current = setInterval(() => setWalkFrame(f => !f), 180);
    } else {
      if (walkTimer.current) clearInterval(walkTimer.current);
      setWalkFrame(false);
    }
    return () => { if (walkTimer.current) clearInterval(walkTimer.current); };
  }, [isMoving]);

  const hasAlert = needsAttentionPrinterIds(printers).length > 0;

  useEffect(() => {
    hasAlertRef.current = hasAlert;
  }, [hasAlert]);

  useEffect(() => {
    isMovingRef.current = isMoving;
  }, [isMoving]);

  /* Wave interval: toggle arm frame while waving */
  useEffect(() => {
    if (isWaving) {
      waveTimer.current = setInterval(() => setWaveFrame(f => !f), 220);
    } else {
      if (waveTimer.current) { clearInterval(waveTimer.current); waveTimer.current = null; }
      setWaveFrame(false);
    }
    return () => { if (waveTimer.current) { clearInterval(waveTimer.current); waveTimer.current = null; } };
  }, [isWaving]);

  /* Scroll → wave only while flying */
  useEffect(() => {
    const onScroll = () => {
      if (!isMovingRef.current || targetId.current === null) return;
      setIsWaving(true);
      if (waveStopTimeout.current) clearTimeout(waveStopTimeout.current);
      waveStopTimeout.current = setTimeout(() => setIsWaving(false), 150);
    };
    window.addEventListener("wheel", onScroll, { passive: true });
    return () => window.removeEventListener("wheel", onScroll);
  }, []);

  /* Drag — pointer events (mouse + touch unified) */
  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      if (!isDragging.current) return;
      const nx = Math.max(15, Math.min(window.innerWidth - 15, e.clientX - dragOffset.current.x));
      const ny = Math.max(20, Math.min(window.innerHeight - 20, e.clientY - dragOffset.current.y));
      pos.current = { x: nx, y: ny };
      target.current = { x: nx, y: ny };
      setRenderPos({ x: Math.round(nx), y: Math.round(ny) });
    };
    const onPointerUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      setIsDraggingState(false);
      setIsWaving(false);
      setIsMoving(false);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  const pickTarget = useCallback(() => {
    const ids = needsAttentionPrinterIds(printers);
    if (ids.length === 0) {
      targetId.current = null;
      const w = window.innerWidth;
      const h = window.innerHeight;
      target.current = { x: Math.round(48 + Math.random() * (w - 120)), y: Math.round(80 + Math.random() * (h - 200)) };
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
    return () => { window.removeEventListener("scroll", syncCard, true); window.removeEventListener("resize", syncCard); };
  }, []);

  useEffect(() => {
    if (hidden) { posInitialized.current = false; return; }
    if (!posInitialized.current) {
      const w = typeof window !== "undefined" ? window.innerWidth : 400;
      pos.current = { x: Math.round(w - 80), y: 140 };
      setRenderPos({ x: pos.current.x, y: pos.current.y });
      posInitialized.current = true;
    }

    let raf = 0;
    let lastT = performance.now();

    function step(now: number) {
      if (isDragging.current) { raf = requestAnimationFrame(step); return; }
      const dt = Math.min(48, now - lastT) / 1000;
      lastT = now;
      const p = pos.current;
      const t = target.current;
      let dx = t.x - p.x;
      const dy = t.y - p.y;
      const dist = Math.hypot(dx, dy);

      if (dist < ARRIVE_EPS) {
        p.x = t.x; p.y = t.y;
        setIsMoving(false);
      } else {
        const k = 1 - Math.exp(-SMOOTH_LAMBDA * dt);
        const maxStep = MAX_PX_PER_S * dt;
        const rawDx = dx * k;
        const rawDy = dy * k;
        const rawDist = Math.hypot(rawDx, rawDy);
        const scale = rawDist > maxStep ? maxStep / rawDist : 1;
        p.x += rawDx * scale;
        p.y += rawDy * scale;
        setIsMoving(dist > 8);
      }

      /* Blink antenna from inside the loop — no effect re-run problem */
      if (dist < 30 && hasAlertRef.current) {
        if (!blinkTimer.current) {
          blinkTimer.current = setInterval(() => setAntOn(v => !v), 200);
        }
      } else {
        if (blinkTimer.current) {
          clearInterval(blinkTimer.current);
          blinkTimer.current = null;
          setAntOn(true);
        }
      }

      dx = t.x - p.x;
      if (Math.abs(dx) > 6) {
        const nf = dx < 0;
        if (nf !== lastFlip.current) { lastFlip.current = nf; setFlip(nf); }
      }

      setRenderPos({ x: Math.round(p.x), y: Math.round(p.y) });
      raf = requestAnimationFrame(step);
    }
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      if (blinkTimer.current) { clearInterval(blinkTimer.current); blinkTimer.current = null; }
    };
  }, [hidden, printers]);

  function hide() {
    setHidden(true);
    try { localStorage.setItem(STORAGE_HIDE, "1"); } catch { /* ignore */ }
  }

  function show() {
    setHidden(false);
    try { localStorage.removeItem(STORAGE_HIDE); } catch { /* ignore */ }
  }

  if (printers.length === 0) return null;

  if (hidden) {
    return (
      <button
        type="button"
        onClick={show}
        title="Показати помічника"
        className="fixed bottom-4 right-4 z-[35] size-5 rounded-full bg-[rgba(56,189,248,.08)] opacity-30 transition-opacity hover:opacity-100"
        aria-label="Показати помічника"
      />
    );
  }

  const { x, y } = renderPos;

  return (
    <>
      <style>{`
        @keyframes petFloat {
          0%, 100% { transform: translateY(0px);  }
          50%       { transform: translateY(-5px); }
        }
        .pet-idle { animation: petFloat 2.6s ease-in-out infinite; }
      `}</style>
      <div
        className="pointer-events-none fixed z-[35] select-none"
        style={{ left: x - 15, top: y - 20 }}
        aria-hidden
      >
        <div className="pointer-events-auto group relative flex flex-col items-center gap-1">

          <button
            type="button"
            onClick={hide}
            title="Приховати"
            className="absolute -right-2 -top-2 flex size-4 items-center justify-center rounded-full bg-[var(--surface-2)]/75 text-[9px] text-[var(--text-faint)] opacity-0 transition-opacity hover:bg-[var(--accent-hi)] hover:text-[var(--text-hi)] group-hover:opacity-100"
          >
            ×
          </button>

          <div
            className={isMoving || isDraggingState ? "" : "pet-idle"}
            style={{ filter: "drop-shadow(0 3px 8px rgba(0,0,0,0.55))", cursor: isDraggingState ? "grabbing" : "grab" }}
            onPointerDown={(e) => {
              e.preventDefault();
              isDragging.current = true;
              setIsDraggingState(true);
              dragOffset.current = { x: e.clientX - pos.current.x, y: e.clientY - pos.current.y };
              setIsWaving(true);
              setIsMoving(false);
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
            }}
          >
            <PixelSprite hasAlert={hasAlert} flip={flip} walkFrame={walkFrame} antOn={antOn} waveFrame={waveFrame} isWaving={isWaving || isDraggingState} />
          </div>

          {hasAlert && (
            <div className="flex items-center gap-1 rounded-full bg-[rgba(239,68,68,.08)] px-1.5 py-px text-[9px] leading-none text-[var(--state-error)] ring-1 ring-[rgba(239,68,68,.2)]">
              <span className="relative flex size-2 shrink-0">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--state-error)] opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-[var(--state-error)]" />
              </span>
              {needsAttentionPrinterIds(printers).length}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
