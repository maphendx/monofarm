"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import {
  Bot,
  ChevronRight,
  CircleOff,
  FileText,
  Flag,
  Flame,
  Gauge,
  Info,
  Play,
  Settings2,
  Snowflake,
  Tags,
  Terminal,
  Trash2,
  Wrench,
} from "lucide-react";

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { useTags } from "@/hooks/useTags";
import { ApiError, api } from "@/lib/api";
import { useUser } from "@/lib/auth-context";
import type { Printer } from "@/lib/types";

const MENU_WIDTH = 248;

const PREHEAT_PRESETS: { label: string; nozzle: number; bed: number }[] = [
  { label: "PLA", nozzle: 200, bed: 60 },
  { label: "PETG", nozzle: 240, bed: 80 },
  { label: "ABS", nozzle: 250, bed: 100 },
  { label: "TPU", nozzle: 230, bed: 50 },
];

const BAMBU_SPEED_PROFILES: { profile: number; label: string }[] = [
  { profile: 1, label: "Тихий (50%)" },
  { profile: 2, label: "Стандарт (100%)" },
  { profile: 3, label: "Спорт (124%)" },
  { profile: 4, label: "Максимум (166%)" },
];

const KLIPPER_SPEED_FACTORS = [50, 75, 100, 125, 150];

export interface QuickMenuPos {
  x: number;
  y: number;
}

interface PrinterQuickMenuProps {
  printer: Printer;
  pos: QuickMenuPos | null;
  onClose: () => void;
  onUpdated?: (p: Printer) => void;
  onDeleted?: (id: number) => void;
  onOpenSettings?: (p: Printer) => void;
  onOpenInfo?: (p: Printer) => void;
}

function MenuItem({
  icon,
  label,
  onClick,
  disabled,
  danger,
  title,
  chevron,
}: {
  icon?: React.ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  chevron?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={[
        "flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm transition",
        disabled
          ? "cursor-not-allowed text-[var(--text-faint)]"
          : danger
            ? "text-[var(--state-error)] hover:bg-[rgba(239,68,68,.10)]"
            : "text-[var(--text)] hover:bg-[var(--surface-hi)]",
      ].join(" ")}
    >
      {icon && <span className="shrink-0 text-[var(--text-muted)]">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {chevron && <ChevronRight size={13} className="shrink-0 text-[var(--text-faint)]" />}
    </button>
  );
}

function Divider() {
  return <div className="my-1 border-t border-[var(--border)]" />;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pb-0.5 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--text-faint)]">
      {children}
    </div>
  );
}

export function PrinterQuickMenu(props: PrinterQuickMenuProps) {
  if (!props.pos) return null;
  return <QuickMenuInner {...props} pos={props.pos} />;
}

function QuickMenuInner({
  printer,
  pos,
  onClose,
  onUpdated,
  onDeleted,
  onOpenSettings,
  onOpenInfo,
}: PrinterQuickMenuProps & { pos: QuickMenuPos }) {
  const user = useUser();
  const isAdmin = user.role === "admin";
  const canEdit = isAdmin || user.role === "operator";

  const [submenu, setSubmenu] = useState<"preheat" | "speed" | "tags" | null>(null);
  const [gcodeOpen, setGcodeOpen] = useState(false);
  const [gcodeText, setGcodeText] = useState("");
  const [maintOpen, setMaintOpen] = useState<"maintenance" | "problem" | null>(null);
  const [maintTitle, setMaintTitle] = useState("");
  const [maintDesc, setMaintDesc] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const inFlight = useRef(false);

  const { tags, loading: tagsLoading, setPrinterTags } = useTags();
  const [tagIds, setTagIds] = useState<number[]>(() => (printer.tags ?? []).map((t) => t.id));

  const isBambu = printer.kind === "bambu";
  const hasMoonraker = !!printer.moonraker_url;
  const supportsGcode = hasMoonraker || (isBambu && !!printer.bambu_dev_id);
  const isBusyPrinting = printer.state === "printing" || printer.state === "paused";
  const modalActive = gcodeOpen || maintOpen !== null || confirmDelete;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !modalActive) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, modalActive]);

  // Clamp menu to viewport
  const left = Math.max(8, Math.min(pos.x, window.innerWidth - MENU_WIDTH - 8));
  const maxH = Math.min(560, window.innerHeight - 16);
  const top = Math.max(8, Math.min(pos.y, window.innerHeight - Math.min(maxH, 480) - 8));

  async function run(action: () => Promise<void>, successMsg?: string, close = true) {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await action();
      if (successMsg) toast.success(successMsg);
      if (close) onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Помилка");
    } finally {
      inFlight.current = false;
    }
  }

  const sendGcode = (script: string, successMsg: string) =>
    run(async () => {
      await api(`/api/printers/${printer.id}/gcode`, {
        method: "POST",
        body: JSON.stringify({ script }),
      });
    }, successMsg);

  const preheat = (nozzle: number, bed: number, label: string) =>
    sendGcode(`M140 S${bed}\nM104 S${nozzle}`, `Прогрів ${label}: сопло ${nozzle}°, стіл ${bed}°`);

  const cooldown = () => sendGcode("M104 S0\nM140 S0", "Охолодження запущено");

  const setBambuSpeed = (profile: number, label: string) =>
    run(async () => {
      await api(`/api/printers/${printer.id}/speed-profile`, {
        method: "POST",
        body: JSON.stringify({ profile }),
      });
    }, `Швидкість: ${label}`);

  const setKlipperSpeed = (pct: number) =>
    sendGcode(`M220 S${pct}`, `Швидкість друку: ${pct}%`);

  const toggleOutOfOrder = () =>
    run(async () => {
      const updated = await api<Printer>(`/api/printers/${printer.id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_out_of_order: !printer.is_out_of_order }),
      });
      onUpdated?.(updated);
    }, printer.is_out_of_order ? "Принтер знову в роботі" : "Принтер позначено як несправний");

  const toggleAutoprint = () =>
    run(async () => {
      const updated = await api<Printer>(`/api/printers/${printer.id}/autoprint`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: printer.autoprint_mode === "off" }),
      });
      onUpdated?.(updated);
    }, printer.autoprint_mode === "off" ? "AutoPrint увімкнено" : "AutoPrint вимкнено");

  async function toggleTag(tagId: number) {
    const next = tagIds.includes(tagId) ? tagIds.filter((id) => id !== tagId) : [...tagIds, tagId];
    setTagIds(next);
    try {
      await setPrinterTags(printer.id, next);
      onUpdated?.({ ...printer, tags: tags.filter((t) => next.includes(t.id)) });
    } catch (err) {
      setTagIds(tagIds);
      toast.error(err instanceof ApiError ? err.message : "Помилка");
    }
  }

  const submitGcode = () => {
    const script = gcodeText.trim();
    if (!script) return;
    void sendGcode(script, "G-код надіслано");
  };

  const submitMaintenance = () =>
    run(async () => {
      await api("/api/tasks/farm", {
        method: "POST",
        body: JSON.stringify({
          title: maintTitle.trim(),
          description: maintDesc.trim() || null,
        }),
      });
    }, "Завдання створено");

  const deletePrinter = () =>
    run(async () => {
      await api(`/api/printers/${printer.id}`, { method: "DELETE" });
      onDeleted?.(printer.id);
    }, "Принтер видалено");

  function openMaintenance(mode: "maintenance" | "problem") {
    setMaintTitle(
      mode === "maintenance" ? `Обслуговування: ${printer.name}` : `Проблема: ${printer.name}`,
    );
    setMaintDesc("");
    setMaintOpen(mode);
  }

  const openLogs = () => {
    if (!printer.moonraker_url) return;
    const base = printer.moonraker_url.split("?")[0].replace(/\/+$/, "");
    window.open(`${base}/server/files/klippy.log`, "_blank", "noopener,noreferrer");
    onClose();
  };

  // Portal to <body>: .printer-card has a hover transform, which would make
  // position:fixed children anchor to the card instead of the viewport.
  return createPortal(
    <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {/* Click-away overlay */}
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />

      <div
        className="fixed z-50 overflow-y-auto rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-1.5 shadow-lg"
        style={{ left, top, width: MENU_WIDTH, maxHeight: maxH }}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="truncate px-2.5 pb-1 pt-1 text-xs font-semibold text-[var(--text-muted)]">
          {printer.name}
        </div>

        {/* ── Temperature / speed control ── */}
        {canEdit && (
          <>
            <MenuItem
              icon={<Flame size={14} />}
              label="Прогрів"
              chevron
              disabled={!supportsGcode || isBusyPrinting}
              title={
                !supportsGcode
                  ? "Принтер не підтримує команди"
                  : isBusyPrinting
                    ? "Недоступно під час друку"
                    : undefined
              }
              onClick={() => setSubmenu(submenu === "preheat" ? null : "preheat")}
            />
            {submenu === "preheat" && (
              <div className="ml-6 space-y-0.5">
                {PREHEAT_PRESETS.map((p) => (
                  <MenuItem
                    key={p.label}
                    label={`${p.label} — ${p.nozzle}° / ${p.bed}°`}
                    onClick={() => preheat(p.nozzle, p.bed, p.label)}
                  />
                ))}
              </div>
            )}
            <MenuItem
              icon={<Snowflake size={14} />}
              label="Охолодження"
              disabled={!supportsGcode || isBusyPrinting}
              title={isBusyPrinting ? "Недоступно під час друку" : undefined}
              onClick={cooldown}
            />
            <MenuItem
              icon={<Gauge size={14} />}
              label="Швидкість друку"
              chevron
              disabled={!supportsGcode}
              onClick={() => setSubmenu(submenu === "speed" ? null : "speed")}
            />
            {submenu === "speed" && (
              <div className="ml-6 space-y-0.5">
                {isBambu
                  ? BAMBU_SPEED_PROFILES.map((s) => (
                      <MenuItem
                        key={s.profile}
                        label={s.label}
                        onClick={() => setBambuSpeed(s.profile, s.label)}
                      />
                    ))
                  : KLIPPER_SPEED_FACTORS.map((pct) => (
                      <MenuItem key={pct} label={`${pct}%`} onClick={() => setKlipperSpeed(pct)} />
                    ))}
              </div>
            )}
            <MenuItem
              icon={<Terminal size={14} />}
              label="Надіслати G-код…"
              disabled={!supportsGcode}
              onClick={() => setGcodeOpen(true)}
            />
            <Divider />
          </>
        )}

        {/* ── Printer ── */}
        <MenuItem
          icon={<Info size={14} />}
          label="Інфо про принтер"
          onClick={() => {
            onClose();
            onOpenInfo?.(printer);
          }}
        />
        <MenuItem
          icon={<Settings2 size={14} />}
          label="Налаштування принтера"
          onClick={() => {
            onClose();
            onOpenSettings?.(printer);
          }}
        />
        {canEdit && (
          <>
            <MenuItem
              icon={<Tags size={14} />}
              label="Теги"
              chevron
              onClick={() => setSubmenu(submenu === "tags" ? null : "tags")}
            />
            {submenu === "tags" && (
              <div className="ml-6 max-h-44 space-y-0.5 overflow-y-auto">
                {tagsLoading ? (
                  <div className="px-2.5 py-1 text-xs text-[var(--text-faint)]">Завантаження…</div>
                ) : tags.length === 0 ? (
                  <div className="px-2.5 py-1 text-xs text-[var(--text-faint)]">
                    Тегів немає — створіть у Налаштуваннях
                  </div>
                ) : (
                  tags.map((t) => (
                    <label
                      key={t.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-2.5 py-1 text-sm hover:bg-[var(--surface-hi)]"
                    >
                      <input
                        type="checkbox"
                        checked={tagIds.includes(t.id)}
                        onChange={() => toggleTag(t.id)}
                        className="accent-[var(--accent)]"
                      />
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: t.color ?? "var(--text-faint)" }}
                      />
                      <span className="min-w-0 flex-1 truncate">{t.display || t.label}</span>
                    </label>
                  ))
                )}
              </div>
            )}
          </>
        )}
        <MenuItem
          icon={<FileText size={14} />}
          label="Логи Klipper"
          disabled={!hasMoonraker}
          title={!hasMoonraker ? "Доступно лише для Klipper-принтерів" : undefined}
          onClick={openLogs}
        />
        <Divider />

        {/* ── Automation ── */}
        {canEdit && (
          <>
            <MenuItem
              icon={<Play size={14} />}
              label={printer.autoprint_mode === "off" ? "Увімкнути AutoPrint" : "Вимкнути AutoPrint"}
              disabled={!isBambu}
              title={!isBambu ? "AutoPrint підтримує лише Bambu A1 Mini" : undefined}
              onClick={toggleAutoprint}
            />
            <MenuItem
              icon={<Bot size={14} />}
              label="AI-виявлення браку"
              disabled
              title="Незабаром"
            />
          </>
        )}
        {isAdmin && (
          <MenuItem
            icon={<CircleOff size={14} />}
            label={printer.is_out_of_order ? "Зняти позначку «Не працює»" : "Позначити «Не працює»"}
            onClick={toggleOutOfOrder}
          />
        )}

        {/* ── Maintenance ── */}
        <Divider />
        <SectionLabel>Обслуговування</SectionLabel>
        <MenuItem
          icon={<Wrench size={14} />}
          label="Створити завдання обслуговування"
          onClick={() => openMaintenance("maintenance")}
        />
        <MenuItem
          icon={<Flag size={14} />}
          label="Повідомити про проблему"
          onClick={() => openMaintenance("problem")}
        />

        {isAdmin && (
          <>
            <Divider />
            <MenuItem
              icon={<Trash2 size={14} />}
              label="Видалити принтер"
              danger
              onClick={() => setConfirmDelete(true)}
            />
          </>
        )}
      </div>

      {/* ── Send G-code modal ── */}
      <Modal
        open={gcodeOpen}
        onClose={() => setGcodeOpen(false)}
        title={`G-код → ${printer.name}`}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setGcodeOpen(false)}>
              Скасувати
            </button>
            <button
              type="button"
              className="btn btn-primary disabled:opacity-40"
              disabled={!gcodeText.trim()}
              onClick={submitGcode}
            >
              Надіслати
            </button>
          </>
        }
      >
        <textarea
          value={gcodeText}
          onChange={(e) => setGcodeText(e.target.value)}
          rows={6}
          placeholder={"M104 S200\nM140 S60"}
          className="textarea-field w-full font-mono text-sm"
          autoFocus
        />
        <p className="mt-2 text-xs text-[var(--text-faint)]">
          Кожна команда з нового рядка. Виконується без підтвердження — будьте уважні.
        </p>
      </Modal>

      {/* ── Maintenance / problem modal ── */}
      <Modal
        open={maintOpen !== null}
        onClose={() => setMaintOpen(null)}
        title={maintOpen === "problem" ? "Повідомити про проблему" : "Завдання обслуговування"}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setMaintOpen(null)}>
              Скасувати
            </button>
            <button
              type="button"
              className="btn btn-primary disabled:opacity-40"
              disabled={!maintTitle.trim()}
              onClick={submitMaintenance}
            >
              Створити
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="field">
            <label className="field-label">Назва</label>
            <input
              value={maintTitle}
              onChange={(e) => setMaintTitle(e.target.value)}
              className="input w-full"
              autoFocus
            />
          </div>
          <div className="field">
            <label className="field-label">Опис</label>
            <textarea
              value={maintDesc}
              onChange={(e) => setMaintDesc(e.target.value)}
              rows={3}
              className="textarea-field w-full"
              placeholder={maintOpen === "problem" ? "Що сталося з принтером?" : "Що потрібно зробити?"}
            />
          </div>
          <p className="text-xs text-[var(--text-faint)]">
            Завдання зʼявиться на дошці фермерських задач.
          </p>
        </div>
      </Modal>

      {/* ── Delete confirm ── */}
      <ConfirmDialog
        open={confirmDelete}
        opts={{
          title: "Видалити принтер?",
          message: `«${printer.name}» буде видалено разом із записами плану. Цю дію не можна скасувати.`,
          variant: "danger",
          confirmLabel: "Видалити",
        }}
        onConfirm={deletePrinter}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>,
    document.body,
  );
}
