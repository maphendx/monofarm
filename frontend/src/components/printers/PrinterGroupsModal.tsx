"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  FolderPlus,
  GripVertical,
  Pencil,
  Printer as PrinterIcon,
  Save,
  Settings2,
  Trash2,
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

function groupSummary(g: PrinterGroup): string {
  const parts: string[] = [];
  if (g.nozzle_diameter) parts.push(`∅${g.nozzle_diameter}`);
  if (g.build_x && g.build_y && g.build_z) parts.push(`${g.build_x}×${g.build_y}×${g.build_z}`);
  if (g.supported_materials?.length) parts.push(g.supported_materials.join("/"));
  return parts.join(" · ");
}

function sortPrinters(list: Printer[]) {
  return [...list].sort((a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name, "uk"));
}

function KindBadge({ printer }: { printer: Printer }) {
  const label = printer.kind === "bambu" ? "Bambu" : printer.kind === "snapmaker_u1" ? "Klipper" : "Manual";
  return (
    <span className="rounded border border-[var(--border)] bg-[var(--surface-hi)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-faint)]">
      {label}
    </span>
  );
}

function PrinterRow({
  printer,
  index,
  total,
  groups,
  onMove,
  onAssign,
  dragId,
  onDragStart,
  onDrop,
}: {
  printer: Printer;
  index: number;
  total: number;
  groups: PrinterGroup[];
  onMove: (id: number, dir: -1 | 1) => void;
  onAssign: (printer: Printer, groupId: number | null) => void;
  dragId: number | null;
  onDragStart: (id: number) => void;
  onDrop: (id: number) => void;
}) {
  return (
    <div
      draggable
      onDragStart={() => onDragStart(printer.id)}
      onDragOver={e => e.preventDefault()}
      onDrop={() => onDrop(printer.id)}
      className={[
        "flex items-center gap-2 rounded-md border px-2.5 py-1.5 transition",
        dragId === printer.id
          ? "border-[var(--accent)] bg-[var(--accent-soft)] opacity-70"
          : "border-[var(--border)] bg-[var(--bg)] hover:border-[var(--border-strong)]",
      ].join(" ")}
    >
      <Icon icon={GripVertical} className="h-3.5 w-3.5 shrink-0 cursor-grab text-[var(--text-faint)]" />

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-xs font-semibold text-[var(--text)]">{printer.name}</span>
          <KindBadge printer={printer} />
        </span>
      </span>

      <select
        value={printer.group_id ?? ""}
        onChange={e => onAssign(printer, e.target.value ? Number(e.target.value) : null)}
        className="h-6 w-[110px] shrink-0 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-1 text-[10px] outline-none focus:border-[var(--accent)]"
      >
        <option value="">Без групи</option>
        {groups.map(g => (
          <option key={g.id} value={g.id}>{g.name}</option>
        ))}
      </select>

      <div className="flex shrink-0 gap-0.5">
        <button
          type="button"
          onClick={() => onMove(printer.id, -1)}
          disabled={index === 0}
          className="flex h-6 w-5 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text-muted)] disabled:opacity-20"
        >
          <Icon icon={ChevronUp} className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={() => onMove(printer.id, 1)}
          disabled={index === total - 1}
          className="flex h-6 w-5 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text-muted)] disabled:opacity-20"
        >
          <Icon icon={ChevronDown} className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
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

  async function moveGroup(groupId: number, dir: -1 | 1) {
    const index = groups.findIndex(g => g.id === groupId);
    const target = index + dir;
    if (index < 0 || target < 0 || target >= groups.length) return;
    const next = [...groups];
    [next[index], next[target]] = [next[target], next[index]];
    await persistGroupOrder(next);
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

  async function movePrinter(groupKey: string, printerId: number, dir: -1 | 1) {
    const list = printersByGroup[groupKey] ?? [];
    const index = list.findIndex(p => p.id === printerId);
    const target = index + dir;
    if (index < 0 || target < 0 || target >= list.length) return;
    const next = [...list];
    [next[index], next[target]] = [next[target], next[index]];
    await persistPrinterOrder(groupKey, next);
  }

  async function dropPrinter(groupKey: string, targetId: number) {
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

  return (
    <>
      <Modal open={open} onClose={onClose} title="Сортування принтерів" size="2xl">
        <div className="-mx-1 -my-1">
          {/* top bar */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-[var(--text-muted)]">
              {groups.length} груп · {printers.length} принтерів
            </div>
            <form onSubmit={createGroup} className="flex items-center gap-2">
              <input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="Нова група"
                maxLength={120}
                className="h-7 w-[180px] rounded-md border border-[var(--border-strong)] bg-[var(--bg)] px-2.5 text-xs outline-none focus:border-[var(--accent)]"
              />
              <button
                type="submit"
                disabled={busy || !newName.trim()}
                className="flex h-7 items-center gap-1 rounded-md bg-[var(--accent)] px-2.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
              >
                <Icon icon={FolderPlus} className="h-3.5 w-3.5" />
                Додати
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
            <div className="max-h-[65vh] space-y-2 overflow-y-auto pr-1">
              {groups.map((group, gi) => {
                const key = String(group.id);
                const isCollapsed = collapsed[key];
                const groupPrinters = printersByGroup[key] ?? [];
                const summary = groupSummary(group);
                const isEditing = editingGroupId === group.id;

                return (
                  <section
                    key={group.id}
                    className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]"
                  >
                    {/* group header */}
                    <div
                      draggable
                      onDragStart={() => setDragGroupId(group.id)}
                      onDragOver={e => e.preventDefault()}
                      onDrop={() => dropGroup(group.id)}
                      className={[
                        "flex items-center gap-2 px-3 py-2 transition",
                        dragGroupId === group.id ? "opacity-50" : "",
                      ].join(" ")}
                    >
                      <Icon icon={GripVertical} className="h-3.5 w-3.5 shrink-0 cursor-grab text-[var(--text-faint)]" />

                      <span
                        className="h-3 w-3 shrink-0 rounded-full border border-black/10"
                        style={{ background: group.color ?? "var(--surface-hi)" }}
                      />

                      <button
                        type="button"
                        onClick={() => toggleCollapsed(key)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <span className="truncate text-sm font-semibold text-[var(--text)]">{group.name}</span>
                        {summary && (
                          <span className="hidden truncate text-[10px] text-[var(--text-faint)] sm:inline">{summary}</span>
                        )}
                      </button>

                      <span className="rounded bg-[var(--surface-hi)] px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-[var(--text-muted)]">
                        {groupPrinters.length}
                      </span>

                      <div className="flex items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => moveGroup(group.id, -1)}
                          disabled={gi === 0}
                          className="flex h-6 w-5 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[var(--surface-hi)] disabled:opacity-20"
                        >
                          <Icon icon={ChevronUp} className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveGroup(group.id, 1)}
                          disabled={gi === groups.length - 1}
                          className="flex h-6 w-5 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[var(--surface-hi)] disabled:opacity-20"
                        >
                          <Icon icon={ChevronDown} className="h-3 w-3" />
                        </button>
                      </div>

                      <button
                        type="button"
                        onClick={() => setEditingGroupId(isEditing ? null : group.id)}
                        className={[
                          "flex h-6 w-6 items-center justify-center rounded transition",
                          isEditing
                            ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                            : "text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text-muted)]",
                        ].join(" ")}
                        title="Профіль групи"
                      >
                        <Icon icon={isEditing ? Pencil : Settings2} className="h-3.5 w-3.5" />
                      </button>

                      <button
                        type="button"
                        onClick={() => deleteGroup(group)}
                        className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[rgba(239,68,68,.08)] hover:text-[var(--state-error)]"
                        title="Видалити групу"
                      >
                        <Icon icon={Trash2} className="h-3.5 w-3.5" />
                      </button>

                      <button
                        type="button"
                        onClick={() => toggleCollapsed(key)}
                        className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[var(--surface-hi)]"
                      >
                        <Icon icon={isCollapsed ? ChevronDown : ChevronUp} className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    {isEditing && profiles[group.id] && (
                      <div className="border-t border-[var(--border)] px-3 py-2">
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
                      <div className="space-y-1 border-t border-[var(--border)] p-2">
                        {groupPrinters.length === 0 ? (
                          <div className="flex items-center justify-center rounded border border-dashed border-[var(--border-strong)] px-4 py-4 text-center">
                            <div>
                              <Icon icon={PrinterIcon} className="mx-auto h-5 w-5 text-[var(--text-faint)]" />
                              <p className="mt-1 text-xs text-[var(--text-muted)]">Порожня група</p>
                            </div>
                          </div>
                        ) : (
                          groupPrinters.map((printer, pi) => (
                            <PrinterRow
                              key={printer.id}
                              printer={printer}
                              index={pi}
                              total={groupPrinters.length}
                              groups={groups}
                              onMove={(id, dir) => movePrinter(key, id, dir)}
                              onAssign={assignPrinter}
                              dragId={dragPrinterId}
                              onDragStart={setDragPrinterId}
                              onDrop={id => dropPrinter(key, id)}
                            />
                          ))
                        )}
                      </div>
                    )}
                  </section>
                );
              })}

              {/* ungrouped */}
              {ungroupedCount > 0 && (
                <section className="overflow-hidden rounded-lg border border-dashed border-[var(--border-strong)] bg-[var(--bg-elevated)]">
                  <div className="flex items-center gap-2 px-3 py-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-dashed border-[var(--border-strong)] text-[10px] text-[var(--text-faint)]">
                      —
                    </span>
                    <button
                      type="button"
                      onClick={() => toggleCollapsed("ungrouped")}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <span className="text-sm font-semibold text-[var(--text)]">Без групи</span>
                      <span className="text-[10px] text-[var(--text-faint)]">нові або не відсортовані</span>
                    </button>
                    <span className="rounded bg-[var(--surface-hi)] px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-[var(--text-muted)]">
                      {ungroupedCount}
                    </span>
                    <button
                      type="button"
                      onClick={() => toggleCollapsed("ungrouped")}
                      className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[var(--surface-hi)]"
                    >
                      <Icon icon={collapsed["ungrouped"] ? ChevronDown : ChevronUp} className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {!collapsed["ungrouped"] && (
                    <div className="space-y-1 border-t border-[var(--border)] p-2">
                      {(printersByGroup["ungrouped"] ?? []).map((printer, pi) => (
                        <PrinterRow
                          key={printer.id}
                          printer={printer}
                          index={pi}
                          total={ungroupedCount}
                          groups={groups}
                          onMove={(id, dir) => movePrinter("ungrouped", id, dir)}
                          onAssign={assignPrinter}
                          dragId={dragPrinterId}
                          onDragStart={setDragPrinterId}
                          onDrop={id => dropPrinter("ungrouped", id)}
                        />
                      ))}
                    </div>
                  )}
                </section>
              )}

              {groups.length === 0 && ungroupedCount === 0 && !loading && (
                <div className="flex min-h-[200px] items-center justify-center text-sm text-[var(--text-muted)]">
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
