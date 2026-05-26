"use client";

import { useEffect } from "react";
import { api } from "@/lib/api";

type Printer = { state: string };

type FavState =
  | { kind: "idle" }
  | { kind: "printing"; count: number }
  | { kind: "alert"; count: number }
  | { kind: "disconnected" };

const C_ACCENT  = "#22d3ee";
const C_GREY    = "#71717a";
const C_DIM     = "#3f3f46";
const C_ERROR   = "#ef4444";

const OUTER: [number, number][] = [
  [5,5],[12,5],[19,5],
  [5,12],      [19,12],
  [5,19],[12,19],[19,19],
];

function derive(printers: Printer[]): FavState {
  if (!printers.length) return { kind: "idle" };
  const printing = printers.filter(p => p.state === "printing" || p.state === "paused").length;
  const errors   = printers.filter(p => p.state === "error").length;
  const online   = printers.filter(p => p.state !== "offline" && p.state !== "unknown").length;
  if (online === 0)    return { kind: "disconnected" };
  if (errors > 0)      return { kind: "alert", count: errors };
  if (printing > 0)    return { kind: "printing", count: printing };
  return { kind: "idle" };
}

function draw(state: FavState): string {
  const SIZE = 64;
  const S    = SIZE / 24; // scale factor

  const canvas = document.createElement("canvas");
  canvas.width  = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d")!;

  const dotCol    = state.kind === "disconnected" ? C_DIM  : C_GREY;
  const centerCol = state.kind === "printing"     ? C_ACCENT : dotCol;

  // outer dots
  for (const [x, y] of OUTER) {
    ctx.beginPath();
    ctx.arc(x * S, y * S, 1.6 * S, 0, Math.PI * 2);
    ctx.fillStyle = dotCol;
    ctx.fill();
  }

  // center dot
  ctx.beginPath();
  ctx.arc(12 * S, 12 * S, 2.6 * S, 0, Math.PI * 2);
  ctx.fillStyle = centerCol;
  ctx.fill();

  // disconnected slash
  if (state.kind === "disconnected") {
    ctx.beginPath();
    ctx.moveTo(4 * S, 4 * S);
    ctx.lineTo(20 * S, 20 * S);
    ctx.strokeStyle = C_DIM;
    ctx.lineWidth   = 2 * S;
    ctx.lineCap     = "round";
    ctx.stroke();
    return canvas.toDataURL("image/png");
  }

  // badge (alert = red, printing = cyan)
  if (state.kind === "alert" || state.kind === "printing") {
    const bx    = 19 * S;
    const by    = 5  * S;
    const br    = 4  * S;
    const col   = state.kind === "alert" ? C_ERROR : C_ACCENT;
    const n     = state.count;

    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fillStyle = "#0c0c0e"; // dark bg ring
    ctx.fill();

    ctx.beginPath();
    ctx.arc(bx, by, br - 1, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();

    if (n > 0) {
      ctx.font         = `bold ${Math.round(4.5 * S)}px system-ui`;
      ctx.fillStyle    = "#000";
      ctx.textAlign    = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(n > 9 ? "9" : String(n), bx, by + 0.5);
    }
  }

  return canvas.toDataURL("image/png");
}

function applyFavicon(url: string) {
  let el = document.querySelector<HTMLLinkElement>('link[data-dyn-favicon]');
  if (!el) {
    el = document.createElement("link");
    el.rel = "icon";
    el.setAttribute("data-dyn-favicon", "1");
    // insert before any existing icon links so it takes priority
    const first = document.querySelector('link[rel~="icon"]');
    document.head.insertBefore(el, first ?? null);
  }
  el.type = "image/png";
  el.href = url;
}

function applyTitle(state: FavState) {
  const base = "monofarm";
  if (state.kind === "printing") document.title = `(${state.count} 🖨) ${base}`;
  else if (state.kind === "alert") document.title = `(! ${state.count}) ${base}`;
  else document.title = base;
}

export function DynamicFavicon() {
  useEffect(() => {
    let active = true;

    async function tick() {
      try {
        const printers = await api<Printer[]>("/api/printers");
        if (!active) return;
        const state = derive(printers);
        applyFavicon(draw(state));
        applyTitle(state);
      } catch {
        // silently ignore — keep current favicon on error
      }
    }

    tick();
    const id = setInterval(tick, 30_000);
    return () => { active = false; clearInterval(id); };
  }, []);

  return null;
}
