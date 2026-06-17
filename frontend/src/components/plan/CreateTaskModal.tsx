"use client";

import { useEffect, useRef, useState } from "react";

import { CreateTagModal } from "@/components/ui/CreateTagModal";
import { Modal } from "@/components/ui/Modal";
import { TagPicker } from "@/components/ui/TagPicker";
import { useTags } from "@/hooks/useTags";
import { ApiError, api, getToken } from "@/lib/api";
import type { PrintTask } from "@/lib/types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

type ProductOption = { id: number; name: string; sku: string };

export function CreateTaskModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (t: PrintTask) => void;
}) {
  const [title, setTitle] = useState("");
  const [qty, setQty] = useState("1");
  const [filamentType, setFilamentType] = useState("");
  const [filamentColor, setFilamentColor] = useState("");
  const [etaMin, setEtaMin] = useState("");
  const [deadline, setDeadline] = useState("");
  const [productId, setProductId] = useState<number | null>(null);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [showCreateTag, setShowCreateTag] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { tags, reload: reloadTags, setTaskTags } = useTags();

  useEffect(() => {
    if (open) api<ProductOption[]>("/api/warehouse/products/options").then(setProducts).catch(() => {});
  }, [open]);

  function reset() {
    setTitle(""); setQty("1"); setFilamentType("");
    setFilamentColor(""); setEtaMin(""); setDeadline("");
    setProductId(null); setFile(null); setError(null); setTagIds([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const task = await api<PrintTask>("/api/queue", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          quantity: parseInt(qty) || 1,
          filament_type: filamentType || null,
          filament_color: filamentColor || null,
          estimated_minutes: etaMin ? parseInt(etaMin) : null,
          deadline: deadline || null,
          product_id: productId,
        }),
      });

      // Upload file (if any) — multipart, separate request
      let final = task;
      if (file) {
        const fd = new FormData();
        fd.append("file", file);
        const resp = await fetch(`${API_URL}/api/queue/${task.id}/file`, {
          method: "POST",
          headers: { Authorization: `Bearer ${getToken()}` },
          body: fd,
        });
        if (!resp.ok) {
          const data = await resp.json().catch(() => ({}));
          throw new ApiError(resp.status, data.detail ?? "Не вдалося завантажити файл");
        }
        final = (await resp.json()) as PrintTask;
      }

      if (tagIds.length > 0) {
        await setTaskTags(final.id, tagIds).catch(() => {});
      }
      onCreated(final);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => { if (!busy) { reset(); onClose(); } }}
      title="Нова задача на друк"
      footer={
        <>
          <button type="button" onClick={() => { reset(); onClose(); }} disabled={busy}
            className="btn btn-ghost disabled:opacity-50">
            Скасувати
          </button>
          <button type="submit" form="create-task-form" disabled={busy || !title.trim()}
            className="btn btn-primary disabled:opacity-50">
            {busy ? "Зберігаю…" : "Додати"}
          </button>
        </>
      }
    >
      <form id="create-task-form" onSubmit={submit} className="space-y-3 text-sm">
        <label className="block">
          <span className="mb-1 block">Назва / деталь</span>
          <input type="text" required value={title} onChange={e => setTitle(e.target.value)}
            placeholder="Корпус для проєкту X"
            className="input"
            autoFocus />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block">Кількість</span>
            <input type="number" min={1} value={qty} onChange={e => setQty(e.target.value)}
              className="input" />
          </label>
          <label className="block">
            <span className="mb-1 block">Час друку (хв)</span>
            <input type="number" min={0} value={etaMin} onChange={e => setEtaMin(e.target.value)}
              placeholder="240"
              className="input" />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block">Пластик</span>
            <input type="text" value={filamentType} onChange={e => setFilamentType(e.target.value)}
              placeholder="PLA, PETG…"
              className="input" />
          </label>
          <label className="block">
            <span className="mb-1 block">Колір</span>
            <input type="text" value={filamentColor} onChange={e => setFilamentColor(e.target.value)}
              placeholder="Чорний"
              className="input" />
          </label>
        </div>
        {products.length > 0 && (
          <label className="block">
            <span className="mb-1 block">
              Товар <span className="text-[var(--text-faint)]">— при завершенні автоматично додасть на склад</span>
            </span>
            <select value={productId ?? ""} onChange={e => setProductId(e.target.value ? Number(e.target.value) : null)}
              className="input">
              <option value="">— не прив’язано до SKU —</option>
              {products.map(p => (
                <option key={p.id} value={p.id}>{p.sku} · {p.name}</option>
              ))}
            </select>
          </label>
        )}
        <label className="block">
          <span className="mb-1 block">Дедлайн (опційно)</span>
          <input type="date" value={deadline} onChange={e => setDeadline(e.target.value)}
            className="input" />
        </label>
        <label className="block">
          <span className="mb-1 block">
            Файл друку <span className="text-[var(--text-faint)]">(.gcode, .3mf, опційно)</span>
          </span>
          <input
            ref={fileInputRef}
            type="file"
            accept=".gcode,.gco,.g,.3mf,.bgcode"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-xs text-[var(--text-muted)] file:mr-3 file:rounded-md file:border-0 file:bg-[var(--accent)] file:px-3 file:py-1.5 file:text-xs file:text-[var(--on-accent)] file:hover:bg-[var(--accent-hi)]"
          />
          {file && (
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              {file.name} · {(file.size / 1024).toFixed(0)} КБ
            </p>
          )}
        </label>
        <div>
          <span className="mb-1 block">Теги</span>
          <TagPicker
            available={tags}
            selected={tagIds}
            onChange={setTagIds}
            onCreateTag={() => setShowCreateTag(true)}
          />
        </div>
        {error && <p className="text-[var(--state-error)]">{error}</p>}
      </form>
      <CreateTagModal
        open={showCreateTag}
        onClose={() => setShowCreateTag(false)}
        onCreated={() => { reloadTags(); setShowCreateTag(false); }}
      />
    </Modal>
  );
}
