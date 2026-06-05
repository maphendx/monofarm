"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Modal } from "@/components/ui/Modal";
import { ApiError, api } from "@/lib/api";
import { useUser } from "@/lib/auth-context";
import { kindLabel, stateLabel } from "@/lib/printerLabels";
import type { Printer, PrinterKind } from "@/lib/types";
import { TableSkeleton } from "@/components/ui/ContentSkeleton";

// ── add wizard types ──────────────────────────────────────────────────────────

type WizardStep = "choose" | "bambu" | "moonraker" | "manual" | "done";

const KIND_OPTIONS: { value: PrinterKind; label: string; desc: string }[] = [
  { value: "bambu",        label: "Bambu Lab",          desc: "P1S, A1, A1 Mini, X1 — підключення через Bambu Cloud або вручну" },
  { value: "snapmaker_u1", label: "Moonraker / Klipper", desc: "Snapmaker U1, Voron, Ender з Klipper — через Moonraker API" },
  { value: "other",        label: "Вручну",              desc: "Будь-який принтер без API — стан оновлюється вручну" },
];

const KIND_BADGE: Record<string, string> = {
  bambu: "badge badge-ok",
  snapmaker_u1: "badge badge-accent",
  other: "badge badge-neutral",
};

const STATE_DOT: Record<string, string> = {
  printing: "bg-[var(--state-print)]",
  operational: "bg-[var(--state-ok)]",
  idle: "bg-[var(--state-idle)]",
  paused: "bg-[var(--state-warn)]",
  error: "bg-[var(--state-error)]",
  offline: "bg-[var(--state-offline)]",
  unknown: "bg-[var(--state-offline)]",
};

interface PrinterForm {
  name: string;
  kind: PrinterKind;
  moonraker_url: string;
  bambu_dev_id: string;
  bambu_access_code: string;
  bambu_dev_ip: string;
  bambu_model: string;
  is_active: boolean;
}

function emptyForm(): PrinterForm {
  return {
    name: "",
    kind: "snapmaker_u1",
    moonraker_url: "",
    bambu_dev_id: "",
    bambu_access_code: "",
    bambu_dev_ip: "",
    bambu_model: "",
    is_active: true,
  };
}

function printerToForm(p: Printer): PrinterForm {
  return {
    name: p.name,
    kind: p.kind,
    moonraker_url: p.moonraker_url ?? "",
    bambu_dev_id: p.bambu_dev_id ?? "",
    bambu_access_code: "",
    bambu_dev_ip: p.bambu_dev_ip ?? "",
    bambu_model: p.bambu_model ?? "",
    is_active: p.is_active,
  };
}

function inputCls() {
  return "input";
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm">
        {label}
        {hint && <span className="ml-1 text-[var(--text-faint)]">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

// ── wizard icons ──────────────────────────────────────────────────────────────

function WizardTypeCard({ icon, title, desc, badge, onClick }: {
  icon: React.ReactNode; title: string; desc: string; badge?: string; onClick: () => void;
}) {
  return (
    <button onClick={onClick} className="group flex w-full items-center gap-4 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] px-5 py-4 text-left transition hover:border-[var(--border-strong)] hover:shadow-sm   dark:hover:border-[var(--border-strong)]">
      <div className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--bg)] text-[var(--text-muted)]   ">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{title}</span>
          {badge && <span className="badge badge-ok text-[10px]">{badge}</span>}
        </div>
        <p className="mt-0.5 text-xs text-[var(--text-muted)]">{desc}</p>
      </div>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-faint)]"><path d="M9 18l6-6-6-6"/></svg>
    </button>
  );
}

// ── add printer wizard ────────────────────────────────────────────────────────

function AddPrinterWizard({ open, onClose, onDone }: {
  open: boolean; onClose: () => void; onDone: () => void;
}) {
  const router = useRouter();
  const [step, setStep] = useState<WizardStep>("choose");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    if (open) { setStep("choose"); setName(""); setUrl(""); setError(null); }
  }, [open]);

  function back() { setStep("choose"); setError(null); }

  async function createPrinter(body: object) {
    setBusy(true); setError(null);
    try {
      await api("/api/printers", { method: "POST", body: JSON.stringify(body) });
      setStep("done");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка створення");
    } finally {
      setBusy(false);
    }
  }

  async function syncBambu() {
    setSyncing(true); setError(null);
    try {
      await api("/api/printers/sync", { method: "POST" });
      onDone(); onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка синхронізації");
    } finally {
      setSyncing(false);
    }
  }

  const inp = "input";
  const primaryBtn = "btn btn-primary disabled:opacity-50";
  const ghostBtn = "btn btn-ghost";

  return (
    <Modal open={open} onClose={() => { if (!busy && !syncing) onClose(); }} title="Додати принтер">
      <div className="space-y-4">

        {/* choose */}
        {step === "choose" && (
          <div className="space-y-2">
            <p className="text-xs text-[var(--text-muted)] mb-3">Оберіть тип підключення</p>
            <WizardTypeCard
              icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 6v6l4 2"/><path d="M18 2v4h4"/></svg>}
              title="Bambu Lab"
              desc="P1S, A1, X1C — синхронізація через Bambu Cloud акаунт"
              badge="Авто-імпорт"
              onClick={() => setStep("bambu")}
            />
            <WizardTypeCard
              icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/><path d="M7 8h10M7 11h6"/></svg>}
              title="Klipper / Moonraker"
              desc="Snapmaker, Voron, Rat Rig та будь-який Klipper принтер"
              onClick={() => setStep("moonraker")}
            />
            <WizardTypeCard
              icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>}
              title="Ручне відстеження"
              desc="Будь-який принтер — оператор оновлює стан вручну"
              onClick={() => setStep("manual")}
            />
            <button
              onClick={() => { onClose(); router.push("/setup"); }}
              className="w-full text-center text-xs text-[var(--text-faint)] hover:text-[var(--text-muted)] pt-1"
            >
              Не знаєш як підключити свій принтер? Відкрити гід →
            </button>
          </div>
        )}

        {/* bambu */}
        {step === "bambu" && (
          <div className="space-y-4">
            <div className="rounded-lg border border-[rgba(34,197,94,.25)] bg-[rgba(34,197,94,.08)] px-4 py-3 text-sm text-[var(--state-ok)]">
              Bambu принтери підтягуються автоматично з вашого Bambu Cloud акаунту. Натисни синхронізувати — і вони з&apos;являться.
            </div>
            {error && <p className="text-xs text-[var(--state-error)]">{error}</p>}
            <div className="flex gap-2">
              <button onClick={syncBambu} disabled={syncing} className={primaryBtn}>
                {syncing ? "Синхронізація…" : "Синхронізувати Bambu Cloud"}
              </button>
              <button onClick={back} className={ghostBtn}>Назад</button>
            </div>
            <p className="text-xs text-[var(--text-faint)]">
              Немає акаунту? Налаштуй у{" "}
              <a href="/settings" className="underline hover:text-[var(--text-muted)]">Налаштуваннях</a>.
            </p>
          </div>
        )}

        {/* moonraker */}
        {step === "moonraker" && (
          <form onSubmit={(e) => { e.preventDefault(); createPrinter({ name: name.trim(), kind: "snapmaker_u1", moonraker_url: url.trim() }); }} className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-[var(--text-muted)] ">Назва принтера</span>
              <input type="text" required autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Snapmaker J1s" className={inp} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-[var(--text-muted)] ">Moonraker URL</span>
              <input type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://192.168.1.100:7125" className={inp} />
              <span className="mt-1 block text-[11px] text-[var(--text-faint)]">Знайди у Mainsail → Settings → адреса сервера</span>
            </label>
            {error && <p className="text-xs text-[var(--state-error)]">{error}</p>}
            <div className="flex gap-2">
              <button type="submit" disabled={busy || !name || !url} className={primaryBtn}>{busy ? "Додавання…" : "Додати принтер"}</button>
              <button type="button" onClick={back} className={ghostBtn}>Назад</button>
            </div>
          </form>
        )}

        {/* manual */}
        {step === "manual" && (
          <form onSubmit={(e) => { e.preventDefault(); createPrinter({ name: name.trim(), kind: "other" }); }} className="space-y-3">
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-4 py-3 text-xs text-[var(--text-muted)]  ">
              Оператор вручну вказує стан принтера — що друкується, прогрес, статус.
            </div>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-[var(--text-muted)] ">Назва принтера</span>
              <input type="text" required autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Ender-3 #1" className={inp} />
            </label>
            {error && <p className="text-xs text-[var(--state-error)]">{error}</p>}
            <div className="flex gap-2">
              <button type="submit" disabled={busy || !name} className={primaryBtn}>{busy ? "Додавання…" : "Додати принтер"}</button>
              <button type="button" onClick={back} className={ghostBtn}>Назад</button>
            </div>
          </form>
        )}

        {/* done */}
        {step === "done" && (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-[rgba(34,197,94,.12)] text-[var(--state-ok)]">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
            </div>
            <p className="font-medium">Принтер додано!</p>
            <div className="flex gap-2">
              <button onClick={() => { onDone(); onClose(); }} className={primaryBtn}>Готово</button>
              <button onClick={() => { onDone(); setStep("choose"); setName(""); setUrl(""); setError(null); }} className={ghostBtn}>Ще один</button>
            </div>
          </div>
        )}

      </div>
    </Modal>
  );
}

// ── edit modal (existing simple form) ─────────────────────────────────────────

function PrinterModal({
  open,
  onClose,
  printer,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  printer: Printer | null;
  onDone: () => void;
}) {
  const isEdit = printer !== null;
  const [form, setForm] = useState<PrinterForm>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(printer ? printerToForm(printer) : emptyForm());
      setError(null);
    }
  }, [open, printer]);

  function set<K extends keyof PrinterForm>(k: K, v: PrinterForm[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = {
      name: form.name.trim(),
      kind: form.kind,
      moonraker_url: form.moonraker_url.trim() || null,
      bambu_dev_id: form.bambu_dev_id.trim() || null,
      bambu_dev_ip: form.bambu_dev_ip.trim() || null,
      bambu_model: form.bambu_model.trim() || null,
      is_active: form.is_active,
    };
    if (form.bambu_access_code.trim()) {
      body.bambu_access_code = form.bambu_access_code.trim();
    }
    try {
      if (isEdit) {
        await api(`/api/printers/${printer!.id}`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        await api("/api/printers", { method: "POST", body: JSON.stringify(body) });
      }
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка збереження");
    } finally {
      setBusy(false);
    }
  }

  const isBambu = form.kind === "bambu";
  const hasUrl = form.kind === "snapmaker_u1" || form.kind === "other";

  return (
    <Modal
      open={open}
      onClose={() => { if (!busy) onClose(); }}
      title={isEdit ? "Редагувати принтер" : "Додати принтер"}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="btn btn-ghost"
          >
            Скасувати
          </button>
          <button
            type="submit"
            form="printer-form"
            disabled={busy || !form.name.trim()}
            className="btn btn-primary disabled:opacity-50"
          >
            {busy ? "Збереження…" : isEdit ? "Зберегти" : "Додати"}
          </button>
        </>
      }
    >
      <form id="printer-form" onSubmit={submit} className="space-y-4">
        <Field label="Назва">
          <input
            type="text"
            required
            autoFocus
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="U1-01"
            className={inputCls()}
          />
        </Field>

        <div>
          <span className="mb-2 block text-sm">Тип</span>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {KIND_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => set("kind", opt.value)}
                className={
                  "rounded-lg border p-3 text-left transition " +
                  (form.kind === opt.value
                    ? "border-[var(--border-strong)] bg-[var(--accent)] text-white   "
                    : "border-[var(--border)] hover:border-[var(--border-strong)] ")
                }
              >
                <p className="text-sm font-medium">{opt.label}</p>
                <p className={`mt-0.5 text-xs leading-tight ${form.kind === opt.value ? "opacity-70" : "text-[var(--text-muted)]"}`}>
                  {opt.desc}
                </p>
              </button>
            ))}
          </div>
        </div>

        {isBambu && (
          <>
            <div className="rounded-lg bg-[rgba(34,197,94,.08)] px-3 py-2 text-xs text-[var(--state-ok)]">
              Bambu-принтери автоматично синхронізуються з Bambu Cloud при
              наявності облікових даних в Налаштуваннях. Поля нижче — для
              ручного додавання або корекції.
            </div>
            <Field label="Serial / Dev ID" hint="(опційно)">
              <input
                type="text"
                value={form.bambu_dev_id}
                onChange={(e) => set("bambu_dev_id", e.target.value)}
                placeholder="01P09C321100123"
                className={inputCls()}
              />
            </Field>
            <Field label="Access Code" hint={isEdit ? "(залиш порожнім = не змінювати)" : "(опційно)"}>
              <input
                type="text"
                value={form.bambu_access_code}
                onChange={(e) => set("bambu_access_code", e.target.value)}
                placeholder="12345678"
                className={inputCls()}
              />
            </Field>
            <Field label="IP адреса (LAN)" hint="(опційно)">
              <input
                type="text"
                value={form.bambu_dev_ip}
                onChange={(e) => set("bambu_dev_ip", e.target.value)}
                placeholder="192.168.1.50"
                className={inputCls()}
              />
            </Field>
            <Field label="Модель" hint="(опційно)">
              <input
                type="text"
                value={form.bambu_model}
                onChange={(e) => set("bambu_model", e.target.value)}
                placeholder="P1S"
                className={inputCls()}
              />
            </Field>
          </>
        )}

        {hasUrl && (
          <Field label="Moonraker URL" hint="(опційно для ручного)">
            <input
              type="url"
              value={form.moonraker_url}
              onChange={(e) => set("moonraker_url", e.target.value)}
              placeholder="http://192.168.31.210"
              className={inputCls()}
            />
          </Field>
        )}

        {isEdit && (
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={form.is_active}
              onChange={(e) => set("is_active", e.target.checked)}
              className="h-4 w-4 rounded"
            />
            <span className="text-sm">Активний (показується на дашборді)</span>
          </label>
        )}

        {error && <p className="text-sm text-[var(--state-error)]">{error}</p>}
      </form>
    </Modal>
  );
}

type DiscoveredDevice = { dev_id: string; name: string; model: string };

export default function PrintersPage() {
  const user = useUser();
  const isAdmin = user?.role === "admin";
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Printer | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredDevice[]>([]);
  const [claiming, setClaiming] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function load(showSyncing = false) {
    if (showSyncing) setSyncing(true); else setLoading(true);
    try {
      const list = await api<Printer[]>("/api/printers");
      setPrinters(list);
    } finally {
      setSyncing(false);
      setLoading(false);
    }
  }

  async function loadDiscovered() {
    try {
      const devs = await api<DiscoveredDevice[]>("/api/printers/bambu/discovered");
      setDiscovered(devs);
    } catch {
      setDiscovered([]);
    }
  }

  async function claimDevice(dev_id: string) {
    if (claiming) return;
    setClaiming(dev_id);
    try {
      await api("/api/printers/bambu/claim", { method: "POST", body: JSON.stringify({ dev_id }) });
      setDiscovered((prev) => prev.filter((d) => d.dev_id !== dev_id));
      load();
    } catch {
      // error shown inline via claiming state reset
    } finally {
      setClaiming(null);
    }
  }

  useEffect(() => {
    load();
    if (isAdmin) loadDiscovered();
    // Silently run Bambu LAN discovery to populate missing IPs via agent UDP broadcast.
    // If new IPs are found, reload the list so FTPS send works immediately.
    api<{ devices: { dev_id: string; ip: string }[] }>("/api/printers/bambu-discover")
      .then((r) => { if (r.devices?.length) load(); })
      .catch(() => {});
  }, []);

  async function handleDelete(id: number) {
    if (inFlight.current) return;
    inFlight.current = true;
    setDeleteId(id);
    setConfirmDeleteId(null);
    try {
      await api(`/api/printers/${id}`, { method: "DELETE" });
      setPrinters((ps) => ps.filter((p) => p.id !== id));
    } catch {
      // ignore
    } finally {
      inFlight.current = false;
      setDeleteId(null);
    }
  }

  function connectionInfo(p: Printer): string {
    if (p.kind === "bambu") {
      const parts = [p.bambu_dev_id, p.bambu_dev_ip].filter(Boolean);
      return parts.join(" · ") || "—";
    }
    if (p.moonraker_url) return p.moonraker_url;
    return "—";
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Принтери</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => load(true)}
            disabled={syncing || loading}
            title="Синхронізувати з Bambu Cloud і оновити список"
            className="flex items-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)] disabled:opacity-40   "
          >
            <svg
              className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {syncing ? "Синхронізація…" : "Синх"}
          </button>
          {isAdmin && (
            <button
              onClick={() => setWizardOpen(true)}
              className="btn btn-primary"
            >
              + Додати принтер
            </button>
          )}
        </div>
      </div>
      {/* discovered but not yet claimed Bambu devices */}
      {isAdmin && discovered.length > 0 && (
        <div className="rounded-xl border border-[rgba(34,211,238,.25)] bg-[rgba(34,211,238,.06)] p-4">
          <p className="mb-3 text-sm font-medium text-[var(--accent)]">
            Виявлено нові Bambu пристрої ({discovered.length}) — оберіть які додати до ферми
          </p>
          <div className="flex flex-wrap gap-2">
            {discovered.map((d) => (
              <div key={d.dev_id}
                className="flex items-center gap-3 rounded-lg border border-[rgba(34,211,238,.2)] bg-[var(--bg-elevated)] px-3 py-2">
                <div>
                  <p className="text-sm font-medium">{d.name}</p>
                  <p className="text-xs text-[var(--text-faint)]">{d.model || d.dev_id}</p>
                </div>
                <button
                  onClick={() => claimDevice(d.dev_id)}
                  disabled={claiming === d.dev_id}
                  className="btn btn-primary btn-sm disabled:opacity-50"
                >
                  {claiming === d.dev_id ? "…" : "Додати"}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <TableSkeleton rows={6} cols={6} />
      ) : printers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border-strong)] p-10 text-center ">
          <p className="text-sm text-[var(--text-muted)]">Принтерів ще немає</p>
          {isAdmin && (
            <button
              onClick={() => setWizardOpen(true)}
              className="mt-3 text-sm text-[var(--text-hi)] underline "
            >
              Додати перший принтер
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--border)] ">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--bg)]  ">
                <th className="px-4 py-3 text-left font-medium text-[var(--text-muted)]">Назва</th>
                <th className="px-4 py-3 text-left font-medium text-[var(--text-muted)]">Тип</th>
                <th className="px-4 py-3 text-left font-medium text-[var(--text-muted)]">Стан</th>
                <th className="hidden px-4 py-3 text-left font-medium text-[var(--text-muted)] md:table-cell">Підключення</th>
                <th className="hidden px-4 py-3 text-left font-medium text-[var(--text-muted)] lg:table-cell">Група</th>
                {isAdmin && <th className="px-4 py-3 text-right font-medium text-[var(--text-muted)]">Дії</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)] dark:divide-neutral-800">
              {printers.map((p) => {
                const dot = STATE_DOT[p.state ?? "unknown"] ?? STATE_DOT.unknown;
                return (
                  <tr key={p.id} className="bg-[var(--bg-elevated)] hover:bg-[var(--surface-hi)]  ">
                    <td className="px-4 py-3 font-medium">
                      <Link href={`/printers/${p.id}`} className="hover:underline">{p.name}</Link>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${KIND_BADGE[p.kind] ?? KIND_BADGE.other}`}>
                        {kindLabel(p.kind)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-1.5">
                        <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
                        <span className="text-[var(--text-muted)] ">{stateLabel(p.state)}</span>
                      </span>
                    </td>
                    <td className="hidden px-4 py-3 text-[var(--text-muted)] md:table-cell">
                      <span className="max-w-[240px] truncate block font-mono text-xs">{connectionInfo(p)}</span>
                    </td>
                    <td className="hidden px-4 py-3 text-[var(--text-muted)] lg:table-cell">
                      {p.group_name ?? <span className="text-[var(--text-muted)] ">—</span>}
                    </td>
                    {isAdmin && (
                      <td className="px-4 py-3 text-right">
                        {confirmDeleteId === p.id ? (
                          <div className="flex items-center justify-end gap-2">
                            <span className="text-xs text-[var(--text-muted)]">Видалити?</span>
                            <button
                              onClick={() => handleDelete(p.id)}
                              disabled={deleteId === p.id}
                              className="rounded px-2 py-1 text-xs font-medium text-[var(--state-error)] hover:bg-[rgba(239,68,68,.08)] disabled:opacity-40 "
                            >
                              {deleteId === p.id ? "…" : "Так"}
                            </button>
                            <button
                              onClick={() => setConfirmDeleteId(null)}
                              className="rounded px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)] "
                            >
                              Ні
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => { setEditing(p); setModalOpen(true); }}
                              className="rounded p-1.5 text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)]  "
                              title="Редагувати"
                            >
                              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                              </svg>
                            </button>
                            <button
                              onClick={() => setConfirmDeleteId(p.id)}
                              className="rounded p-1.5 text-[var(--text-faint)] hover:bg-[rgba(239,68,68,.08)] hover:text-[var(--state-error)]  dark:hover:text-[var(--state-error)]"
                              title="Видалити"
                            >
                              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <AddPrinterWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onDone={load}
      />
      <PrinterModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        printer={editing}
        onDone={load}
      />
    </div>
  );
}
