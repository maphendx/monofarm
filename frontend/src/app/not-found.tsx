"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";

/* ───────────────────── Mono mascot sprite ─────────────────────
   10×13 pixel grid, rendered crisp + scaled. Poses parameterised.
   Ported verbatim from the Monofarm 404 design (same art family as
   the DashboardPet mascot, with extra game poses). */
type MonoOpts = {
  antenna?: string;
  arms?: "down" | "up" | "wave";
  legs?: "stand" | "walkA" | "walkB";
  mouth?: "smile" | "worried" | "open";
  blink?: boolean;
};
function monoSVG(o: MonoOpts = {}): string {
  const ant = o.antenna || "#22d3ee";
  const arms = o.arms || "down";
  const legs = o.legs || "stand";
  const mouth = o.mouth || "smile";
  const blink = !!o.blink;

  const eyes = blink
    ? '<rect x="2" y="5" width="2" height="1" fill="#083344"/><rect x="6" y="5" width="2" height="1" fill="#083344"/>'
    : '<rect x="2" y="4" width="2" height="2" fill="#083344"/><rect x="6" y="4" width="2" height="2" fill="#083344"/>'
      + '<rect x="3" y="4" width="1" height="1" fill="#fff" opacity="0.65"/><rect x="7" y="4" width="1" height="1" fill="#fff" opacity="0.65"/>';

  let m: string;
  if (mouth === "worried") m = '<rect x="3" y="6" width="4" height="1" fill="#155e75" opacity="0.5"/>';
  else if (mouth === "open") m = '<rect x="4" y="6" width="2" height="1" fill="#083344" opacity="0.7"/>';
  else m = '<rect x="3" y="7" width="1" height="1" fill="#155e75" opacity="0.45"/><rect x="6" y="7" width="1" height="1" fill="#155e75" opacity="0.45"/>';

  let a: string;
  if (arms === "up") a = '<rect x="0" y="5" width="2" height="2" fill="#0891b2"/><rect x="8" y="5" width="2" height="2" fill="#0891b2"/>';
  else if (arms === "wave") a = '<rect x="0" y="5" width="2" height="2" fill="#0891b2"/><rect x="8" y="8" width="2" height="2" fill="#0891b2"/>';
  else a = '<rect x="0" y="7" width="2" height="2" fill="#0891b2"/><rect x="8" y="7" width="2" height="2" fill="#0891b2"/>';

  let l: string;
  if (legs === "walkA") l = '<rect x="3" y="11" width="2" height="2" fill="#155e75"/><rect x="5" y="11" width="2" height="2" fill="#155e75"/>';
  else if (legs === "walkB") l = '<rect x="3" y="10" width="2" height="2" fill="#155e75"/><rect x="5" y="11" width="2" height="2" fill="#155e75"/>';
  else l = '<rect x="3" y="11" width="2" height="2" fill="#155e75"/><rect x="5" y="10" width="2" height="2" fill="#155e75"/>';

  return `<svg width="60" height="78" viewBox="0 0 10 13" shape-rendering="crispEdges" style="image-rendering:pixelated;">
    <rect x="4" y="0" width="2" height="1" fill="${ant}"/>
    <rect x="4" y="1" width="2" height="1" fill="#0891b2"/>
    <rect x="2" y="2" width="6" height="1" fill="#cffafe"/>
    <rect x="1" y="3" width="8" height="3" fill="#cffafe"/>
    <rect x="2" y="6" width="6" height="1" fill="#cffafe"/>
    ${eyes}
    <rect x="1" y="5" width="1" height="1" fill="#f9a8d4" opacity="0.6"/>
    <rect x="8" y="5" width="1" height="1" fill="#f9a8d4" opacity="0.6"/>
    ${m}
    <rect x="2" y="7" width="6" height="3" fill="#0891b2"/>
    <rect x="3" y="8" width="4" height="1" fill="#155e75" opacity="0.35"/>
    ${a}
    ${l}
  </svg>`;
}

/* printed-part sprites (pixel voxels in cyan family) */
const PARTS = [
  `<svg width="28" height="28" viewBox="0 0 8 8" shape-rendering="crispEdges" style="image-rendering:pixelated;"><rect x="1" y="1" width="6" height="6" fill="#0891b2"/><rect x="1" y="1" width="6" height="2" fill="#22d3ee"/><rect x="1" y="6" width="6" height="1" fill="#155e75"/><rect x="6" y="1" width="1" height="6" fill="#155e75" opacity=".6"/></svg>`,
  `<svg width="28" height="28" viewBox="0 0 8 8" shape-rendering="crispEdges" style="image-rendering:pixelated;"><rect x="1" y="1" width="6" height="6" fill="#155e75"/><rect x="2" y="2" width="4" height="4" fill="#22d3ee"/><rect x="3" y="3" width="2" height="2" fill="#083344"/></svg>`,
  `<svg width="28" height="28" viewBox="0 0 8 8" shape-rendering="crispEdges" style="image-rendering:pixelated;"><rect x="3" y="0" width="2" height="8" fill="#67e8f9"/><rect x="0" y="3" width="8" height="2" fill="#67e8f9"/><rect x="2" y="2" width="4" height="4" fill="#0891b2"/><rect x="3" y="3" width="2" height="2" fill="#083344"/></svg>`,
];

const CSS = `
.nf404{position:relative;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px 20px;overflow-x:hidden;font-size:14px;line-height:1.5;}
.nf404 .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-feature-settings:"zero";}
.nf404::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;background-image:radial-gradient(circle at center, rgba(255,255,255,.045) 1px, transparent 1.4px);background-size:26px 26px;-webkit-mask-image:radial-gradient(ellipse 80% 70% at 50% 42%, #000 0%, transparent 82%);mask-image:radial-gradient(ellipse 80% 70% at 50% 42%, #000 0%, transparent 82%);}
.nf404::after{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;background:radial-gradient(ellipse 50% 45% at 50% 32%, var(--accent-soft) 0%, transparent 70%);}
.nf404 .wrap{position:relative;z-index:1;width:100%;max-width:760px;}
.nf404 .eyebrow{display:inline-flex;align-items:center;gap:8px;margin:0 auto 22px;padding:5px 12px;border:1px solid var(--border-strong);border-radius:var(--r-full);background:var(--surface);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--text-muted);white-space:nowrap;}
.nf404 .eyebrow .dot{width:6px;height:6px;border-radius:50%;background:var(--state-error);box-shadow:0 0 0 3px rgba(239,68,68,.15);animation:nfPulseDot 1.8s var(--ease-out) infinite;}
@keyframes nfPulseDot{0%,100%{opacity:1;}50%{opacity:.35;}}
.nf404 .head{text-align:center;margin-bottom:18px;}
.nf404 .stage-head{position:relative;display:flex;align-items:center;justify-content:center;gap:clamp(2px,3vw,30px);margin-bottom:6px;}
.nf404 .big{font-weight:700;line-height:.9;font-size:clamp(96px,22vw,200px);letter-spacing:-.04em;color:var(--text-hi);user-select:none;}
.nf404 .big.zero{position:relative;color:transparent;-webkit-text-stroke:2px var(--border-strong);}
.nf404 h1{font-size:clamp(20px,4.5vw,28px);font-weight:600;letter-spacing:-.02em;color:var(--text-hi);margin:14px 0 8px;}
.nf404 .sub{font-size:14px;color:var(--text-muted);max-width:460px;margin:0 auto;line-height:1.6;text-wrap:pretty;}
.nf404 .play{position:relative;margin:26px auto 0;width:100%;max-width:680px;height:320px;border:1px solid var(--border);border-top-left-radius:var(--r-xl);border-top-right-radius:var(--r-xl);background:linear-gradient(180deg, var(--accent-soft), transparent 38%),var(--surface);overflow:hidden;touch-action:none;cursor:grab;}
.nf404 .play:active{cursor:grabbing;}
.nf404 .play::before{content:"";position:absolute;inset:0;pointer-events:none;background-image:linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px),linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px);background-size:34px 34px;background-position:center;-webkit-mask-image:linear-gradient(180deg, transparent 0%, #000 55%);mask-image:linear-gradient(180deg, transparent 0%, #000 55%);}
.nf404 .hud{position:absolute;top:12px;left:12px;right:12px;z-index:6;display:flex;justify-content:space-between;align-items:flex-start;gap:10px;pointer-events:none;}
.nf404 .stat{display:flex;flex-direction:column;gap:2px;}
.nf404 .stat .lbl{font-family:ui-monospace,monospace;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--text-faint);}
.nf404 .stat .val{font-family:ui-monospace,monospace;font-size:18px;font-weight:600;color:var(--text-hi);letter-spacing:-.01em;line-height:1;}
.nf404 .stat.miss .val{color:var(--text-muted);}
.nf404 .lives{display:flex;gap:4px;margin-top:5px;}
.nf404 .life{width:7px;height:7px;border-radius:2px;background:var(--accent);box-shadow:0 0 8px rgba(34,211,238,.5);transition:all var(--dur-quick) var(--ease-out);}
.nf404 .life.gone{background:var(--surface-hi);box-shadow:none;}
.nf404 .bed{position:absolute;left:0;right:0;bottom:0;height:30px;z-index:3;background:var(--surface-2);border-top:1px solid var(--border-strong);}
.nf404 .bed .belt{position:absolute;inset:0;overflow:hidden;}
.nf404 .bed .belt::before{content:"";position:absolute;inset:-2px -40px;background:repeating-linear-gradient(115deg, transparent 0 16px, rgba(255,255,255,.04) 16px 32px);animation:nfBelt 1.1s linear infinite;}
@keyframes nfBelt{from{transform:translateX(0);}to{transform:translateX(-37px);}}
.nf404 .mono-actor{position:absolute;bottom:24px;left:0;z-index:5;width:60px;height:78px;will-change:transform;transition:transform 90ms linear;}
.nf404 .mono-actor svg{display:block;image-rendering:pixelated;filter:drop-shadow(0 4px 10px rgba(0,0,0,.5));}
.nf404 .mono-actor.float{animation:nfFloat 2.6s var(--ease-out) infinite;}
@keyframes nfFloat{0%,100%{transform:translateY(0);}50%{transform:translateY(-6px);}}
.nf404 .mono-shadow{position:absolute;bottom:20px;width:46px;height:8px;left:7px;border-radius:50%;background:rgba(0,0,0,.45);filter:blur(3px);z-index:4;}
.nf404 .part{position:absolute;top:-40px;z-index:4;width:28px;height:28px;will-change:transform;image-rendering:pixelated;}
.nf404 .spark{position:absolute;z-index:6;width:6px;height:6px;border-radius:1px;background:var(--accent);pointer-events:none;}
.nf404 .overlay{position:absolute;inset:0;z-index:8;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:rgba(10,10,11,.72);backdrop-filter:blur(3px);text-align:center;padding:24px;}
.nf404 .overlay.hidden{display:none;}
.nf404 .ov-title{font-size:17px;font-weight:600;color:var(--text-hi);letter-spacing:-.01em;}
.nf404 .ov-sub{font-size:12.5px;color:var(--text-muted);max-width:320px;line-height:1.55;}
.nf404 .kbd{font-family:ui-monospace,monospace;font-size:11px;color:var(--text-muted);display:inline-flex;align-items:center;gap:6px;}
.nf404 .kbd b{display:inline-grid;place-items:center;min-width:22px;height:22px;padding:0 5px;border:1px solid var(--border-strong);border-bottom-width:2px;border-radius:5px;background:var(--surface-hi);color:var(--text);font-weight:500;}
.nf404 .actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:24px;}
.nf404 .nfbtn{display:inline-flex;align-items:center;gap:8px;height:38px;padding:0 18px;border-radius:var(--r-md);font-size:13px;font-weight:500;letter-spacing:-.01em;border:1px solid transparent;transition:all var(--dur-quick) var(--ease-out);position:relative;cursor:pointer;text-decoration:none;}
.nf404 .nfbtn:focus-visible{outline:none;box-shadow:0 0 0 3px var(--accent-ring);}
.nf404 .nfbtn-primary{background:var(--accent-strong);color:#ffffff;border-color:rgba(255,255,255,.12);}
.dark .nf404 .nfbtn-primary{color:#04121a;}
.nf404 .nfbtn-primary:hover{background:var(--accent);transform:translateY(-1px);}
.nf404 .nfbtn-ghost{background:transparent;color:var(--text-muted);border-color:var(--border-strong);}
.nf404 .nfbtn-ghost:hover{color:var(--text-hi);background:var(--surface-hi);border-color:var(--border-strong);}
.nf404 .nfbtn-sm{height:32px;padding:0 14px;font-size:12px;}
.nf404 .nfbtn svg{width:15px;height:15px;}
.nf404 .footnote{margin-top:18px;text-align:center;font-family:ui-monospace,monospace;font-size:10.5px;letter-spacing:.08em;color:var(--text-dim);}
.nf404 .footnote a{color:var(--text-faint);text-decoration:none;border-bottom:1px solid var(--border-strong);}
.nf404 .footnote a:hover{color:var(--accent);}
@media (max-width:560px){.nf404 .play{height:288px;}.nf404 .sub{font-size:13px;}}
@media (prefers-reduced-motion:reduce){.nf404 *{animation-duration:.01ms !important;}.nf404 .mono-actor.float{animation:none;}}
`;

export default function NotFound() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const $ = <T extends Element>(sel: string) => root.querySelector(sel) as T;

    const play = $<HTMLDivElement>("#play");
    const actor = $<HTMLDivElement & { _lastPose?: string }>("#actor");
    const shadow = $<HTMLDivElement>("#shadow");
    const ovMono = $<HTMLDivElement>("#ovMono");
    const overlay = $<HTMLDivElement>("#overlay");
    const scoreEl = $<HTMLSpanElement>("#score");
    const bestEl = $<HTMLSpanElement>("#best");
    const livesEl = $<HTMLDivElement>("#lives");
    const ovTitle = $<HTMLDivElement>("#ovTitle");
    const ovSub = $<HTMLDivElement>("#ovSub");
    const startBtn = $<HTMLButtonElement>("#startBtn");

    /* idle render + blink */
    const idlePose: MonoOpts = { arms: "down", legs: "stand", mouth: "smile" };
    const renderIdle = (blink: boolean) => { actor.innerHTML = monoSVG({ ...idlePose, blink }); };
    renderIdle(false);
    ovMono.innerHTML = monoSVG({ arms: "wave" });

    let alive = true;
    let blinkTimer: ReturnType<typeof setTimeout>;
    function scheduleBlink() {
      blinkTimer = setTimeout(() => {
        if (!alive) return;
        if (!running) { renderIdle(true); setTimeout(() => { if (alive && !running) renderIdle(false); }, 130); }
        scheduleBlink();
      }, 2600 + Math.random() * 2600);
    }
    scheduleBlink();

    /* position / controls */
    const MONO_W = 60;
    let posX = 0.5, target = 0.5, dragging = false;
    const stageW = () => play.clientWidth;
    const clampPos = (p: number) => { const half = (MONO_W / 2) / stageW(); return Math.max(half, Math.min(1 - half, p)); };
    function placeMono() {
      const px = posX * stageW() - MONO_W / 2;
      actor.style.transform = `translateX(${px}px)`;
      shadow.style.transform = `translateX(${px}px)`;
    }
    function setTargetFromClientX(clientX: number) {
      const r = play.getBoundingClientRect();
      target = clampPos((clientX - r.left) / r.width);
    }

    // Restart on any pointerdown when not running — the start/again button's
    // click is otherwise swallowed by play's setPointerCapture.
    const onPointerDown = (e: PointerEvent) => { dragging = true; play.setPointerCapture(e.pointerId); setTargetFromClientX(e.clientX); if (!running) start(); };
    const onPointerMove = (e: PointerEvent) => { if (dragging) setTargetFromClientX(e.clientX); };
    const onPointerUp = () => { dragging = false; };
    play.addEventListener("pointerdown", onPointerDown);
    play.addEventListener("pointermove", onPointerMove);
    play.addEventListener("pointerup", onPointerUp);
    play.addEventListener("pointercancel", onPointerUp);

    const keys: Record<string, boolean> = {};
    const onKeyDown = (e: KeyboardEvent) => {
      if (["ArrowLeft", "ArrowRight", "a", "A", "d", "D", "ф", "Ф", "в", "В"].includes(e.key)) {
        keys[e.key] = true; if (!running && !over) start(); e.preventDefault();
      }
      if (e.key === " " || e.key === "Enter") { if (!running) start(); }
    };
    const onKeyUp = (e: KeyboardEvent) => { keys[e.key] = false; };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    const keyDir = () => {
      let d = 0;
      if (keys.ArrowLeft || keys.a || keys.A || keys["ф"] || keys["Ф"]) d -= 1;
      if (keys.ArrowRight || keys.d || keys.D || keys["в"] || keys["В"]) d += 1;
      return d;
    };

    /* game state */
    let running = false, over = false;
    let score = 0, misses = 0, best = 0;
    type Part = { el: HTMLDivElement; x: number; y: number; vy: number; rot: number };
    let parts: Part[] = [];
    let spawnAcc = 0, spawnGap = 1100, fallBase = 120, last = 0, walkClock = 0, rafId = 0;
    const MAX_MISS = 3;

    try { best = parseInt(localStorage.getItem("mono404_best") || "0", 10) || 0; } catch { /* ignore */ }
    bestEl.textContent = String(best);

    function buildLives() {
      livesEl.innerHTML = "";
      for (let i = 0; i < MAX_MISS; i++) {
        const d = document.createElement("span");
        d.className = "life" + (i < misses ? " gone" : "");
        livesEl.appendChild(d);
      }
    }
    buildLives();

    function start() {
      if (running) return;
      over = false; running = true;
      score = 0; misses = 0; spawnGap = 1100; spawnAcc = 0; fallBase = 120;
      parts.forEach((p) => p.el.remove()); parts = [];
      scoreEl.textContent = "0"; buildLives();
      overlay.classList.add("hidden");
      actor.classList.remove("float");
      target = posX; last = performance.now();
      rafId = requestAnimationFrame(loop);
    }

    function endGame() {
      running = false; over = true;
      if (score > best) { best = score; bestEl.textContent = String(best); try { localStorage.setItem("mono404_best", String(best)); } catch { /* ignore */ } }
      actor.innerHTML = monoSVG({ antenna: "#ef4444", arms: "down", legs: "stand", mouth: "worried" });
      ovMono.innerHTML = monoSVG({ antenna: "#ef4444", mouth: "worried" });
      ovTitle.textContent = "Партія браку — деталі розлетілись";
      ovSub.innerHTML = 'Зловлено: <b style="color:var(--accent)">' + score + '</b> · Рекорд: <b style="color:var(--text-hi)">' + best + "</b><br>Калібруємо екструдер і пробуємо ще раз?";
      const lbl = startBtn.lastChild;
      if (lbl) lbl.textContent = " Ще раз";
      overlay.classList.remove("hidden");
      actor.classList.add("float");
    }

    function spawnPart() {
      const el = document.createElement("div"); el.className = "part";
      el.innerHTML = PARTS[(Math.random() * PARTS.length) | 0];
      const half = 14 / stageW();
      const fx = Math.max(half, Math.min(1 - half, Math.random()));
      el.style.left = (fx * stageW() - 14) + "px";
      play.appendChild(el);
      parts.push({ el, x: fx, y: -30, vy: fallBase * (0.85 + Math.random() * 0.4), rot: (Math.random() * 40 - 20) });
    }

    function burst(px: number, py: number, color: string) {
      for (let i = 0; i < 7; i++) {
        const s = document.createElement("div"); s.className = "spark"; s.style.background = color || "var(--accent)";
        s.style.left = px + "px"; s.style.top = py + "px"; play.appendChild(s);
        const ang = Math.random() * Math.PI * 2, dist = 14 + Math.random() * 22;
        const dx = Math.cos(ang) * dist, dy = Math.sin(ang) * dist - 10;
        s.animate([{ transform: "translate(0,0) scale(1)", opacity: 1 }, { transform: `translate(${dx}px,${dy}px) scale(0)`, opacity: 0 }],
          { duration: 420 + Math.random() * 180, easing: "cubic-bezier(.16,1,.3,1)" }).onfinish = () => s.remove();
      }
    }

    function loop(now: number) {
      if (!running) return;
      const dt = Math.min(48, now - last) / 1000; last = now;

      const kd = keyDir();
      if (kd !== 0) target = clampPos(target + kd * 1.5 * dt);
      posX += (target - posX) * Math.min(1, dt * 14);
      posX = clampPos(posX);
      placeMono();

      walkClock += dt;
      const moving = Math.abs(target - posX) > 0.004 || kd !== 0;
      const legPose = moving ? (Math.floor(walkClock * 6) % 2 ? "walkA" : "walkB") : "stand";
      let reach = false;
      const monoCx = posX * stageW();
      for (const p of parts) { if (p.y > 200 && Math.abs(p.x * stageW() - monoCx) < 60) reach = true; }
      const reRender = legPose + (reach ? "1" : "0");
      if (actor._lastPose !== reRender) {
        actor._lastPose = reRender;
        actor.innerHTML = monoSVG({ arms: reach ? "up" : "down", legs: legPose as MonoOpts["legs"], mouth: reach ? "open" : "smile" });
      }

      spawnAcc += dt * 1000;
      if (spawnAcc >= spawnGap) { spawnAcc = 0; spawnPart(); spawnGap = Math.max(560, spawnGap - 18); fallBase = Math.min(260, fallBase + 3); }

      const H = play.clientHeight;
      const catchY = H - 24 - 50;
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.y += p.vy * dt;
        p.el.style.transform = `translateY(${p.y}px) rotate(${p.rot}deg)`;
        const pcx = p.x * stageW();
        if (p.y >= catchY && p.y <= catchY + 46 && Math.abs(pcx - monoCx) < (MONO_W / 2 + 14)) {
          score++; scoreEl.textContent = String(score);
          burst(pcx, catchY + 10, "#22d3ee");
          p.el.remove(); parts.splice(i, 1);
          scoreEl.animate([{ transform: "scale(1.3)", color: "#67e8f9" }, { transform: "scale(1)" }], { duration: 240, easing: "cubic-bezier(.34,1.56,.64,1)" });
          continue;
        }
        if (p.y > H - 22) {
          burst(pcx, H - 22, "#52525b");
          p.el.remove(); parts.splice(i, 1);
          misses++; buildLives();
          play.animate([{ filter: "brightness(1)" }, { filter: "brightness(1.4)" }, { filter: "brightness(1)" }], { duration: 180 });
          if (misses >= MAX_MISS) { endGame(); return; }
        }
      }
      rafId = requestAnimationFrame(loop);
    }

    const onResize = () => { posX = clampPos(posX); target = clampPos(target); placeMono(); };
    window.addEventListener("resize", onResize);
    placeMono();
    startBtn.addEventListener("click", start);

    return () => {
      alive = false;
      clearTimeout(blinkTimer);
      cancelAnimationFrame(rafId);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <div className="nf404" ref={rootRef}>
      <style>{CSS}</style>
      <main className="wrap">
        <div className="head">
          <span className="eyebrow"><span className="dot" />Помилка · MONO-404</span>
          <div className="stage-head">
            <span className="big">4</span>
            <span className="big zero">0</span>
            <span className="big">4</span>
          </div>
          <h1>Цю сторінку ще не надрукували</h1>
          <p className="sub">
            Маршрут, який ви шукали, загубився десь між принтерами. Поки ми його шукаємо — допоможіть&nbsp;
            <b style={{ color: "var(--text)", fontWeight: 600 }}>Mono</b>&nbsp;ловити деталі, що сходять з конвеєра.
          </p>
        </div>

        <div className="play" id="play" aria-label="Міні-гра: ловіть деталі">
          <div className="hud">
            <div className="stat">
              <span className="lbl">Зловлено</span>
              <span className="val mono" id="score">0</span>
            </div>
            <div className="stat miss" style={{ alignItems: "flex-end" }}>
              <span className="lbl">Рекорд</span>
              <span className="val mono" id="best">0</span>
              <div className="lives" id="lives" />
            </div>
          </div>

          <div className="mono-shadow" id="shadow" />
          <div className="mono-actor float" id="actor" />

          <div className="bed"><div className="belt" /></div>

          <div className="overlay" id="overlay">
            <div className="mono-actor" id="ovMono" style={{ position: "static", bottom: "auto", animation: "nfFloat 2.6s var(--ease-out) infinite" }} />
            <div className="ov-title" id="ovTitle">Зловіть деталі з конвеєра</div>
            <div className="ov-sub" id="ovSub">Рухайте Mono і ловіть свіжонадруковані деталі, доки вони не впали. Три промахи — і партія браку.</div>
            <span className="kbd"><b>←</b><b>→</b> або тягніть мишею / пальцем</span>
            <button className="nfbtn nfbtn-primary nfbtn-sm" id="startBtn" style={{ marginTop: 4 }} type="button">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none" /></svg>
              Грати
            </button>
          </div>
        </div>

        <div className="actions">
          <Link className="nfbtn nfbtn-primary" href="/">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /></svg>
            На головну ферму
          </Link>
          <button className="nfbtn nfbtn-ghost" type="button" onClick={() => { if (history.length > 1) history.back(); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
            Повернутись назад
          </button>
        </div>

        <div className="footnote">MONOFARM · 3D PRINT FARM OS — <Link href="/support">повідомити про збій</Link></div>
      </main>
    </div>
  );
}
