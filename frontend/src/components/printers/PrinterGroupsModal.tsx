"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDownAZ,
  ChevronsUpDown,
  Printer as PrinterIcon,
  Save,
  Settings2,
  SlidersHorizontal,
  X,
} from "lucide-react";

import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { useConfirm } from "@/hooks/useConfirm";
import { ApiError, api } from "@/lib/api";
import type { Printer, PrinterGroup } from "@/lib/types";

const MATERIALS = ["PLA", "PETG", "ABS", "ASA", "TPU", "PA", "PC", "PVA", "HIPS", "CF"];
const NOZZLES = [
  { value: "", label: "Будь-яке сопло" },
  { value: "0.2", label: "0.2 мм" },
  { value: "0.4", label: "0.4 мм" },
  { value: "0.6", label: "0.6 мм" },
  { value: "0.8", label: "0.8 мм" },
];
const PALETTE = ["#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#8b5cf6", "#64748b", "#22c55e"];

const inputClass =
  "h-8 rounded-md border border-[var(--border-strong)] bg-[var(--bg)] px-2 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]";

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

function sortPrinters(list: Printer[]) {
  return [...list].sort((a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name, "uk"));
}

function GroupProfileEditor({
  group,
  profile,
  savingId,
  onField,
  onToggleMaterial,
  onSave,
  onClose,
}: {
  group: PrinterGroup;
  profile: GroupProfile;
  savingId: number | null;
  onField: (id: number, key: keyof GroupProfile, val: string | string[]) => void;
  onToggleMaterial: (id: number, mat: string) => void;
  onSave: (group: PrinterGroup) => void;
  onClose: () => void;
}) {
  return (
    <div className="rounded-lg border border-[var(--accent)]/20 bg-[var(--bg-elevated)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text)]">
          <Icon icon={Settings2} className="h-3.5 w-3.5 text-[var(--accent)]" />
          Профіль групи
        </div>
        <button type="button" onClick={onClose} className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--surface-hi)]">
          <Icon icon={X} className="h-3.5 w-3.5 text-[var(--text-muted)]" />
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[var(--text-faint)]">Назва</span>
          <input value={profile.name} onChange={e => onField(group.id, "name", e.target.value)} className={`w-full ${inputClass}`} />
        </label>

        <div>
          <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[var(--text-faint)]">Колір</span>
          <div className="flex flex-wrap gap-1.5">
            {PALETTE.map(color => (
              <button
                key={color}
                type="button"
                onClick={() => onField(group.id, "color", profile.color === color ? "" : color)}
                className="h-6 w-6 rounded-full border-2"
                style={{ background: color, borderColor: profile.color === color ? "var(--text)" : "transparent" }}
              />
            ))}
          </div>
        </div>

        <label className="block">
          <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[var(--text-faint)]">Сопло</span>
          <select value={profile.nozzle_diameter} onChange={e => onField(group.id, "nozzle_diameter", e.target.value)} className={`w-full ${inputClass}`}>
            {NOZZLES.map(n => <option key={n.value} value={n.value}>{n.label}</option>)}
          </select>
        </label>

        <div>
          <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[var(--text-faint)]">Обʼєм, мм</span>
          <div className="grid grid-cols-3 gap-1.5">
            {(["build_x", "build_y", "build_z"] as const).map((key, idx) => (
              <input
                key={key}
                type="number"
                min="0"
                value={profile[key]}
                onChange={e => onField(group.id, key, e.target.value)}
                placeholder={["X", "Y", "Z"][idx]}
                className={`${inputClass} px-1.5 text-center`}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="mt-3">
        <span className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-[var(--text-faint)]">Матеріали</span>
        <div className="flex flex-wrap gap-1">
          {MATERIALS.map(mat => {
            const active = profile.supported_materials.includes(mat);
            return (
              <button
                key={mat}
                type="button"
                onClick={() => onToggleMaterial(group.id, mat)}
                className={[
                  "rounded-full border px-2 py-0.5 text-[11px] font-medium transition",
                  active
                    ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                    : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]",
                ].join(" ")}
              >
                {mat}
              </button>
            );
          })}
        </div>
      </div>

      <button
        type="button"
        onClick={() => onSave(group)}
        disabled={savingId === group.id}
        className="mt-3 flex h-7 items-center gap-1 rounded-md bg-[var(--accent)] px-3 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
      >
        <Icon icon={Save} className="h-3 w-3" />
        {savingId === group.id ? "Збереження…" : "Зберегти"}
      </button>
    </div>
  );
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
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [profiles, setProfiles] = useState<Record<number, GroupProfile>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [editingGroupId, setEditingGroupId] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [dragGroupId, setDragGroupId] = useState<number | null>(null);
  const [dragPrinterId, setDragPrinterId] = useState<number | null>(null);
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [groupData, printerData] = await Promise.all([
        api<PrinterGroup[]>("/api/printer-groups"),
        api<Printer[]>("/api/printers"),
      ]);
      setGroups(groupData);
      setPrinters(printerData);
      setProfiles(Object.fromEntries(groupData.map(g => [g.id, groupToProfile(g)])));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка завантаження");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setNewName("");
    setError(null);
    setEditingGroupId(null);
    void load();
  }, [open, load]);

  const printersByGroup = useMemo(() => {
    const map: Record<string, Printer[]> = {};
    for (const g of groups) map[g.id] = [];
    map["ungrouped"] = [];
    for (const p of printers) {
      const key = p.group_id != null && map[p.group_id] ? String(p.group_id) : "ungrouped";
      map[key].push(p);
    }
    for (const key of Object.keys(map)) map[key] = sortPrinters(map[key]);
    return map;
  }, [printers, groups]);

  const ungroupedCount = printersByGroup["ungrouped"]?.length ?? 0;

  function toggleCollapsed(key: string) {
    setCollapsed(prev => ({ ...prev, [key]: !prev[key] }));
  }

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
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api<PrinterGroup>("/api/printer-groups", {
        method: "POST",
        body: JSON.stringify({ name, color: PALETTE[groups.length % PALETTE.length] }),
      });
      setNewName("");
      await load();
      setEditingGroupId(created.id);
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка створення");
    } finally {
      setBusy(false);
    }
  }

  async function saveProfile(group: PrinterGroup) {
    const profile = profiles[group.id];
    if (!profile) return;
    setSavingId(group.id);
    setError(null);
    try {
      await api(`/api/printer-groups/${group.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: profile.name.trim() || group.name,
          color: profile.color || null,
          nozzle_diameter: profile.nozzle_diameter ? parseFloat(profile.nozzle_diameter) : null,
          build_x: profile.build_x ? parseInt(profile.build_x) : null,
          build_y: profile.build_y ? parseInt(profile.build_y) : null,
          build_z: profile.build_z ? parseInt(profile.build_z) : null,
          supported_materials: profile.supported_materials,
        }),
      });
      await load();
      setEditingGroupId(null);
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка збереження");
    } finally {
      setSavingId(null);
    }
  }

  async function deleteGroup(group: PrinterGroup) {
    const label = group.printer_count > 0
      ? `Видалити групу "${group.name}"? ${group.printer_count} принтер(ів) буде переміщено в "Без групи".`
      : `Видалити групу "${group.name}"?`;
    if (!await confirm({ message: label, variant: "danger" })) return;
    setError(null);
    try {
      await api(`/api/printer-groups/${group.id}`, { method: "DELETE" });
      if (editingGroupId === group.id) setEditingGroupId(null);
      await load();
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка видалення");
    }
  }

  async function persistGroupOrder(nextGroups: PrinterGroup[]) {
    setGroups(nextGroups);
    setError(null);
    try {
      await api("/api/printer-groups/reorder", {
        method: "POST",
        body: JSON.stringify(nextGroups.map((g, i) => ({ id: g.id, sort_order: i }))),
      });
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка сортування груп");
      await load();
    }
  }

  async function dropGroup(targetId: number) {
    if (dragGroupId == null || dragGroupId === targetId) return;
    const from = groups.findIndex(g => g.id === dragGroupId);
    const to = groups.findIndex(g => g.id === targetId);
    if (from < 0 || to < 0) return;
    const next = [...groups];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setDragGroupId(null);
    await persistGroupOrder(next);
  }

  async function persistPrinterOrder(groupKey: string, nextList: Printer[]) {
    const updated = nextList.map((printer, index) => ({ ...printer, sort_order: index }));
    const updatedById = new Map(updated.map(p => [p.id, p]));
    setPrinters(prev => prev.map(p => updatedById.get(p.id) ?? p));
    setError(null);
    try {
      await api("/api/printers/reorder", {
        method: "POST",
        body: JSON.stringify(updated.map(p => ({ id: p.id, sort_order: p.sort_order }))),
      });
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка сортування принтерів");
      await load();
    }
  }

  async function dropPrinterInGroup(groupKey: string, targetId: number) {
    if (dragPrinterId == null || dragPrinterId === targetId) return;
    const list = printersByGroup[groupKey] ?? [];
    const from = list.findIndex(p => p.id === dragPrinterId);
    const to = list.findIndex(p => p.id === targetId);
    if (from < 0 || to < 0) return;
    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setDragPrinterId(null);
    await persistPrinterOrder(groupKey, next);
  }

  async function assignPrinter(printer: Printer, groupId: number | null) {
    setError(null);
    const previous = printers;
    setPrinters(prev => prev.map(p => p.id === printer.id ? { ...p, group_id: groupId, group_name: groups.find(g => g.id === groupId)?.name ?? null } : p));
    try {
      await api(`/api/printers/${printer.id}/group`, {
        method: "POST",
        body: JSON.stringify({ group_id: groupId }),
      });
      await load();
      onChange();
    } catch (err) {
      setPrinters(previous);
      setError(err instanceof ApiError ? err.message : "Помилка зміни групи");
    }
  }

  function handleGroupDrop(groupKey: string, e: React.DragEvent) {
    e.preventDefault();
    if (dragPrinterId == null) return;
    const printer = printers.find(p => p.id === dragPrinterId);
    if (!printer) return;
    const targetGroupId = groupKey === "ungrouped" ? null : Number(groupKey);
    if (printer.group_id !== targetGroupId) {
      assignPrinter(printer, targetGroupId);
    }
    setDragPrinterId(null);
    setDragOverGroup(null);
  }

  async function autoSortByName() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const allKeys = [...groups.map(g => String(g.id)), "ungrouped"];
      for (const key of allKeys) {
        const list = printersByGroup[key] ?? [];
        if (list.length < 2) continue;
        const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name, "uk"));
        if (sorted.some((p, i) => p.id !== list[i].id)) {
          await persistPrinterOrder(key, sorted);
        }
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка сортування");
    } finally {
      setBusy(false);
    }
  }

  async function autoSortByModel() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const allKeys = [...groups.map(g => String(g.id)), "ungrouped"];
      for (const key of allKeys) {
        const list = printersByGroup[key] ?? [];
        if (list.length < 2) continue;
        const sorted = [...list].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, "uk"));
        if (sorted.some((p, i) => p.id !== list[i].id)) {
          await persistPrinterOrder(key, sorted);
        }
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка сортування");
    } finally {
      setBusy(false);
    }
  }

  function renderPrinterRow(printer: Printer, groupKey: string) {
    return (
      <div
        key={printer.id}
        draggable
        onDragStart={() => setDragPrinterId(printer.id)}
        onDragEnd={() => { setDragPrinterId(null); setDragOverGroup(null); }}
        onDragOver={e => e.preventDefault()}
        onDrop={e => {
          const list = printersByGroup[groupKey] ?? [];
          if (list.some(p => p.id === dragPrinterId)) {
            e.stopPropagation();
            dropPrinterInGroup(groupKey, printer.id);
          }
        }}
        className={[
          "flex cursor-grab items-center gap-3 border-b border-[var(--border)] px-3 py-2.5 last:border-b-0 transition-colors",
          dragPrinterId === printer.id ? "opacity-40" : "hover:bg-[var(--surface-hi)]",
        ].join(" ")}
      >
        <Icon icon={PrinterIcon} className="h-4 w-4 shrink-0 text-[var(--text-faint)]" />
        <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{printer.name}</span>
        <Icon icon={ChevronsUpDown} className="h-4 w-4 shrink-0 text-[var(--text-faint)]" />
      </div>
    );
  }

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title="Group and arrange printers"
        size="5xl"
        footer={
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[var(--border-strong)] px-5 py-2 text-sm font-semibold text-[var(--text)] hover:bg-[var(--surface-hi)]"
          >
            CLOSE
          </button>
        }
      >
        <div className="-mx-1 -my-1">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={autoSortByName}
                disabled={busy}
                className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--border-strong)] px-3 text-xs font-medium text-[var(--text)] hover:bg-[var(--surface-hi)] disabled:opacity-40"
              >
                <Icon icon={ArrowDownAZ} className="h-3.5 w-3.5" />
                AUTO-SORT BY NAME
              </button>
              <button
                type="button"
                onClick={autoSortByModel}
                disabled={busy}
                className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--border-strong)] px-3 text-xs font-medium text-[var(--text)] hover:bg-[var(--surface-hi)] disabled:opacity-40"
              >
                <Icon icon={SlidersHorizontal} className="h-3.5 w-3.5" />
                AUTO-SORT BY MODEL
              </button>
            </div>
            <form onSubmit={createGroup} className="flex items-center gap-2">
              <input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="Group name"
                maxLength={120}
                className="h-8 w-[160px] rounded-md border border-[var(--border-strong)] bg-[var(--bg)] px-2.5 text-xs outline-none focus:border-[var(--accent)]"
              />
              <button
                type="submit"
                disabled={busy || !newName.trim()}
                className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent)] px-4 text-xs font-bold text-white hover:opacity-90 disabled:opacity-40"
              >
                + CREATE NEW GROUP
              </button>
            </form>
          </div>

          {error && (
            <div className="mb-3 rounded-md border border-[rgba(239,68,68,.25)] bg-[rgba(239,68,68,.08)] px-3 py-2 text-xs text-[var(--state-error)]">
              {error}
            </div>
          )}

          {loading ? (
            <div className="flex min-h-[300px] items-center justify-center text-sm text-[var(--text-muted)]">Завантаження…</div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {groups.map(group => {
                const key = String(group.id);
                const isCollapsed = collapsed[key];
                const groupPrinters = printersByGroup[key] ?? [];
                const isEditing = editingGroupId === group.id;
                const isDragTarget = dragOverGroup === key && dragPrinterId != null;

                return (
                  <div
                    key={group.id}
                    className={[
                      "relative self-start rounded-lg transition-shadow",
                      isDragTarget ? "ring-2 ring-[var(--accent)] shadow-lg" : "",
                    ].join(" ")}
                    onDragOver={e => { e.preventDefault(); setDragOverGroup(key); }}
                    onDragLeave={() => setDragOverGroup(null)}
                    onDrop={e => handleGroupDrop(key, e)}
                  >
                    <button
                      type="button"
                      onClick={() => deleteGroup(group)}
                      className="absolute -right-2 -top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--state-error)] text-white shadow-sm hover:opacity-80"
                    >
                      <Icon icon={X} className="h-3 w-3" />
                    </button>

                    <div
                      className="flex cursor-grab items-center rounded-t-lg border border-[var(--border)] bg-[var(--surface-hi)] px-4 py-2.5"
                      draggable
                      onDragStart={() => setDragGroupId(group.id)}
                      onDragOver={e => e.preventDefault()}
                      onDrop={e => { e.stopPropagation(); dropGroup(group.id); }}
                    >
                      <span className="flex-1 text-center text-sm font-bold text-[var(--text)]">{group.name}</span>
                      <button
                        type="button"
                        onClick={() => setEditingGroupId(isEditing ? null : group.id)}
                        className="mr-0.5 flex h-6 w-6 items-center justify-center rounded text-[var(--text-faint)] hover:text-[var(--text)]"
                        title="Профіль групи"
                      >
                        <Icon icon={Settings2} className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleCollapsed(key)}
                        className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-faint)] hover:text-[var(--text)]"
                      >
                        <Icon icon={ChevronsUpDown} className="h-4 w-4" />
                      </button>
                    </div>

                    {isEditing && profiles[group.id] && (
                      <div className="border-x border-[var(--border)] p-3">
                        <GroupProfileEditor
                          group={group}
                          profile={profiles[group.id]}
                          savingId={savingId}
                          onField={setField}
                          onToggleMaterial={toggleMaterial}
                          onSave={saveProfile}
                          onClose={() => setEditingGroupId(null)}
                        />
                      </div>
                    )}

                    {!isCollapsed && (
                      <div className="overflow-hidden rounded-b-lg border border-t-0 border-[var(--border)] bg-[var(--bg-elevated)]">
                        {groupPrinters.length === 0 ? (
                          <div className="flex items-center justify-center px-4 py-8 text-xs text-[var(--text-faint)]">
                            Drag printers here
                          </div>
                        ) : (
                          groupPrinters.map(p => renderPrinterRow(p, key))
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {ungroupedCount > 0 && (
                <div
                  className={[
                    "relative self-start rounded-lg transition-shadow",
                    dragOverGroup === "ungrouped" && dragPrinterId != null ? "ring-2 ring-[var(--accent)] shadow-lg" : "",
                  ].join(" ")}
                  onDragOver={e => { e.preventDefault(); setDragOverGroup("ungrouped"); }}
                  onDragLeave={() => setDragOverGroup(null)}
                  onDrop={e => handleGroupDrop("ungrouped", e)}
                >
                  <div className="flex items-center rounded-t-lg border border-[var(--border)] bg-[var(--surface-hi)] px-4 py-2.5">
                    <span className="flex-1 text-center text-sm font-bold text-[var(--text)]">Other</span>
                    <button
                      type="button"
                      onClick={() => toggleCollapsed("ungrouped")}
                      className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-faint)] hover:text-[var(--text)]"
                    >
                      <Icon icon={ChevronsUpDown} className="h-4 w-4" />
                    </button>
                  </div>
                  {!collapsed["ungrouped"] && (
                    <div className="overflow-hidden rounded-b-lg border border-t-0 border-[var(--border)] bg-[var(--bg-elevated)]">
                      {(printersByGroup["ungrouped"] ?? []).map(p => renderPrinterRow(p, "ungrouped"))}
                    </div>
                  )}
                </div>
              )}

              {groups.length === 0 && ungroupedCount === 0 && !loading && (
                <div className="col-span-full flex min-h-[200px] items-center justify-center text-sm text-[var(--text-muted)]">
                  Немає принтерів
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>
      {dialog}
    </>
  );
}
