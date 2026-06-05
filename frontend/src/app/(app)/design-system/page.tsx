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
      <g stroke="var(--accent)" strokeWidth="1.6" fill="none" opacity=".50" strokeLinecap="round">
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
      <rect x="4" y="0"  width="2" height="1" fill="#22d3ee"/>
      <rect x="4" y="1"  width="2" height="1" fill="#0891b2"/>
      <rect x="2" y="2"  width="6" height="1" fill="#cffafe"/>
      <rect x="1" y="3"  width="8" height="3" fill="#cffafe"/>
      <rect x="2" y="6"  width="6" height="1" fill="#cffafe"/>
      <rect x="2" y="4"  width="2" height="2" fill="#083344"/>
      <rect x="6" y="4"  width="2" height="2" fill="#083344"/>
      <rect x="3" y="4"  width="1" height="1" fill="#fff" opacity="0.65"/>
      <rect x="7" y="4"  width="1" height="1" fill="#fff" opacity="0.65"/>
      <rect x="1" y="5"  width="1" height="1" fill="#f9a8d4" opacity="0.6"/>
      <rect x="8" y="5"  width="1" height="1" fill="#f9a8d4" opacity="0.6"/>
      <rect x="3" y="7"  width="1" height="1" fill="#155e75" opacity="0.45"/>
      <rect x="6" y="7"  width="1" height="1" fill="#155e75" opacity="0.45"/>
      <rect x="2" y="7"  width="6" height="3" fill="#0891b2"/>
      <rect x="3" y="8"  width="4" height="1" fill="#155e75" opacity="0.35"/>
      <rect x="0" y="7"  width="2" height="2" fill="#0891b2"/>
      <rect x="8" y="7"  width="2" height="2" fill="#0891b2"/>
      <rect x="3" y="11" width="2" height="2" fill="#155e75"/>
      <rect x="5" y="10" width="2" height="2" fill="#155e75"/>
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

      {/* 12 · Icons — exact paths from design system HTML section 6.0 */}
      <Section id="icons" num="6.0" title="Iconography · 24×24, stroke 1.6, round caps">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 4 }}>
          {([
            ["dashboard",   <><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/></>],
            ["plan",        <><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></>],
            ["tasks",       <><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></>],
            ["files",       <><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M13 2v7h7"/></>],
            ["analytics",   <path d="M18 20V10M12 20V4M6 20v-6"/>],
            ["history",     <><path d="M12 8v4l3 3"/><path d="M3.05 11a9 9 0 1 1 .5 4M3 16v-5h5"/></>],
            ["filament",    <><path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 8a4 4 0 1 0 4 4"/><path d="M12 12h.01"/></>],
            ["warehouse",   <><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96L12 12.01l8.73-5.05"/><path d="M12 22.08V12"/></>],
            ["users",       <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></>],
            ["settings",    <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.18V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15 1.65 1.65 0 0 0 3 13.4H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></>],
            ["printer",     <><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/><rect x="6" y="18" width="12" height="3"/></>],
            ["play",        <polygon points="5 3 19 12 5 21 5 3"/>],
            ["pause",       <><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></>],
            ["stop",        <rect x="5" y="5" width="14" height="14" rx="1"/>],
            ["refresh",     <><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></>],
            ["search",      <><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></>],
            ["plus",        <><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></>],
            ["close",       <><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></>],
            ["check",       <polyline points="20 6 9 17 4 12"/>],
            ["chevron",     <polyline points="6 9 12 15 18 9"/>],
            ["download",    <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></>],
            ["upload",      <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></>],
            ["layers",      <><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></>],
            ["temperature", <><path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></>],
            ["alert",       <><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></>],
            ["info",        <><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></>],
            ["message",     <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>],
            ["phone",       <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>],
            ["globe",       <><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></>],
            ["grid",        <><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></>],
            ["list",        <><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></>],
            ["more",        <><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></>],
          ] as [string, React.ReactNode][]).map(([label, content], i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "12px 0", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", background: "var(--surface)", color: "var(--text-muted)", cursor: "pointer" }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "var(--accent)"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--text-muted)"; }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
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
