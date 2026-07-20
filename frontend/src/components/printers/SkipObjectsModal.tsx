"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, MousePointer2 } from "lucide-react";
import { toast } from "sonner";

import { Modal } from "@/components/ui/Modal";
import { ApiError, api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import type { Printer } from "@/lib/types";

export interface SkipObjectItem {
  id: string;
  name: string;
  excluded: boolean;
  current: boolean;
  bounds: [number, number, number, number] | null;
}

interface SkipObjectsState {
  available: boolean;
  reason: string | null;
  objects: SkipObjectItem[];
  remaining_count?: number;
  updated_at?: string | null;
}

export function selectableSkipCount(objects: SkipObjectItem[]): number {
  const remaining = objects.filter((object) => !object.excluded).length;
  return Math.max(0, remaining - 1);
}

function fallbackBounds(index: number, count: number): [number, number, number, number] {
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / columns));
  const column = index % columns;
  const row = Math.floor(index / columns);
  const width = 0.56 / columns;
  const height = 0.56 / rows;
  const left = 0.22 + column * (0.56 / columns) + width * 0.14;
  const top = 0.22 + row * (0.56 / rows) + height * 0.14;
  return [left, top, left + width * 0.72, top + height * 0.72];
}

function reasonText(reason: string | null, t: ReturnType<typeof useT>): string | null {
  if (!reason) return null;
  const keys = {
    not_printing: "printers.skipObjects.notPrinting",
    not_started_from_monofarm: "printers.skipObjects.notStartedFromMonofarm",
    file_unavailable: "printers.skipObjects.fileUnavailable",
    missing_object_labels: "printers.skipObjects.missingLabels",
    single_object: "printers.skipObjects.singleObject",
  } as const;
  return t(keys[reason as keyof typeof keys] ?? "printers.skipObjects.unavailable");
}

export function SkipObjectsContent({
  printerName,
  objects,
  selectedIds,
  onToggle,
  loading,
  unavailableReason,
}: {
  printerName: string;
  objects: SkipObjectItem[];
  selectedIds: Set<string>;
  onToggle: (objectId: string) => void;
  loading: boolean;
  unavailableReason: string | null;
}) {
  const t = useT();
  const maxSelectable = selectableSkipCount(objects);
  const unavailable = reasonText(unavailableReason, t);

  return (
    <div className="space-y-4">
      <div className="text-center">
        <p className="text-sm font-semibold text-[var(--text)]">{printerName}</p>
        <p className="mx-auto mt-1 max-w-lg text-xs leading-5 text-[var(--text-muted)]">
          {t("printers.skipObjects.description")}
        </p>
      </div>

      {loading && objects.length === 0 ? (
        <div className="grid aspect-square w-full animate-pulse place-items-center rounded-xl border border-[var(--border)] bg-[var(--surface)] text-xs text-[var(--text-muted)] sm:aspect-[4/3]">
          {t("common.loading")}
        </div>
      ) : objects.length > 0 ? (
        <>
          <div
            data-skip-bed="true"
            className="relative mx-auto aspect-square w-full max-w-[520px] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-inner"
            style={{
              backgroundImage: "linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)",
              backgroundSize: "10% 10%",
            }}
          >
            <div className="pointer-events-none absolute inset-3 rounded-lg border border-[var(--border-strong)]" />
            {objects.map((object, index) => {
              const [x1, y1, x2, y2] = object.bounds ?? fallbackBounds(index, objects.length);
              const selected = selectedIds.has(object.id);
              const selectionBlocked = !selected && maxSelectable > 0 && selectedIds.size >= maxSelectable;
              return (
                <button
                  key={object.id}
                  type="button"
                  data-object-id={object.id}
                  data-selected={selected}
                  disabled={object.excluded || selectionBlocked}
                  aria-label={object.name}
                  aria-pressed={selected}
                  onClick={() => onToggle(object.id)}
                  className={`absolute grid min-h-7 min-w-7 place-items-center rounded border-2 transition ${
                    object.excluded
                      ? "border-[var(--state-offline)] bg-[var(--state-offline)]/20 opacity-50"
                      : selected
                        ? "border-[var(--state-warn)] bg-[var(--state-warn)]/45 shadow-[0_0_0_3px_rgba(245,158,11,.12)]"
                        : "border-[var(--state-print)] bg-[var(--state-print)]/35 hover:bg-[var(--state-print)]/50"
                  }`}
                  style={{
                    left: `${Math.max(0, x1) * 100}%`,
                    top: `${Math.max(0, y1) * 100}%`,
                    width: `${Math.max(0.04, x2 - x1) * 100}%`,
                    height: `${Math.max(0.04, y2 - y1) * 100}%`,
                  }}
                >
                  {selected && <Check size={15} strokeWidth={3} className="text-[var(--bg)]" aria-hidden="true" />}
                </button>
              );
            })}
            <span className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)]/90 px-2 py-1 text-[10px] text-[var(--text-muted)] backdrop-blur">
              <MousePointer2 size={11} aria-hidden="true" /> {t("printers.skipObjects.selectOnBed")}
            </span>
          </div>

          <div className="max-h-56 divide-y divide-[var(--border)] overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]">
            {objects.map((object) => {
              const selected = selectedIds.has(object.id);
              const selectionBlocked = !selected && maxSelectable > 0 && selectedIds.size >= maxSelectable;
              return (
                <button
                  key={object.id}
                  type="button"
                  data-object-id={object.id}
                  data-selected={selected}
                  disabled={object.excluded || selectionBlocked}
                  onClick={() => onToggle(object.id)}
                  className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition hover:bg-[var(--surface-hi)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className={`grid size-5 shrink-0 place-items-center rounded border ${selected ? "border-[var(--state-warn)] bg-[var(--state-warn)] text-[var(--bg)]" : "border-[var(--border-strong)]"}`}>
                    {selected && <Check size={13} strokeWidth={3} aria-hidden="true" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-sm font-medium ${object.excluded ? "line-through" : ""}`}>{object.name}</span>
                    <span className="mt-0.5 block font-mono text-[10px] text-[var(--text-faint)]">ID {object.id}</span>
                  </span>
                  {object.current && <span className="shrink-0 rounded-full bg-[var(--state-print)]/12 px-2 py-1 text-[10px] font-semibold text-[var(--state-print)]">{t("printers.skipObjects.printingNow")}</span>}
                  {object.excluded && <span className="shrink-0 text-[10px] font-semibold text-[var(--text-faint)]">{t("printers.skipObjects.skipped")}</span>}
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <div className="rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface)] px-5 py-8 text-center">
          <p className="text-sm font-semibold text-[var(--text)]">{unavailable ?? t("printers.skipObjects.unavailable")}</p>
          {unavailableReason === "missing_object_labels" && (
            <p className="mt-2 text-xs leading-5 text-[var(--text-muted)]">
              {t("printers.skipObjects.slicerHint")}
            </p>
          )}
        </div>
      )}

      {objects.length > 0 && unavailable && (
        <p className="rounded-lg bg-[var(--surface)] px-3 py-2 text-center text-xs text-[var(--text-muted)]">{unavailable}</p>
      )}
    </div>
  );
}

export function SkipObjectsModal({
  open,
  printer,
  onClose,
}: {
  open: boolean;
  printer: Printer;
  onClose: () => void;
}) {
  const t = useT();
  const [state, setState] = useState<SkipObjectsState | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const loadingRef = useRef(false);

  const refresh = useCallback(async (showLoading = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    if (showLoading) setLoading(true);
    try {
      const next = await api<SkipObjectsState>(`/api/printers/${printer.id}/print/skip-objects`);
      setState(next);
      const selectable = new Set(next.objects.filter((object) => !object.excluded).map((object) => object.id));
      setSelectedIds((current) => new Set([...current].filter((id) => selectable.has(id))));
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : t("common.error"));
    } finally {
      loadingRef.current = false;
      if (showLoading) setLoading(false);
    }
  }, [printer.id, t]);

  useEffect(() => {
    if (!open) return;
    const initial = window.setTimeout(() => void refresh(true), 0);
    const timer = window.setInterval(() => void refresh(false), 1_500);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [open, refresh]);

  const maxSelectable = useMemo(
    () => selectableSkipCount(state?.objects ?? []),
    [state?.objects],
  );

  function toggle(objectId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(objectId)) next.delete(objectId);
      else if (next.size < maxSelectable) next.add(objectId);
      return next;
    });
  }

  async function submit() {
    if (!selectedIds.size || submitting) return;
    setSubmitting(true);
    try {
      await api(`/api/printers/${printer.id}/print/skip-objects`, {
        method: "POST",
        body: JSON.stringify({ object_ids: [...selectedIds] }),
      });
      toast.success(t("printers.skipObjects.commandSent"));
      setSelectedIds(new Set());
      window.setTimeout(() => void refresh(false), 500);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : t("common.error"));
    } finally {
      setSubmitting(false);
    }
  }

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <Modal
      open={open}
      onClose={onClose}
      title={t("printers.skipObjects.title")}
      size="2xl"
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:items-center">
          <p className="flex flex-1 items-start gap-1.5 text-[11px] leading-4 text-[var(--text-muted)]">
            <AlertTriangle size={14} className="mt-px shrink-0 text-[var(--state-warn)]" aria-hidden="true" />
            {t("printers.skipObjects.warning")}
          </p>
          <button type="button" onClick={onClose} className="btn-secondary px-4 py-2 text-xs">{t("common.cancel")}</button>
          <button
            type="button"
            onClick={submit}
            disabled={!selectedIds.size || submitting || !state?.available}
            className="rounded-md bg-[var(--state-warn)] px-4 py-2 text-xs font-bold text-[var(--bg)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? t("common.sending") : `${t("printers.skipObjects.skipSelected")} · ${selectedIds.size}`}
          </button>
        </div>
      }
    >
      <SkipObjectsContent
        printerName={[printer.name, printer.bambu_model].filter(Boolean).join(" · ")}
        objects={state?.objects ?? []}
        selectedIds={selectedIds}
        onToggle={toggle}
        loading={loading}
        unavailableReason={state?.reason ?? null}
      />
    </Modal>,
    document.body,
  );
}
