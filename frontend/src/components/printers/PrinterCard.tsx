"use client";

import { useState, useRef, useEffect } from "react";
import { toast } from "sonner";

import { SlotStrip } from "@/components/printers/SlotStrip";
import { PrinterQuickMenu, type QuickMenuPos } from "@/components/printers/PrinterQuickMenu";
import { API_URL, ApiError, api, getToken } from "@/lib/api";
import { useUser } from "@/lib/auth-context";
import {
  flagLabel,
  kindLabel,
  printerTone,
  stateLabel,
} from "@/lib/printerLabels";
import { StateIcon } from "@/components/printers/StateIcon";
import { useT } from "@/lib/i18n";
import type { Printer } from "@/lib/types";

// Maps printerTone → .printer-card state modifier class
const TONE_CLASS: Record<string, string> = {
  printing: "printing",
  ok:       "ok",
  warn:     "warn",
  bad:      "error",
  idle:     "idle",
  muted:    "muted",
};

function formatEta(min: number | null): string | null {
  if (!min || min <= 0) return null;
  if (min < 60) return `${min}хв`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}г ${m}хв` : `${h}год`;
}

export function PrinterCard({
  printer,
  onClick,
  onSettings,
  onUpdated,
  onPrint,
  onDeleted,
}: {
  printer: Printer;
  onClick?: (p: Printer) => void;
  onSettings?: (p: Printer) => void;
  onUpdated?: (p: Printer) => void;
  onPrint?: (p: Printer) => void;
  onDeleted?: (id: number) => void;
}) {
  const t = useT();
  const user = useUser();
  const tone = printerTone(printer);
  const eta = formatEta(printer.eta_minutes);

  const isPrinting = printer.state === "printing";
  const isPaused = printer.state === "paused";
  const isIdle = printer.state === "idle";
  const isError = printer.state === "error";
  const needsClearBed = printer.state === "awaiting_bed_clear" ||
    (printer.state === "operational" && (!!printer.job || (printer.progress_pct ?? 0) >= 100));
  const canStartPrint = (isIdle || printer.state === "operational") && !needsClearBed && !printer.is_out_of_order;
  const hasMoonraker = !!printer.moonraker_url;
  const canEdit = user.role === "admin" || user.role === "operator";
  const isActionable = (isPrinting || isPaused || isError || needsClearBed || canStartPrint) && canEdit;
  const showProgress = isPrinting && printer.progress_pct != null;

  const [busy, setBusy] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmClearBed, setConfirmClearBed] = useState(false);
  const [menuPos, setMenuPos] = useState<QuickMenuPos | null>(null);
  const [camOpen, setCamOpen] = useState(false);
  const inFlightRef = useRef(false);

  // ── in-card live camera (reuses the detail-page stream/snapshot endpoints) ──
  const isBambuCam = printer.kind === "bambu" && !!printer.bambu_dev_ip;
  const hasCamera = hasMoonraker || isBambuCam;
  const [camTick, setCamTick] = useState(0);
  const [camLoaded, setCamLoaded] = useState(false);
  const [camError, setCamError] = useState(false);

  // Moonraker/agent snapshot refreshes on a tick; Bambu is a continuous stream.
  useEffect(() => {
    if (!camOpen || isBambuCam || !hasCamera) return;
    const id = setInterval(() => { if (!document.hidden) setCamTick((n) => n + 1); }, 2500);
    return () => clearInterval(id);
  }, [camOpen, isBambuCam, hasCamera]);

  useEffect(() => { if (!isBambuCam) setCamLoaded(false); }, [camTick, isBambuCam]);

  const camSrc = isBambuCam
    ? `${API_URL}/api/printers/${printer.id}/camera/stream?token=${getToken()}`
    : `${API_URL}/api/printers/${printer.id}/webcam/snapshot?t=${camTick}&token=${getToken()}`;

  async function act(e: React.MouseEvent, action: string) {
    e.stopPropagation();
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setConfirmCancel(false);
    setConfirmClearBed(false);
    setBusy(action);
    try {
      await api(`/api/printers/${printer.id}/print/${action}`, { method: "POST" });
      const list = await api<Printer[]>("/api/printers");
      const updated = list.find((p) => p.id === printer.id);
      if (updated) onUpdated?.(updated);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Помилка");
    } finally {
      setBusy(null);
      inFlightRef.current = false;
    }
  }

  const toneClass = TONE_CLASS[tone];

  return (
    <div
      data-printer-id={printer.id}
      role="button"
      tabIndex={0}
      onClick={() => !camOpen && onClick?.(printer)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenuPos({ x: e.clientX, y: e.clientY });
      }}
      onKeyDown={(e) => e.key === "Enter" && !camOpen && onClick?.(printer)}
      className={[
        "printer-card cursor-pointer text-left",
        toneClass,
        camOpen ? "cam-open" : "",
      ].join(" ")}
    >
      {/* ═══ BANNER HEADER ═══ */}
      <header className="band">
        <div className="band-id">
          <div className="name">{printer.name}</div>
          <span className="pill">
            {isPrinting && <span className="dot live" />}
            {stateLabel(printer.state)}
          </span>
        </div>
        <div className="tools">
          {/* Gear / Settings */}
          {onSettings && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onSettings(printer); }}
              title={t("common.settings")}
              className="tool"
              aria-label={t("common.settings")}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15H4.5a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 6 9.4l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 12 4.6a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 2.82 1.17l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 12z"/>
              </svg>
            </button>
          )}

          {/* Camera — only when the printer actually has one */}
          {hasCamera && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setCamError(false); setCamOpen(!camOpen); }}
              title={t("common.camera")}
              className={["tool", camOpen ? "active" : ""].join(" ")}
              aria-label={t("common.camera")}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="m23 7-7 5 7 5V7z"/>
                <rect x="1" y="5" width="15" height="14" rx="2"/>
              </svg>
            </button>
          )}

          {/* Expand / Detail */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onClick?.(printer); }}
            title={t("common.open")}
            className="tool"
            aria-label={t("common.open")}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
            </svg>
          </button>
        </div>
      </header>

      {/* ═══ BODY — Status, File, Progress, Tags, Actions ═══ */}
      <div className="body">
        {/* File + Queue position */}
        {printer.job && (
          <div className="file-row">
            <span className="file">{printer.job}</span>
            {/* TODO: Add queue position if available */}
          </div>
        )}

        {/* Progress bar + ETA */}
        {showProgress && (
          <>
            <div className="prog">
              <div
                className="prog-fill"
                style={{ width: `${printer.progress_pct}%` }}
              />
            </div>
            <div className="prog-meta">
              <span className="pct">{printer.progress_pct}%</span>
              {eta && <span className="eta">{eta}</span>}
            </div>
          </>
        )}

        {/* Tags */}
        <div className="tags">
          <span className="tags-label">{t("common.tags")}</span>
          <button
            type="button"
            className="tag-add"
            title={t("common.add")}
            onClick={(e) => { e.stopPropagation(); /* TODO: wire tag add */ }}
          >
            +
          </button>
          {printer.loaded_filaments?.map((s, i) => {
            const hex = s.color.startsWith("#") ? s.color.slice(0, 7) : s.color;
            return (
              <span
                key={i}
                className="tag color"
                style={{ background: hex }}
                title={`${s.color_name ?? s.type}${s.brand ? ` · ${s.brand}` : ""}`}
              >
                {s.color_name ?? s.type}
              </span>
            );
          })}
          {printer.tags?.map((t) => (
            <span key={t.id} className="tag">
              {t.display || t.label}
            </span>
          ))}
        </div>

        {/* Footer — Weight + Actions */}
        <footer className="foot">
          <span className="wt">
            {printer.loaded_filaments?.length > 0
              ? `${printer.loaded_filaments.length} ${t("common.slots")}`
              : "—"}
          </span>
          <div className="foot-actions">
            {needsClearBed ? (
              confirmClearBed ? (
                <>
                  <button
                    type="button"
                    onClick={(e) => act(e, "clear-bed")}
                    disabled={busy !== null}
                    className="act collect"
                  >
                    {busy === "clear-bed" ? "…" : t("common.confirm")}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setConfirmClearBed(false); }}
                    className="act"
                  >
                    {t("common.cancel")}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setConfirmClearBed(true); }}
                  disabled={busy !== null}
                  className="act collect"
                >
                  {t("printers.clearBed")}
                </button>
              )
            ) : isPrinting ? (
              <button
                type="button"
                onClick={(e) => act(e, "pause")}
                disabled={busy !== null}
                className="act"
              >
                {busy === "pause" ? "…" : "❚❚ " + t("common.pause")}
              </button>
            ) : isPaused ? (
              <button
                type="button"
                onClick={(e) => act(e, "resume")}
                disabled={busy !== null}
                className="act start"
              >
                {busy === "resume" ? "…" : "▶ " + t("common.resume")}
              </button>
            ) : isError ? (
              <button
                type="button"
                onClick={(e) => act(e, "clear-error")}
                disabled={busy !== null}
                className="act reset"
              >
                {busy === "clear-error" ? "…" : "↺ " + t("common.reset")}
              </button>
            ) : canStartPrint && onPrint ? (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onPrint(printer); }}
                className="act start"
              >
                ▶ {t("common.print")}
              </button>
            ) : null}
          </div>
        </footer>
      </div>

      {/* ═══ CAMERA VIEW — Live feed (hidden by default) ═══ */}
      <div className="cam-view">
        <div className="cam-feed">
          {camOpen && !camError && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={camSrc}
              alt=""
              onLoad={() => setCamLoaded(true)}
              onError={() => setCamError(true)}
              style={{
                position: "absolute", inset: 0, width: "100%", height: "100%",
                objectFit: "cover", opacity: camLoaded ? 1 : 0, transition: "opacity .3s",
              }}
            />
          )}
          {(!camLoaded || camError) && (
            <span className="glyph">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M6 9V2h12v7"/>
                <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
                <path d="M6 14h12v8H6z"/>
              </svg>
            </span>
          )}
          {camLoaded && !camError && (
            <span className="cam-live">
              <span className="dot" />
              LIVE
            </span>
          )}
          {printer.extruder_temp != null || printer.bed_temp != null ? (
            <span className="cam-temps">
              {printer.extruder_temp != null && `🔥 ${Math.round(printer.extruder_temp)}°`}
              {printer.extruder_temp != null && printer.bed_temp != null && " · "}
              {printer.bed_temp != null && `🛏 ${Math.round(printer.bed_temp)}°`}
            </span>
          ) : null}
        </div>
        <div className="cam-controls">
          <button
            type="button"
            className="cam-btn"
            onClick={(e) => { e.stopPropagation(); act(e, "pause"); }}
            title={t("common.pause")}
          >
            <svg viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="5" width="4" height="14" rx="1"/>
              <rect x="14" y="5" width="4" height="14" rx="1"/>
            </svg>
          </button>
          <button
            type="button"
            className="cam-btn stop"
            onClick={(e) => { e.stopPropagation(); act(e, "cancel"); }}
            title={t("common.stop")}
          >
            <svg viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2"/>
            </svg>
          </button>
          <button
            type="button"
            className="cam-btn"
            onClick={(e) => { e.stopPropagation(); /* TODO: home */ }}
            title={t("common.home")}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M3 11l9-8 9 8"/>
              <path d="M5 10v10h14V10"/>
            </svg>
          </button>
          <button
            type="button"
            className="cam-btn"
            onClick={(e) => { e.stopPropagation(); /* TODO: light */ }}
            title={t("common.light")}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12c1 1 1 2 1 3h6c0-1 0-2 1-3a7 7 0 0 0-4-12z"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Quick menu — rendered via portal */}
      {menuPos && (
        <PrinterQuickMenu
          printer={printer}
          pos={menuPos}
          onClose={() => setMenuPos(null)}
          onUpdated={onUpdated}
          onDeleted={onDeleted}
          onOpenSettings={onSettings}
          onOpenInfo={onClick}
        />
      )}
    </div>
  );
}
