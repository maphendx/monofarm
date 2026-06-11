"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Modal } from "@/components/ui/Modal";
import { useConfirm } from "@/hooks/useConfirm";
import { ApiError, api } from "@/lib/api";
import type { PrinterGroup } from "@/lib/types";

const MATERIALS = ["PLA", "PETG", "ABS", "ASA", "TPU", "PA", "PC", "PVA", "HIPS", "CF"];
const NOZZLES = [
  { value: "", label: "— будь-яке —" },
  { value: "0.2", label: "∅ 0.2 мм" },
  { value: "0.4", label: "∅ 0.4 мм (стандарт)" },
  { value: "0.6", label: "∅ 0.6 мм" },
  { value: "0.8", label: "∅ 0.8 мм" },
];
const PALETTE = ["#6366f1","#0ea5e9","#10b981","#f59e0b","#ef4444","#ec4899","#8b5cf6","#64748b"];

const inp = "rounded border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2 py-1 text-xs outline-none focus:border-[var(--border-focus)]";

interface GroupProfile {
  name: string;
  color: string;
  nozzle_diameter: string;
  build_x: string;
  build_y: string;
  build_z: string;
  supported_materials: string[];
}

function groupToProfile(g: PrinterGroup): GroupProfile {
  return {
    name: g.name,
    color: g.color ?? "",
    nozzle_diameter: g.nozzle_diameter?.toString() ?? "",
    build_x: g.build_x?.toString() ?? "",
    build_y: g.build_y?.toString() ?? "",
    build_z: g.build_z?.toString() ?? "",
    supported_materials: g.supported_materials ?? [],
  };
}

function profileSummary(g: PrinterGroup): string {
  const parts: string[] = [];
  if (g.nozzle_diameter) parts.push(`∅${g.nozzle_diameter} мм`);
  if (g.build_x && g.build_y && g.build_z) parts.push(`${g.build_x}×${g.build_y}×${g.build_z}`);
  if (g.supported_materials?.length) parts.push(g.supported_materials.join("/"));
  return parts.join(" · ");
}

export function PrinterGroupsModal({
  open,
  onClose,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  onChange: () => void;
}) {
  const { confirm, dialog } = useConfirm();
  const [groups, setGroups] = useState<PrinterGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // which group's profile panel is open
  const [expandedId, setExpandedId] = useState<number | null>(null);
  // profile form state per-group (keyed by id)
  const [profiles, setProfiles] = useState<Record<number, GroupProfile>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<PrinterGroup[]>("/api/printer-groups");
      setGroups(data);
      const map: Record<number, GroupProfile> = {};
      for (const g of data) map[g.id] = groupToProfile(g);
      setProfiles(map);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setNewName("");
    setError(null);
    setExpandedId(null);
    void load();
  }, [open, load]);

  function setField(id: number, key: keyof GroupProfile, val: string | string[]) {
    setProfiles(prev => ({ ...prev, [id]: { ...prev[id], [key]: val } }));
  }

  function toggleMaterial(id: number, mat: string) {
    const current = profiles[id]?.supported_materials ?? [];
    const next = current.includes(mat) ? current.filter(m => m !== mat) : [...current, mat];
    setField(id, "supported_materials", next);
  }

  async function createGroup(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setError(null);
    try {
      await api("/api/printer-groups", { method: "POST", body: JSON.stringify({ name }) });
      setNewName("");
      await load();
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка");
    } finally {
      setCreating(false);
    }
  }

  async function saveProfile(g: PrinterGroup) {
    const p = profiles[g.id];
    if (!p) return;
    setSavingId(g.id);
    try {
      await api(`/api/printer-groups/${g.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: p.name.trim() || g.name,
          color: p.color || null,
          nozzle_diameter: p.nozzle_diameter ? parseFloat(p.nozzle_diameter) : null,
          build_x: p.build_x ? parseInt(p.build_x) : null,
          build_y: p.build_y ? parseInt(p.build_y) : null,
          build_z: p.build_z ? parseInt(p.build_z) : null,
          supported_materials: p.supported_materials,
        }),
      });
      setExpandedId(null);
      await load();
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка збереження");
    } finally {
      setSavingId(null);
    }
  }

  async function deleteGroup(g: PrinterGroup) {
    const label = g.printer_count > 0
      ? `Видалити групу "${g.name}"? ${g.printer_count} принтер(ів) буде знято з групи.`
      : `Видалити групу "${g.name}"?`;
    if (!await confirm({ message: label, variant: "danger" })) return;
    setError(null);
    try {
      await api(`/api/printer-groups/${g.id}`, { method: "DELETE" });
      await load();
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка видалення");
    }
  }

  async function moveGroup(index: number, dir: -1 | 1) {
    const reordered = [...groups];
    const target = index + dir;
    if (target < 0 || target >= reordered.length) return;
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    const items = reordered.map((g, i) => ({ id: g.id, sort_order: i }));
    try {
      await api("/api/printer-groups/reorder", { method: "POST", body: JSON.stringify(items) });
      setGroups(reordered);
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка");
    }
  }

  return (
    <>
      <Modal open={open} onClose={onClose} title="Групи принтерів">
        <div className="space-y-4 text-sm">
          {/* create */}
          <form onSubmit={createGroup} className="flex gap-2">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Назва нової групи…"
              maxLength={120}
              className="flex-1 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-1.5 text-sm outline-none focus:border-[var(--border-focus)]"
            />
            <button
              type="submit"
              disabled={creating || !newName.trim()}
              className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
            >
              {creating ? "…" : "+ Додати"}
            </button>
          </form>

          {error && <p className="text-xs text-[var(--state-error)]">{error}</p>}

          {loading ? (
            <p className="text-[var(--text-muted)]">Завантаження…</p>
          ) : groups.length === 0 ? (
            <p className="rounded-md border border-dashed border-[var(--border-strong)] px-4 py-6 text-center text-[var(--text-muted)]">
              Груп поки немає. Додайте першу!
            </p>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {groups.map((g, i) => {
                const p = profiles[g.id];
                const isOpen = expandedId === g.id;
                const summary = profileSummary(g);
                return (
                  <li key={g.id} className="py-2">
                    {/* row */}
                    <div className="flex items-center gap-2">
                      {/* reorder */}
                      <div className="flex flex-col shrink-0">
                        <button type="button" onClick={() => moveGroup(i, -1)} disabled={i === 0}
                          className="px-1 text-[10px] text-[var(--text-faint)] hover:text-[var(--text)] disabled:opacity-20">▲</button>
                        <button type="button" onClick={() => moveGroup(i, 1)} disabled={i === groups.length - 1}
                          className="px-1 text-[10px] text-[var(--text-faint)] hover:text-[var(--text)] disabled:opacity-20">▼</button>
                      </div>

                      {/* color dot */}
                      <span className="h-3 w-3 shrink-0 rounded-full border border-black/10"
                        style={{ background: g.color ?? "var(--surface-hi)" }} />

                      {/* name + summary */}
                      <div className="min-w-0 flex-1">
                        <span className="font-medium">{g.name}</span>
                        {summary && (
                          <span className="ml-2 text-[10px] text-[var(--text-faint)]">{summary}</span>
                        )}
                      </div>

                      <span className="shrink-0 rounded-full bg-[var(--surface-hi)] px-2 py-0.5 text-[10px] text-[var(--text-muted)]">
                        {g.printer_count}
                      </span>

                      {/* edit toggle */}
                      <button type="button"
                        onClick={() => { setExpandedId(isOpen ? null : g.id); setError(null); }}
                        className="shrink-0 rounded px-1.5 py-0.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)]">
                        {isOpen ? "✕" : "✏"}
                      </button>

                      <button type="button" onClick={() => deleteGroup(g)}
                        className="shrink-0 rounded px-1.5 py-0.5 text-xs text-[var(--state-error)] hover:bg-[rgba(239,68,68,.08)]"
                        title="Видалити">×</button>
                    </div>

                    {/* expanded profile editor */}
                    {isOpen && p && (
                      <div className="mt-3 space-y-3 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3">
                        {/* name */}
                        <label className="block">
                          <span className="mb-1 block text-xs text-[var(--text-muted)]">Назва</span>
                          <input ref={inputRef} type="text" value={p.name} maxLength={120}
                            onChange={e => setField(g.id, "name", e.target.value)}
                            className={`w-full ${inp}`} />
                        </label>

                        {/* color */}
                        <div>
                          <span className="mb-1 block text-xs text-[var(--text-muted)]">Колір групи</span>
                          <div className="flex flex-wrap gap-1.5">
                            {PALETTE.map(c => (
                              <button key={c} type="button"
                                onClick={() => setField(g.id, "color", p.color === c ? "" : c)}
                                className="h-6 w-6 rounded-full border-2 transition"
                                style={{ background: c, borderColor: p.color === c ? "var(--text)" : "transparent" }} />
                            ))}
                            <button type="button"
                              onClick={() => setField(g.id, "color", "")}
                              className={`rounded-full border px-2 py-0.5 text-[10px] ${!p.color ? "border-[var(--border-strong)] text-[var(--text)]" : "border-[var(--border)] text-[var(--text-faint)]"}`}>
                              без кольору
                            </button>
                          </div>
                        </div>

                        {/* nozzle */}
                        <label className="block">
                          <span className="mb-1 block text-xs text-[var(--text-muted)]">Діаметр сопла</span>
                          <select value={p.nozzle_diameter}
                            onChange={e => setField(g.id, "nozzle_diameter", e.target.value)}
                            className={`w-full ${inp}`}>
                            {NOZZLES.map(n => <option key={n.value} value={n.value}>{n.label}</option>)}
                          </select>
                        </label>

                        {/* build volume */}
                        <div>
                          <span className="mb-1 block text-xs text-[var(--text-muted)]">Робочий об&apos;єм (мм)</span>
                          <div className="grid grid-cols-3 gap-2">
                            {(["build_x","build_y","build_z"] as const).map((k, idx) => (
                              <label key={k} className="block">
                                <span className="mb-0.5 block text-[10px] text-[var(--text-faint)]">{["X","Y","Z"][idx]}</span>
                                <input type="number" min="0" value={p[k]}
                                  onChange={e => setField(g.id, k, e.target.value)}
                                  placeholder={["220","220","240"][idx]}
                                  className={`w-full ${inp}`} />
                              </label>
                            ))}
                          </div>
                        </div>

                        {/* materials */}
                        <div>
                          <span className="mb-1 block text-xs text-[var(--text-muted)]">Підтримувані матеріали <span className="text-[var(--text-faint)]">(порожньо = будь-які)</span></span>
                          <div className="flex flex-wrap gap-1.5">
                            {MATERIALS.map(mat => {
                              const active = p.supported_materials.includes(mat);
                              return (
                                <button key={mat} type="button"
                                  onClick={() => toggleMaterial(g.id, mat)}
                                  className={[
                                    "rounded-full border px-2 py-0.5 text-xs font-medium transition",
                                    active
                                      ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]"
                                      : "border-[var(--border-strong)] text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]",
                                  ].join(" ")}>
                                  {mat}
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        {/* save */}
                        <div className="flex justify-end gap-2 pt-1">
                          <button type="button" onClick={() => setExpandedId(null)}
                            className="btn btn-ghost text-xs">Скасувати</button>
                          <button type="button" onClick={() => saveProfile(g)}
                            disabled={savingId === g.id}
                            className="btn btn-primary text-xs disabled:opacity-40">
                            {savingId === g.id ? "Збереження…" : "Зберегти профіль"}
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Modal>
      {dialog}
    </>
  );
}
