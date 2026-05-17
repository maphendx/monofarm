"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Modal } from "@/components/Modal";
import { ApiError, api } from "@/lib/api";
import type { PrinterGroup } from "@/lib/types";

export function PrinterGroupsModal({
  open,
  onClose,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  onChange: () => void; // called after any mutating action so dashboard can reload
}) {
  const [groups, setGroups] = useState<PrinterGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<PrinterGroup[]>("/api/printer-groups");
      setGroups(data);
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
    setEditingId(null);
    void load();
  }, [open, load]);

  async function createGroup(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setError(null);
    try {
      await api("/api/printer-groups", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      setNewName("");
      await load();
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка");
    } finally {
      setCreating(false);
    }
  }

  async function startEdit(g: PrinterGroup) {
    setEditingId(g.id);
    setEditName(g.name);
    setError(null);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  async function saveEdit(id: number) {
    const name = editName.trim();
    if (!name) { cancelEdit(); return; }
    setError(null);
    try {
      await api(`/api/printer-groups/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
      setEditingId(null);
      await load();
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка");
    }
  }

  function cancelEdit() {
    setEditingId(null);
    setEditName("");
  }

  async function deleteGroup(g: PrinterGroup) {
    const label = g.printer_count > 0
      ? `Видалити групу "${g.name}"? ${g.printer_count} принтер(ів) буде знято з групи.`
      : `Видалити групу "${g.name}"?`;
    if (!confirm(label)) return;
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
      await api("/api/printer-groups/reorder", {
        method: "POST",
        body: JSON.stringify(items),
      });
      setGroups(reordered);
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка");
    }
  }

  return (
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
            className="flex-1 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-300"
          />
          <button
            type="submit"
            disabled={creating || !newName.trim()}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
          >
            {creating ? "…" : "+ Додати"}
          </button>
        </form>

        {error && (
          <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
        )}

        {/* list */}
        {loading ? (
          <p className="text-neutral-500">Завантаження…</p>
        ) : groups.length === 0 ? (
          <p className="rounded-md border border-dashed border-neutral-300 px-4 py-6 text-center text-neutral-500 dark:border-neutral-700">
            Груп поки немає. Додайте першу!
          </p>
        ) : (
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {groups.map((g, i) => (
              <li key={g.id} className="flex items-center gap-2 py-2">
                {/* reorder arrows */}
                <div className="flex flex-col">
                  <button
                    type="button"
                    onClick={() => moveGroup(i, -1)}
                    disabled={i === 0}
                    className="px-1 py-0 text-neutral-400 hover:text-neutral-700 disabled:opacity-20 dark:hover:text-neutral-200"
                    title="Вище"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    onClick={() => moveGroup(i, 1)}
                    disabled={i === groups.length - 1}
                    className="px-1 py-0 text-neutral-400 hover:text-neutral-700 disabled:opacity-20 dark:hover:text-neutral-200"
                    title="Нижче"
                  >
                    ▼
                  </button>
                </div>

                {/* name */}
                <div className="flex-1">
                  {editingId === g.id ? (
                    <div className="flex gap-1">
                      <input
                        ref={inputRef}
                        type="text"
                        value={editName}
                        maxLength={120}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveEdit(g.id);
                          if (e.key === "Escape") cancelEdit();
                        }}
                        className="flex-1 rounded border border-neutral-300 bg-white px-2 py-0.5 text-sm outline-none focus:border-neutral-900 dark:border-neutral-600 dark:bg-neutral-900"
                      />
                      <button
                        type="button"
                        onClick={() => saveEdit(g.id)}
                        className="rounded px-2 py-0.5 text-xs text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/30"
                      >
                        ✓
                      </button>
                      <button
                        type="button"
                        onClick={cancelEdit}
                        className="rounded px-2 py-0.5 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => startEdit(g)}
                      className="w-full text-left font-medium hover:underline"
                    >
                      {g.name}
                    </button>
                  )}
                </div>

                {/* printer count badge */}
                <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                  {g.printer_count}
                </span>

                {/* delete */}
                {editingId !== g.id && (
                  <button
                    type="button"
                    onClick={() => deleteGroup(g)}
                    className="rounded px-1.5 py-0.5 text-xs text-red-500 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/30"
                    title="Видалити групу"
                  >
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
