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
const groupKeyUngrouped = "ungrouped";

type GroupKey = number | typeof groupKeyUngrouped;

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

function selectedGroupLabel(key: GroupKey, groups: PrinterGroup[]) {
  if (key === groupKeyUngrouped) return "Без групи";
  return groups.find(g => g.id === key)?.name ?? "Група";
}

function KindPill({ printer }: { printer: Printer }) {
  const label = printer.kind === "bambu" ? "Bambu" : printer.kind === "snapmaker_u1" ? "Klipper" : "Manual";
  return (
    <span className="rounded-full border border-[var(--border)] bg-[var(--surface-hi)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-muted)]">
      {label}
    </span>
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
  const [selectedKey, setSelectedKey] = useState<GroupKey>(groupKeyUngrouped);
  const [profiles, setProfiles] = useState<Record<number, GroupProfile>>({});
  const [newName, setNewName] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [editingProfile, setEditingProfile] = useState(false);
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
      setSelectedKey(prev => {
        if (prev === groupKeyUngrouped || groupData.some(g => g.id === prev)) return prev;
        return groupData[0]?.id ?? groupKeyUngrouped;
      });
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
    setEditingProfile(false);
    void load();
  }, [open, load]);

  const selectedGroup = selectedKey === groupKeyUngrouped ? null : groups.find(g => g.id === selectedKey) ?? null;
  const selectedPrinters = useMemo(
    () => sortPrinters(printers.filter(p => (selectedKey === groupKeyUngrouped ? p.group_id == null : p.group_id === selectedKey))),
    [printers, selectedKey],
  );
  const ungroupedCount = printers.filter(p => p.group_id == null).length;
  const totalPrinters = printers.length;

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
      setSelectedKey(created.id);
      setEditingProfile(true);
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
      setEditingProfile(false);
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
      setSelectedKey(groupKeyUngrouped);
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

  async function persistPrinterOrder(nextList: Printer[]) {
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

  async function movePrinter(printerId: number, dir: -1 | 1) {
    const index = selectedPrinters.findIndex(p => p.id === printerId);
    const target = index + dir;
    if (index < 0 || target < 0 || target >= selectedPrinters.length) return;
    const next = [...selectedPrinters];
    [next[index], next[target]] = [next[target], next[index]];
    await persistPrinterOrder(next);
  }

  async function dropPrinter(targetId: number) {
    if (dragPrinterId == null || dragPrinterId === targetId) return;
    const from = selectedPrinters.findIndex(p => p.id === dragPrinterId);
    const to = selectedPrinters.findIndex(p => p.id === targetId);
    if (from < 0 || to < 0) return;
    const next = [...selectedPrinters];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setDragPrinterId(null);
    await persistPrinterOrder(next);
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

  const activeProfile = selectedGroup ? profiles[selectedGroup.id] : null;

  return (
    <>
      <Modal open={open} onClose={onClose} title="Сортування принтерів" size="3xl">
        <div className="-mx-1 -my-1">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-[var(--text-muted)]">
              {groups.length} груп · {totalPrinters} принтерів
            </div>
            <form onSubmit={createGroup} className="flex min-w-[260px] items-center gap-2">
              <input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="Нова група"
                maxLength={120}
                className="h-8 flex-1 rounded-md border border-[var(--border-strong)] bg-[var(--bg)] px-2.5 text-xs outline-none focus:border-[var(--accent)]"
              />
              <button
                type="submit"
                disabled={busy || !newName.trim()}
                className="flex h-8 items-center gap-1 rounded-md bg-[var(--accent)] px-2.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
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

          <div className="grid min-h-[520px] grid-cols-[240px_minmax(0,1fr)] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg)]">
            <aside className="border-r border-[var(--border)] bg-[var(--bg-elevated)]">
              <div className="border-b border-[var(--border)] px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-[var(--text-faint)]">
                Групи
              </div>
              <div className="space-y-1 p-2">
                {groups.map((group, index) => {
                  const selected = selectedKey === group.id;
                  return (
                    <button
                      key={group.id}
                      type="button"
                      draggable
                      onClick={() => { setSelectedKey(group.id); setEditingProfile(false); }}
                      onDragStart={() => setDragGroupId(group.id)}
                      onDragOver={e => e.preventDefault()}
                      onDrop={() => dropGroup(group.id)}
                      className={[
                        "group flex w-full items-center gap-2 rounded-md border px-2 py-2 text-left transition",
                        selected
                          ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                          : "border-transparent hover:border-[var(--border)] hover:bg-[var(--surface-hi)]",
                      ].join(" ")}
                    >
                      <Icon icon={GripVertical} className="h-3.5 w-3.5 shrink-0 text-[var(--text-faint)]" />
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-black/10" style={{ background: group.color ?? "var(--surface-hi)" }} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-semibold text-[var(--text)]">{group.name}</span>
                        <span className="block truncate text-[10px] text-[var(--text-faint)]">{groupSummary(group) || "без профілю"}</span>
                      </span>
                      <span className="rounded bg-[var(--surface-hi)] px-1.5 py-0.5 text-[10px] tabular-nums text-[var(--text-muted)]">
                        {group.printer_count}
                      </span>
                      <span className="flex flex-col opacity-0 transition group-hover:opacity-100">
                        <span onClick={e => { e.stopPropagation(); void moveGroup(group.id, -1); }} className={index === 0 ? "pointer-events-none opacity-25" : ""}>
                          <Icon icon={ChevronUp} className="h-3 w-3 text-[var(--text-muted)]" />
                        </span>
                        <span onClick={e => { e.stopPropagation(); void moveGroup(group.id, 1); }} className={index === groups.length - 1 ? "pointer-events-none opacity-25" : ""}>
                          <Icon icon={ChevronDown} className="h-3 w-3 text-[var(--text-muted)]" />
                        </span>
                      </span>
                    </button>
                  );
                })}

                <button
                  type="button"
                  onClick={() => { setSelectedKey(groupKeyUngrouped); setEditingProfile(false); }}
                  className={[
                    "mt-2 flex w-full items-center gap-2 rounded-md border px-2 py-2 text-left transition",
                    selectedKey === groupKeyUngrouped
                      ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                      : "border-transparent hover:border-[var(--border)] hover:bg-[var(--surface-hi)]",
                  ].join(" ")}
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-dashed border-[var(--border-strong)] text-[10px] text-[var(--text-faint)]">
                    —
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold text-[var(--text)]">Без групи</span>
                    <span className="block truncate text-[10px] text-[var(--text-faint)]">нові або не відсортовані</span>
                  </span>
                  <span className="rounded bg-[var(--surface-hi)] px-1.5 py-0.5 text-[10px] tabular-nums text-[var(--text-muted)]">
                    {ungroupedCount}
                  </span>
                </button>
              </div>
            </aside>

            <section className="flex min-w-0 flex-col bg-[var(--bg-elevated)]">
              <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {selectedGroup?.color && <span className="h-3 w-3 rounded-full" style={{ background: selectedGroup.color }} />}
                    <h3 className="truncate text-sm font-semibold text-[var(--text)]">{selectedGroupLabel(selectedKey, groups)}</h3>
                    <span className="rounded-full bg-[var(--surface-hi)] px-2 py-0.5 text-[10px] text-[var(--text-muted)]">
                      {selectedPrinters.length} принт.
                    </span>
                  </div>
                  <p className="mt-0.5 text-[10px] text-[var(--text-faint)]">
                    Перетягніть рядки, щоб змінити порядок. Зміна зберігається одразу.
                  </p>
                </div>

                {selectedGroup && (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setEditingProfile(v => !v)}
                      className="flex h-8 items-center gap-1 rounded-md border border-[var(--border)] px-2 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)]"
                    >
                      <Icon icon={editingProfile ? PrinterIcon : Settings2} className="h-3.5 w-3.5" />
                      {editingProfile ? "Принтери" : "Профіль"}
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteGroup(selectedGroup)}
                      className="flex h-8 w-8 items-center justify-center rounded-md border border-[rgba(239,68,68,.25)] text-[var(--state-error)] hover:bg-[rgba(239,68,68,.08)]"
                      aria-label="Видалити групу"
                    >
                      <Icon icon={Trash2} className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </div>

              {loading ? (
                <div className="flex flex-1 items-center justify-center text-sm text-[var(--text-muted)]">Завантаження…</div>
              ) : editingProfile && selectedGroup && activeProfile ? (
                <div className="grid gap-4 p-4 md:grid-cols-[minmax(0,1fr)_220px]">
                  <div className="space-y-4">
                    <label className="block">
                      <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[var(--text-faint)]">Назва групи</span>
                      <input
                        value={activeProfile.name}
                        onChange={e => setField(selectedGroup.id, "name", e.target.value)}
                        className={`w-full ${inputClass}`}
                      />
                    </label>

                    <div>
                      <span className="mb-2 block text-[10px] font-bold uppercase tracking-wider text-[var(--text-faint)]">Колір</span>
                      <div className="flex flex-wrap gap-2">
                        {PALETTE.map(color => (
                          <button
                            key={color}
                            type="button"
                            onClick={() => setField(selectedGroup.id, "color", activeProfile.color === color ? "" : color)}
                            className="h-7 w-7 rounded-full border-2"
                            style={{ background: color, borderColor: activeProfile.color === color ? "var(--text)" : "transparent" }}
                            aria-label={color}
                          />
                        ))}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <label className="block">
                        <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-[var(--text-faint)]">Сопло</span>
                        <select
                          value={activeProfile.nozzle_diameter}
                          onChange={e => setField(selectedGroup.id, "nozzle_diameter", e.target.value)}
                          className={`w-full ${inputClass}`}
                        >
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
                              value={activeProfile[key]}
                              onChange={e => setField(selectedGroup.id, key, e.target.value)}
                              placeholder={["X", "Y", "Z"][idx]}
                              className={`${inputClass} px-1.5 text-center`}
                            />
                          ))}
                        </div>
                      </div>
                    </div>

                    <div>
                      <span className="mb-2 block text-[10px] font-bold uppercase tracking-wider text-[var(--text-faint)]">Матеріали</span>
                      <div className="flex flex-wrap gap-1.5">
                        {MATERIALS.map(material => {
                          const active = activeProfile.supported_materials.includes(material);
                          return (
                            <button
                              key={material}
                              type="button"
                              onClick={() => toggleMaterial(selectedGroup.id, material)}
                              className={[
                                "rounded-full border px-2 py-1 text-xs font-medium transition",
                                active
                                  ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                                  : "border-[var(--border-strong)] text-[var(--text-muted)] hover:text-[var(--text)]",
                              ].join(" ")}
                            >
                              {material}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3">
                    <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-[var(--text)]">
                      <Icon icon={Pencil} className="h-3.5 w-3.5 text-[var(--accent)]" />
                      Профіль для автопідбору
                    </div>
                    <p className="text-xs leading-5 text-[var(--text-muted)]">
                      Ці параметри використовуються для підбору сумісних файлів і швидкого планування черги.
                    </p>
                    <button
                      type="button"
                      onClick={() => saveProfile(selectedGroup)}
                      disabled={savingId === selectedGroup.id}
                      className="mt-4 flex h-8 w-full items-center justify-center gap-1 rounded-md bg-[var(--accent)] text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
                    >
                      <Icon icon={Save} className="h-3.5 w-3.5" />
                      {savingId === selectedGroup.id ? "Збереження…" : "Зберегти"}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex-1 overflow-y-auto p-3">
                  {selectedPrinters.length === 0 ? (
                    <div className="flex h-full min-h-[280px] items-center justify-center rounded-lg border border-dashed border-[var(--border-strong)] text-center">
                      <div>
                        <Icon icon={PrinterIcon} className="mx-auto h-7 w-7 text-[var(--text-faint)]" />
                        <p className="mt-2 text-sm font-medium text-[var(--text-muted)]">У цій групі немає принтерів</p>
                        <p className="mt-1 text-xs text-[var(--text-faint)]">Виберіть групу в рядку принтера або перемістіть його з “Без групи”.</p>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {selectedPrinters.map((printer, index) => (
                        <div
                          key={printer.id}
                          draggable
                          onDragStart={() => setDragPrinterId(printer.id)}
                          onDragOver={e => e.preventDefault()}
                          onDrop={() => dropPrinter(printer.id)}
                          className={[
                            "grid grid-cols-[24px_minmax(0,1fr)_120px_110px_42px] items-center gap-2 rounded-md border px-2 py-2 transition",
                            dragPrinterId === printer.id
                              ? "border-[var(--accent)] bg-[var(--accent-soft)] opacity-70"
                              : "border-[var(--border)] bg-[var(--bg)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hi)]",
                          ].join(" ")}
                        >
                          <Icon icon={GripVertical} className="h-4 w-4 cursor-grab text-[var(--text-faint)]" />
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-semibold text-[var(--text)]">{printer.name}</span>
                              <KindPill printer={printer} />
                            </div>
                            <p className="truncate text-[10px] text-[var(--text-faint)]">
                              {printer.state ?? "unknown"} · sort {printer.sort_order}
                            </p>
                          </div>
                          <select
                            value={printer.group_id ?? ""}
                            onChange={e => assignPrinter(printer, e.target.value ? Number(e.target.value) : null)}
                            className="h-7 rounded border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-1.5 text-[11px] outline-none focus:border-[var(--accent)]"
                          >
                            <option value="">Без групи</option>
                            {groups.map(group => (
                              <option key={group.id} value={group.id}>{group.name}</option>
                            ))}
                          </select>
                          <div className="text-right text-[10px] text-[var(--text-faint)]">
                            #{index + 1}
                          </div>
                          <div className="flex justify-end gap-0.5">
                            <button
                              type="button"
                              onClick={() => movePrinter(printer.id, -1)}
                              disabled={index === 0}
                              className="flex h-7 w-5 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--bg-elevated)] disabled:opacity-20"
                              aria-label="Вище"
                            >
                              <Icon icon={ChevronUp} className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => movePrinter(printer.id, 1)}
                              disabled={index === selectedPrinters.length - 1}
                              className="flex h-7 w-5 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--bg-elevated)] disabled:opacity-20"
                              aria-label="Нижче"
                            >
                              <Icon icon={ChevronDown} className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        </div>
      </Modal>
      {dialog}
    </>
  );
}
