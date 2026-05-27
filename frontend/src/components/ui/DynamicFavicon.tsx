"use client";

import { useEffect } from "react";
import { api } from "@/lib/api";

type Printer = { state: string | null };

const C_ACCENT = "#22d3ee";
const C_WARN   = "#f59e0b";
const C_ERROR  = "#ef4444";
const C_GREY   = "#71717a";
const C_DIM    = "#3f3f46";
const C_EMPTY  = "#1e1e20";

// 3×3 grid — index 4 is center
const GRID: [number, number][] = [
  [5, 5],  [12, 5],  [19, 5],
  [5, 12], [12, 12], [19, 12],
  [5, 19], [12, 19], [19, 19],
];

function stateColor(state: string | null): string {
  switch (state) {
    case "printing":    return C_ACCENT;
    case "paused":      return C_WARN;
    case "error":       return C_ERROR;
    case "idle":
    case "operational": return C_GREY;
    default:            return C_DIM;
  }
}

function statePriority(state: string | null): number {
  switch (state) {
    case "error":       return 0;
    case "printing":    return 1;
    case "paused":      return 2;
    case "idle":
    case "operational": return 3;
    default:            return 4;
  }
}

function draw(printers: Printer[], disconnected = false): string {
  const SIZE = 64;
  const S    = SIZE / 24;

  const canvas  = document.createElement("canvas");
  canvas.width  = SIZE;
  canvas.height = SIZE;
  const ctx     = canvas.getContext("2d")!;

  // sort: errors → printing → paused → idle → offline
  const sorted = [...printers].sort(
    (a, b) => statePriority(a.state) - statePriority(b.state),
  );

  GRID.forEach(([x, y], i) => {
    const isCenter = i === 4;
    const r = isCenter ? 2.8 * S : 1.8 * S;

    let color: string;
    if (disconnected) {
      color = C_DIM;
    } else if (!sorted[i]) {
      color = C_EMPTY;
    } else {
      color = stateColor(sorted[i].state);
    }

    ctx.beginPath();
    ctx.arc(x * S, y * S, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  });

  if (disconnected) {
    ctx.beginPath();
    ctx.moveTo(4 * S, 4 * S);
    ctx.lineTo(20 * S, 20 * S);
    ctx.strokeStyle = C_DIM;
    ctx.lineWidth   = 2 * S;
    ctx.lineCap     = "round";
    ctx.stroke();
  }

  return canvas.toDataURL("image/png");
}

function applyFavicon(url: string) {
  let el = document.querySelector<HTMLLinkElement>("link[data-dyn-favicon]");
  if (!el) {
    el = document.createElement("link");
    el.rel = "icon";
    el.setAttribute("data-dyn-favicon", "1");
    const first = document.querySelector('link[rel~="icon"]');
    document.head.insertBefore(el, first ?? null);
  }
  el.type = "image/png";
  el.href = url;
}

export function DynamicFavicon() {
  useEffect(() => {
    let active = true;

    async function tick() {
      try {
        const printers = await api<Printer[]>("/api/printers");
        if (!active) return;
        applyFavicon(draw(printers));
      } catch {
        if (active) applyFavicon(draw([], true));
      }
    }

    tick();
    const id = setInterval(tick, 30_000);
    return () => { active = false; clearInterval(id); };
  }, []);

  return null;
}
