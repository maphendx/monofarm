"use client";

import React from "react";

import {
  AlertTriangle, ArrowRight, Check, ChevronDown,
  Info, Plus, RefreshCw, Search, Upload, X, Zap,
} from "lucide-react";
import { Icon } from "@/components/ui/Icon";
import { StateIcon } from "@/components/printers/StateIcon";

/* ── FarmGrid logo mark (inline SVG) ─────────────────────────── */
function FarmGrid({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <g stroke="var(--accent)" strokeWidth="1.7" fill="none" opacity=".50" strokeLinecap="round">
        <circle cx="5"  cy="5"  r="1.6"/>
        <circle cx="12" cy="5"  r="1.6"/>
        <circle cx="19" cy="5"  r="1.6"/>
        <circle cx="5"  cy="12" r="1.6"/>
        <circle cx="19" cy="12" r="1.6"/>
        <circle cx="5"  cy="19" r="1.6"/>
        <circle cx="12" cy="19" r="1.6"/>
        <circle cx="19" cy="19" r="1.6"/>
      </g>
      <circle cx="12" cy="12" r="2.6" fill="var(--accent)"/>
    </svg>
  );
}

/* ── Mascot (Mono) pixel sprite ─────────────────────────────────── */
function Mascot({ scale = 3 }: { scale?: number }) {
  const w = 10 * scale;
  const h = 13 * scale;
  return (
    <svg
      width={w} height={h}
      viewBox="0 0 10 13"
      shapeRendering="crispEdges"
      style={{ imageRendering: "pixelated" }}
    >
      <rect x="4" y="0"  width="2" height="1" fill="#38bdf8"/>
      <rect x="4" y="1"  width="2" height="1" fill="#0ea5e9"/>
      <rect x="2" y="2"  width="6" height="1" fill="#f0f9ff"/>
      <rect x="1" y="3"  width="8" height="3" fill="#f0f9ff"/>
      <rect x="2" y="6"  width="6" height="1" fill="#f0f9ff"/>
      <rect x="2" y="4"  width="2" height="2" fill="#082f49"/>
      <rect x="6" y="4"  width="2" height="2" fill="#082f49"/>
      <rect x="3" y="4"  width="1" height="1" fill="#fff" opacity="0.65"/>
      <rect x="7" y="4"  width="1" height="1" fill="#fff" opacity="0.65"/>
      <rect x="1" y="5"  width="1" height="1" fill="#f9a8d4" opacity="0.6"/>
      <rect x="8" y="5"  width="1" height="1" fill="#f9a8d4" opacity="0.6"/>
      <rect x="3" y="7"  width="1" height="1" fill="#0369a1" opacity="0.45"/>
      <rect x="6" y="7"  width="1" height="1" fill="#0369a1" opacity="0.45"/>
      <rect x="2" y="7"  width="6" height="3" fill="#0ea5e9"/>
      <rect x="3" y="8"  width="4" height="1" fill="#0369a1" opacity="0.35"/>
      <rect x="0" y="7"  width="2" height="2" fill="#0ea5e9"/>
      <rect x="8" y="7"  width="2" height="2" fill="#0ea5e9"/>
      <rect x="3" y="11" width="2" height="2" fill="#0369a1"/>
      <rect x="5" y="10" width="2" height="2" fill="#0369a1"/>
    </svg>
  );
}

/* ── Section wrapper ─────────────────────────────────────────── */
function Section({ id, num, title, children }: {
  id: string; num: string; title: string; children: React.ReactNode;
}) {
  return (
    <section id={id} style={{ padding: "48px 0 64px", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12, fontFamily: "var(--font-mono)", fontSize: 10.5, letterSpacing: ".08em", color: "var(--text-faint)" }}>
        <span style={{ color: "var(--accent)" }}>{num}</span>
        <span style={{ flex: 1, height: 1, background: "var(--border)", maxWidth: 60 }}></span>
      </div>
      <h2 style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.025em", color: "var(--text-hi)", marginBottom: 28 }}>{title}</h2>
      {children}
    </section>
  );
}

function SubLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 500, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--text-faint)", margin: "28px 0 14px", display: "flex", alignItems: "center", gap: 10 }}>
      {children}
      <span style={{ flex: 1, height: 1, background: "var(--border)" }}></span>
    </div>
  );
}

/* ── Dot indicator ─────────────────────────────────────────────── */
function Dot({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <span
      className={pulse ? "pulse-ring" : ""}
      style={{
        position: "relative",
        display: "inline-block",
        width: 8, height: 8,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
      }}
    />
  );
}

export default function DesignSystem() {
  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "48px 32px 96px" }}>
      {/* Header */}
      <div style={{ marginBottom: 48, paddingBottom: 32, borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <FarmGrid size={28} />
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600, letterSpacing: ".02em", color: "var(--text-hi)" }}>monofarm</span>
          <span className="badge badge-accent" style={{ marginLeft: 4 }}>Design System v1.0</span>
        </div>
        <p style={{ fontSize: 15, color: "var(--text-muted)", maxWidth: 560, lineHeight: 1.55 }}>
          Visual regression target — every primitive with all states. Compare side-by-side with <code>Monofarm Design System.html</code>.
        </p>
      </div>

      {/* 1 · Brand */}
      <Section id="brand" num="1.0" title="Brand · Farm Grid mark">
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          {[16, 22, 32, 48, 64].map(s => (
            <div key={s} className="surface surface-pad" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "20px 24px" }}>
              <FarmGrid size={s} />
              <span className="faint" style={{ fontFamily: "var(--font-mono)", fontSize: 10 }}>{s}px</span>
            </div>
          ))}
          <div className="surface surface-pad" style={{ display: "flex", alignItems: "center", gap: 10, padding: "20px 24px" }}>
            <FarmGrid size={22} />
            <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 13, color: "var(--text-hi)" }}>monofarm</span>
          </div>
        </div>
        <SubLabel>Mascot · Mono</SubLabel>
        <div style={{ display: "flex", gap: 24, alignItems: "flex-end" }}>
          {[1, 2, 3, 4].map(s => (
            <div key={s} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
              <Mascot scale={s} />
              <span className="faint" style={{ fontFamily: "var(--font-mono)", fontSize: 10 }}>{s}×</span>
            </div>
          ))}
        </div>
      </Section>

      {/* 2 · Typography */}
      <Section id="type" num="3.0" title="Typography">
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          {[
            { label: "Display", size: "38px", weight: "600", sample: "Print Farm Overview", ls: "-0.035em" },
            { label: "Heading 1", size: "26px", weight: "600", sample: "Dashboard · Огляд ферми", ls: "-0.025em" },
            { label: "Heading 2", size: "20px", weight: "600", sample: "Active printers · 17", ls: "-0.02em" },
            { label: "Body", size: "14px", weight: "400", sample: "Bambu Lab A1 mini · printing · 38% complete · 1h 14m remaining" },
            { label: "Small", size: "12.5px", weight: "400", sample: "Warehouse row · PLA Білий · 2.400 kg · +49.1%" },
            { label: "Caption", size: "11px", weight: "400", sample: "Last seen 2h ago · slot 0–3" },
          ].map(t => (
            <div key={t.label} style={{ display: "grid", gridTemplateColumns: "120px 70px 1fr", gap: 24, alignItems: "baseline", padding: "14px 0", borderBottom: "1px solid var(--border)" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-faint)", letterSpacing: ".06em" }}>{t.label}</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-dim)" }}>{t.size} / {t.weight}</span>
              <span style={{ fontSize: t.size, fontWeight: t.weight as "400" | "600", color: "var(--text-hi)", letterSpacing: t.ls ?? 0 }}>{t.sample}</span>
            </div>
          ))}
          {/* Mono row */}
          <div style={{ display: "grid", gridTemplateColumns: "120px 70px 1fr", gap: 24, alignItems: "baseline", padding: "14px 0" }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-faint)", letterSpacing: ".06em" }}>Mono label</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-dim)" }}>10.5px / 500</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 500, letterSpacing: ".10em", textTransform: "uppercase", color: "var(--text-faint)" }}>SLOT · SKU · FILE SIZE · ETA</span>
          </div>
        </div>
      </Section>

      {/* 3 · Buttons */}
      <Section id="buttons" num="7.1" title="Buttons">
        <SubLabel>Variants × sizes</SubLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {(["btn-primary", "btn-secondary", "btn-ghost", "btn-danger"] as const).map(v => (
            <div key={v} style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button className={`btn btn-sm ${v}`}><Icon icon={Plus} size={11} /> Small</button>
              <button className={`btn ${v}`}><Icon icon={Plus} size={13} /> Medium</button>
              <button className={`btn btn-lg ${v}`}><Icon icon={Plus} size={14} /> Large</button>
              <button className={`btn btn-primary btn-shimmer ${v === "btn-primary" ? "" : "hidden"}`}>
                <Icon icon={Zap} size={13} /> Shimmer
              </button>
              <button className={`btn btn-sm btn-icon ${v}`}><Icon icon={Plus} size={11} /></button>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)", marginLeft: 8 }}>.{v}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* 4 · Forms */}
      <Section id="forms" num="7.2" title="Forms">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="field">
              <label className="field-label">Server URL</label>
              <div className="input-with-icon">
                <span className="input-icon"><Icon icon={Search} size={13} /></span>
                <input className="input" placeholder="https://api.monofarm.app" />
              </div>
            </div>
            <div className="field">
              <label className="field-label">API Token</label>
              <input className="input input-error" placeholder="Invalid token" defaultValue="bad-token" />
              <span className="field-hint error">Token is expired or invalid</span>
            </div>
            <div className="field">
              <label className="field-label">Filament type</label>
              <select className="select-field">
                <option>PLA</option><option>PETG</option><option>ABS</option>
              </select>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <label className="check-row checked">
              <span className="check-box">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5l2 2 4-4" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </span>
              Start with system
            </label>
            <label className="check-row">
              <span className="check-radio"></span>
              USB connection
            </label>
            <label className="check-row checked">
              <span className="check-radio"></span>
              WiFi (LAN)
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className="toggle on"></span>
              <span style={{ fontSize: 13, color: "var(--text)" }}>Dark mode</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className="toggle"></span>
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Auto-update</span>
            </div>
          </div>
        </div>
      </Section>

      {/* 5 · Badges */}
      <Section id="badges" num="7.4" title="Badges & status">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          <span className="badge badge-neutral">neutral</span>
          <span className="badge badge-accent">accent</span>
          <span className="badge badge-print">printing</span>
          <span className="badge badge-ok">ready</span>
          <span className="badge badge-warn">paused</span>
          <span className="badge badge-error">error</span>
          <span className="badge badge-offline">offline</span>
        </div>
        <SubLabel>Badge-dot variants</SubLabel>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
          {[
            { color: "var(--state-print)", label: "друкує" },
            { color: "var(--state-ok)", label: "готовий" },
            { color: "var(--state-idle)", label: "простоює" },
            { color: "var(--state-warn)", label: "на паузі" },
            { color: "var(--state-error)", label: "помилка" },
            { color: "var(--state-offline)", label: "офлайн" },
          ].map(({ color, label }) => (
            <span key={label} className="badge-dot">
              <span className="dot" style={{ background: color }} />
              {label}
            </span>
          ))}
        </div>
        <SubLabel>State icons</SubLabel>
        <div style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
          {["printing", "operational", "idle", "paused", "error", "offline", "pausing"].map(s => (
            <div key={s} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
              <StateIcon state={s} size={20} />
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>{s}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* 6 · Cards & surfaces */}
      <Section id="cards" num="7.3" title="Cards & surfaces">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <div className="surface surface-pad">
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--text-faint)", marginBottom: 6 }}>PRINTERS ONLINE</div>
            <div style={{ fontSize: 22, fontWeight: 600, color: "var(--text-hi)", letterSpacing: "-0.025em" }}>24 <span style={{ fontSize: 12, color: "var(--text-faint)", fontWeight: 400 }}>/ 24</span></div>
            <div style={{ height: 2, background: "var(--state-ok)", marginTop: 10 }}></div>
          </div>
          <div className="surface surface-pad">
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--text-faint)", marginBottom: 6 }}>UPLOAD QUEUE</div>
            <div style={{ fontSize: 22, fontWeight: 600, color: "var(--text-hi)", letterSpacing: "-0.025em" }}>0 <span style={{ fontSize: 12, color: "var(--text-faint)", fontWeight: 400 }}>pending</span></div>
            <div style={{ height: 2, background: "var(--accent)", marginTop: 10 }}></div>
          </div>
          <div className="surface surface-pad">
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--text-faint)", marginBottom: 6 }}>ATTENTION</div>
            <div style={{ fontSize: 22, fontWeight: 600, color: "var(--text-hi)", letterSpacing: "-0.025em" }}>1 <span style={{ fontSize: 12, color: "var(--state-error)", fontWeight: 400 }}>error</span></div>
            <div style={{ height: 2, background: "var(--state-error)", marginTop: 10 }}></div>
          </div>
        </div>
        <SubLabel>Progress</SubLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 400 }}>
          <div className="progress"><div className="progress-fill" style={{ width: "38%" }}></div></div>
          <div className="progress"><div className="progress-fill ok" style={{ width: "100%" }}></div></div>
          <div className="progress"><div className="progress-fill warn" style={{ width: "62%" }}></div></div>
        </div>
        <SubLabel>Skeleton</SubLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 320 }}>
          <div className="skeleton" style={{ height: 16, width: "70%" }}></div>
          <div className="skeleton" style={{ height: 13, width: "55%" }}></div>
          <div className="skeleton" style={{ height: 13, width: "40%" }}></div>
        </div>
      </Section>

      {/* 7 · Printer cards */}
      <Section id="printer-cards" num="8.1" title="Printer card · 6 states">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
          {/* Printing */}
          <div className="printer-card printing">
            <div className="pc-head">
              <div><div className="pc-id">A1</div><div className="pc-model">Bambu Lab A1</div></div>
              <Dot color="var(--state-print)" pulse />
            </div>
            <div className="pc-status printing">друкує</div>
            <div><div className="pc-file">Збірка_PLA_12h48m.3mf</div><div className="pc-eta">1г 14хв залишилось</div></div>
            <div className="pc-temps">220°→220°  60°→60°</div>
            <div className="progress"><div className="progress-fill" style={{ width: "38%" }}></div></div>
            <div className="pc-actions">
              <button className="btn btn-secondary btn-sm" style={{ color: "var(--state-warn)", borderColor: "rgba(245,158,11,.30)" }}>Пауза</button>
              <button className="btn btn-danger btn-sm">Стоп</button>
            </div>
          </div>

          {/* Ready */}
          <div className="printer-card ok">
            <div className="pc-head">
              <div><div className="pc-id">A4</div><div className="pc-model">Bambu Lab A1</div></div>
              <Dot color="var(--state-ok)" />
            </div>
            <div className="pc-status ok">готовий</div>
            <div><div className="pc-file">cache/A1 Flexi Cheetah Long Tail…</div><div className="pc-eta">завершено · 1хв тому</div></div>
            <div className="pc-temps">29°  31°</div>
            <div style={{ padding: "8px", background: "rgba(34,197,94,.08)", border: "1px solid rgba(34,197,94,.15)", borderRadius: "var(--r-sm)", textAlign: "center", fontSize: 12, color: "var(--state-ok)", fontWeight: 500 }}>Стіл очищено</div>
          </div>

          {/* Paused */}
          <div className="printer-card warn">
            <div className="pc-head">
              <div><div className="pc-id">MC1</div><div className="pc-model">Bambu Lab P1S</div></div>
              <Dot color="var(--state-warn)" />
            </div>
            <div className="pc-status warn">на паузі</div>
            <div style={{ padding: "6px 10px", background: "rgba(239,68,68,.08)", border: "1px solid rgba(239,68,68,.15)", borderRadius: "var(--r-sm)", fontSize: 12, color: "var(--state-error)" }}>The build plate may not be pro…</div>
            <div><div className="pc-file">6s3p_PETG_50m16s_2mf.3mf</div><div className="pc-eta">пауза · 3хв</div></div>
            <div className="pc-actions">
              <button className="btn btn-primary btn-sm"><Icon icon={ArrowRight} size={11} /> Resume</button>
              <button className="btn btn-danger btn-sm">Стоп</button>
            </div>
          </div>

          {/* Error */}
          <div className="printer-card error">
            <div className="pc-head">
              <div><div className="pc-id">A11</div><div className="pc-model">Bambu Lab A1</div></div>
              <Dot color="var(--state-error)" />
            </div>
            <div className="pc-status error">помилка</div>
            <div style={{ padding: "6px 10px", background: "rgba(239,68,68,.08)", border: "1px solid rgba(239,68,68,.15)", borderRadius: "var(--r-sm)", fontSize: 11.5, color: "var(--state-error)", fontFamily: "var(--font-mono)" }}>Помилка друку: 0x12ffc003</div>
            <div><div className="pc-file">Збірка_PLA_4h41m.3mf</div><div className="pc-eta">1хв залишилось</div></div>
            <div className="pc-temps">26°  26°</div>
            <div className="pc-actions">
              <button className="btn btn-secondary btn-sm">Подробиці</button>
              <button className="btn btn-danger btn-sm">Скасувати</button>
            </div>
          </div>

          {/* Offline */}
          <div className="printer-card" style={{ opacity: .7 }}>
            <div className="pc-head">
              <div><div className="pc-id">M11</div><div className="pc-model">Bambu Lab P1S</div></div>
              <Dot color="var(--state-offline)" />
            </div>
            <div className="pc-status" style={{ color: "var(--state-offline)" }}>офлайн</div>
            <div className="pc-file muted">Last seen 2h ago</div>
            <div className="pc-actions">
              <button className="btn btn-secondary btn-sm"><Icon icon={RefreshCw} size={11} /> Reconnect</button>
            </div>
          </div>

          {/* Idle */}
          <div className="printer-card">
            <div className="pc-head">
              <div><div className="pc-id">A8</div><div className="pc-model">Bambu Lab A1</div></div>
              <Dot color="var(--state-idle)" />
            </div>
            <div className="pc-status muted">простоює</div>
            <div className="pc-file muted">No active job</div>
            <div className="pc-actions">
              <button className="btn btn-primary btn-sm"><Icon icon={Plus} size={11} /> Send file</button>
            </div>
          </div>
        </div>
      </Section>

      {/* 8 · Stat strip */}
      <Section id="statstrip" num="8.2" title="Stat strip">
        <div className="demo-stat-row">
          <div className="demo-stat print">
            <div className="demo-stat-label">NEXT FINISH</div>
            <div className="demo-stat-value">5m</div>
            <div className="demo-stat-meta">M2</div>
            <div className="demo-stat-bar"></div>
          </div>
          <div className="demo-stat error">
            <div className="demo-stat-label">ATTENTION</div>
            <div className="demo-stat-value">0</div>
            <div className="demo-stat-meta">all clear</div>
            <div className="demo-stat-bar"></div>
          </div>
          <div className="demo-stat ok">
            <div className="demo-stat-label">READY</div>
            <div className="demo-stat-value">5</div>
            <div className="demo-stat-meta">A4 · A5 · A6 …</div>
            <div className="demo-stat-bar"></div>
          </div>
          <div className="demo-stat warn">
            <div className="demo-stat-label">PAUSED</div>
            <div className="demo-stat-value">1</div>
            <div className="demo-stat-meta">MC1</div>
            <div className="demo-stat-bar"></div>
          </div>
          <div className="demo-stat print">
            <div className="demo-stat-label">PRINTING</div>
            <div className="demo-stat-value">17</div>
            <div className="demo-stat-meta">A &amp; M groups</div>
            <div className="demo-stat-bar"></div>
          </div>
        </div>
      </Section>

      {/* 9 · Table */}
      <Section id="table" num="7.5" title="Table · warehouse density">
        {/* topbar */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", background: "var(--surface-2)", border: "1px solid var(--border)", borderBottom: "none", borderRadius: "var(--r-lg) var(--r-lg) 0 0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 10px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", fontSize: 12, color: "var(--text-faint)", flex: 1, maxWidth: 280 }}>
            <Icon icon={Search} size={12} strokeWidth={1.8} />
            Search 247 items…
          </div>
          <button className="btn btn-ghost btn-sm"><Icon icon={ChevronDown} size={12} /> Filter</button>
          <button className="btn btn-ghost btn-sm">Sort</button>
          <span className="faint" style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, padding: "0 8px", borderLeft: "1px solid var(--border)" }}>3 selected</span>
          <button className="btn btn-secondary btn-sm">Bulk edit</button>
          <button className="btn btn-primary btn-sm"><Icon icon={Plus} size={12} /> New item</button>
        </div>
        <div className="table-wrap" style={{ borderRadius: "0 0 var(--r-lg) var(--r-lg)", borderTop: "none" }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 36 }}><input type="checkbox" style={{ accentColor: "var(--accent)" }} /></th>
                <th style={{ minWidth: 200 }}>SKU ↑</th>
                <th>Article</th>
                <th>Brand</th>
                <th style={{ textAlign: "right" }}>Stock</th>
                <th style={{ textAlign: "right" }}>Cost / kg</th>
                <th style={{ textAlign: "right" }}>Margin</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr style={{ background: "var(--accent-soft)" }}>
                <td><input type="checkbox" defaultChecked style={{ accentColor: "var(--accent)" }} /></td>
                <td><div style={{ display: "flex", alignItems: "center", gap: 10 }}><span style={{ width: 10, height: 10, borderRadius: "50%", background: "#fafafa", border: "1px solid rgba(0,0,0,.15)", flexShrink: 0 }}></span>PLA Білий · Bambu Lab</div></td>
                <td className="table-muted" style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>9H2L-BMB</td>
                <td>Bambu</td>
                <td className="table-num">2.400 <span className="faint">kg</span></td>
                <td className="table-num">550 ₴</td>
                <td className="table-num" style={{ color: "var(--state-ok)" }}>+49.1%</td>
                <td><span className="badge badge-ok">in stock</span></td>
              </tr>
              <tr>
                <td><input type="checkbox" style={{ accentColor: "var(--accent)" }} /></td>
                <td><div style={{ display: "flex", alignItems: "center", gap: 10 }}><span style={{ width: 10, height: 10, borderRadius: "50%", background: "#1f1f23", flexShrink: 0 }}></span>PETG Чорний · Polydream</div></td>
                <td className="table-muted" style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>XJHYB-PDM</td>
                <td>Polydream</td>
                <td className="table-num" style={{ color: "var(--state-warn)" }}>0.120 <span className="faint">kg</span></td>
                <td className="table-num">490 ₴</td>
                <td className="table-num" style={{ color: "var(--state-ok)" }}>+59.2%</td>
                <td><span className="badge badge-warn">reorder</span></td>
              </tr>
              <tr>
                <td><input type="checkbox" style={{ accentColor: "var(--accent)" }} /></td>
                <td><div style={{ display: "flex", alignItems: "center", gap: 10 }}><span style={{ width: 10, height: 10, borderRadius: "50%", background: "#ef4444", flexShrink: 0 }}></span>ABS Red · eSUN</div></td>
                <td className="table-muted" style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>7K2M-ESN</td>
                <td>eSUN</td>
                <td className="table-num" style={{ color: "var(--state-error)" }}>0.000 <span className="faint">kg</span></td>
                <td className="table-num">600 ₴</td>
                <td className="table-num table-muted">—</td>
                <td><span className="badge badge-error">out</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      {/* 10 · Modal & Toast */}
      <Section id="overlays" num="7.6" title="Modal & Toast">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
          <div>
            <SubLabel>Modal panel</SubLabel>
            <div className="modal-panel">
              <div className="modal-head">
                <div className="modal-title">Confirm stop print?</div>
                <button className="btn btn-ghost btn-icon btn-sm"><Icon icon={X} size={14} /></button>
              </div>
              <div className="modal-sub">This will stop the current job on A1. The print cannot be resumed after cancellation.</div>
              <div style={{ padding: "10px 12px", background: "rgba(239,68,68,.08)", border: "1px solid rgba(239,68,68,.15)", borderRadius: "var(--r-sm)", fontSize: 12, color: "var(--state-error)", fontFamily: "var(--font-mono)" }}>A1 · Збірка_PLA_12h48m.3mf · 38%</div>
              <div className="modal-actions">
                <button className="btn btn-ghost btn-sm">Cancel</button>
                <button className="btn btn-danger btn-sm">Stop print</button>
              </div>
            </div>
          </div>
          <div>
            <SubLabel>Toast variants</SubLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="toast-item success">
                <div className="toast-icon"><Icon icon={Check} size={18} /></div>
                <div className="toast-body">
                  <div className="toast-title">Print started</div>
                  <div className="toast-msg">A1 · Збірка_PLA_12h48m.3mf</div>
                </div>
              </div>
              <div className="toast-item error">
                <div className="toast-icon"><Icon icon={AlertTriangle} size={18} /></div>
                <div className="toast-body">
                  <div className="toast-title">Print failed</div>
                  <div className="toast-msg">MC1 · Помилка 0x12ffc003</div>
                </div>
              </div>
              <div className="toast-item info">
                <div className="toast-icon"><Icon icon={Info} size={18} /></div>
                <div className="toast-body">
                  <div className="toast-title">File uploaded</div>
                  <div className="toast-msg">Збірка_PLA_12h48m.3mf · 8.4 MB</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Section>

      {/* 11 · Empty state */}
      <Section id="empty" num="7.7" title="Empty & loading">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div className="empty">
            <div className="empty-icon" style={{ display: "flex", justifyContent: "center" }}>
              <Icon icon={Upload} size={32} strokeWidth={1.2} />
            </div>
            <div className="empty-title">No files yet</div>
            <div className="empty-sub">Upload your first .3mf or .gcode file to get started.</div>
            <button className="btn btn-primary btn-sm"><Icon icon={Plus} size={11} /> Upload file</button>
          </div>
          <div className="empty" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
            <Mascot scale={3} />
            <div className="empty-title" style={{ marginTop: 16 }}>No printers connected</div>
            <div className="empty-sub">Mono is waiting. Add a printer to get started.</div>
            <button className="btn btn-primary btn-sm"><Icon icon={Plus} size={11} /> Add printer</button>
          </div>
        </div>
      </Section>

      {/* 12 · Icons — exact paths from Monofarm Design System (stroke 1.7) */}
      <Section id="icons" num="6.0" title="Iconography · 24×24, stroke 1.7, round caps">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 4 }}>
          {([
            ["dashboard",   false, <><rect x="3" y="3" width="7" height="9" rx="1.6"/><rect x="3" y="15" width="7" height="6" rx="1.6"/><rect x="14" y="3" width="7" height="6" rx="1.6"/><rect x="14" y="12" width="7" height="9" rx="1.6"/></>],
            ["plan",        false, <><rect x="3" y="4" width="7" height="16" rx="1.6"/><rect x="14" y="4" width="7" height="10" rx="1.6"/></>],
            ["tasks",       false, <><path d="M3.5 7l1.5 1.5L8 5.2"/><path d="M3.5 16.6l1.5 1.5L8 14.8"/><path d="M11.5 6.7h9"/><path d="M11.5 16.3h9"/></>],
            ["files",       false, <><path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z"/><path d="M13 3v6h6"/></>],
            ["analytics",   false, <><path d="M4 4v15a1 1 0 0 0 1 1h15"/><path d="M7.5 14.5l3.5-4 3 2.2 4.5-6"/></>],
            ["history",     false, <><path d="M3.6 9a9 9 0 1 0 2.3-3.8"/><path d="M3.5 4.5V9H8"/><path d="M12 8v4.2l3 1.8"/></>],
            ["filament",    false, <><circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="2.6"/><path d="M18.4 7.4 22 5.8"/></>],
            ["warehouse",   false, <><rect x="3" y="4" width="18" height="16" rx="1.6"/><path d="M3 12h18"/><rect x="6" y="6.6" width="4.4" height="3.4" rx="0.6"/><rect x="13.2" y="14" width="4.6" height="3.6" rx="0.6"/></>],
            ["users",       false, <><circle cx="9.5" cy="8" r="3.3"/><path d="M3.8 19.5a5.7 5.7 0 0 1 11.4 0"/><path d="M16.5 5.2a3.3 3.3 0 0 1 0 6.1"/><path d="M17 14.3a5.7 5.7 0 0 1 3.7 5.2"/></>],
            ["settings",    false, <><path d="M4 7h8.4"/><path d="M16.6 7H20"/><circle cx="14.5" cy="7" r="2.1"/><path d="M4 17h3.4"/><path d="M11.6 17H20"/><circle cx="9.5" cy="17" r="2.1"/></>],
            ["3d printer",  false, <><rect x="4" y="3" width="16" height="18" rx="2.2"/><rect x="7" y="5.6" width="10" height="8.4" rx="1.2"/><path d="M8.8 11.6h6.4"/><path d="M10.8 11.6v-1.8h2.4v1.8"/><path d="M4 17h16"/></>],
            ["play",        false, <><path d="M7 5.4v13.2a1 1 0 0 0 1.52.86l10.5-6.6a1 1 0 0 0 0-1.72L8.52 4.54A1 1 0 0 0 7 5.4z"/></>],
            ["pause",       false, <><rect x="7" y="5" width="3.4" height="14" rx="1.5"/><rect x="13.6" y="5" width="3.4" height="14" rx="1.5"/></>],
            ["stop",        false, <><rect x="6" y="6" width="12" height="12" rx="2.6"/></>],
            ["refresh",     false, <><path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M20.5 4.5V9.5H15.5"/></>],
            ["search",      false, <><circle cx="11" cy="11" r="7.2"/><path d="M16.5 16.5 21 21"/></>],
            ["plus",        false, <><path d="M12 5v14"/><path d="M5 12h14"/></>],
            ["close",       false, <><path d="M17.5 6.5l-11 11"/><path d="M6.5 6.5l11 11"/></>],
            ["check",       false, <><path d="M5 12.5l4.5 4.5L19 6.5"/></>],
            ["chevron",     false, <><path d="M6 9.5l6 6 6-6"/></>],
            ["download",    false, <><path d="M5 20h14"/><path d="M12 4v11"/><path d="M7.5 10.5 12 15l4.5-4.5"/></>],
            ["upload",      false, <><path d="M5 20h14"/><path d="M12 16V5"/><path d="M7.5 9.5 12 5l4.5 4.5"/></>],
            ["layers",      false, <><path d="M12 3l8.5 4.6-8.5 4.6L3.5 7.6 12 3z"/><path d="M4 12.2l8 4.3 8-4.3"/><path d="M4 16.4l8 4.3 8-4.3"/></>],
            ["temperature", false, <><path d="M14 14.8V5.5a2.5 2.5 0 0 0-5 0v9.3a4.2 4.2 0 1 0 5 0z"/><path d="M11.5 14V9"/></>],
            ["alert",       false, <><path d="M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4"/><path d="M12 17h.01"/></>],
            ["info",        false, <><circle cx="12" cy="12" r="8.8"/><path d="M12 11v5.2"/><path d="M12 7.8h.01"/></>],
            ["message",     false, <><path d="M20 4H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3v4l4.5-4H20a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/></>],
            ["phone",       false, <><path d="M6.8 3.5H4.4A1.6 1.6 0 0 0 2.8 5.1 16.6 16.6 0 0 0 18.9 21.2a1.6 1.6 0 0 0 1.6-1.6v-2.3a1.6 1.6 0 0 0-1.4-1.6l-2.5-.34a1.6 1.6 0 0 0-1.45.66l-.7.95a12.6 12.6 0 0 1-5.7-5.7l.95-.7a1.6 1.6 0 0 0 .66-1.45L9.7 5.1A1.6 1.6 0 0 0 8.1 3.5z"/></>],
            ["globe",       false, <><circle cx="12" cy="12" r="8.8"/><path d="M3.2 12h17.6"/><path d="M12 3.2a13.5 13.5 0 0 1 0 17.6 13.5 13.5 0 0 1 0-17.6z"/></>],
            ["grid",        false, <><rect x="3.5" y="3.5" width="7" height="7" rx="1.4"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.4"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.4"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.4"/></>],
            ["list",        false, <><path d="M8 6.5h12.5"/><path d="M8 12h12.5"/><path d="M8 17.5h12.5"/><path d="M3.6 6.5h.01"/><path d="M3.6 12h.01"/><path d="M3.6 17.5h.01"/></>],
            ["more",        true,  <><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></>],
          ] as [string, boolean, React.ReactNode][]).map(([label, filled, content], i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "12px 0", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", background: "var(--surface)", color: "var(--text-muted)", cursor: "pointer" }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "var(--accent)"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--text-muted)"; }}>
              <svg width="18" height="18" viewBox="0 0 24 24"
                fill={filled ? "currentColor" : "none"}
                stroke={filled ? "none" : "currentColor"}
                strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                {content}
              </svg>
              <span style={{ fontFamily: "var(--font-mono, ui-monospace)", fontSize: 9.5, color: "var(--text-dim)", letterSpacing: ".03em" }}>{label}</span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
