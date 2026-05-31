"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Modal } from "@/components/ui/Modal";
import { Batch } from "./CreateBatchModal";

type Warehouse = { id: number; name: string; type: string };

export function CloseBatchModal({
  batch, open, onClose, onClosed
}: { 
  batch: Batch | null;
  open: boolean; 
  onClose: () => void; 
  onClosed: (b: Batch) => void;
}) {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [goodQty, setGoodQty] = useState(() => batch ? batch.target_qty.toString() : "");
  const [defectQty, setDefectQty] = useState("0");
  const [whGoodId, setWhGoodId] = useState("");
  const [whDefectId, setWhDefectId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    api<Warehouse[]>("/api/warehouse/warehouses").then((w) => {
      setWarehouses(w);
      if (w.length > 0) {
        const physical = w.find(x => x.type === "physical") ?? w[0];
        setWhGoodId(physical.id.toString());
      }
    }).catch(() => {});
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current || !batch) return;
    inFlight.current = true;
    setBusy(true); setError(null);
    try {
      const gQty = parseInt(goodQty) || 0;
      const dQty = parseInt(defectQty) || 0;
      
      const body: Record<string, unknown> = {
        good_qty: gQty,
        defect_qty: dQty,
      };
      if (gQty > 0 && whGoodId) body.finished_warehouse_id = parseInt(whGoodId);
      if (dQty > 0 && whDefectId) body.defect_warehouse_id = parseInt(whDefectId);

      const b = await api<Batch>(`/api/warehouse/batches/${batch.id}/close`, { method: "POST", body: JSON.stringify(body) });
      onClosed(b);
      onClose();
    } catch { setError("Помилка збереження"); }
    finally { inFlight.current = false; setBusy(false); }
  }

  const inputCls = "w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-sm outline-none focus:border-[var(--border-focus)] ";

  if (!batch) return null;

  return (
    <Modal open={open} onClose={onClose} title="Завершення партії"
      footer={<>
        <button type="button" onClick={onClose} disabled={busy}
          className="rounded-md px-3 py-1.5 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)]  ">
          Скасувати
        </button>
        <button type="submit" form="close-batch-form" disabled={busy}
          className="rounded-md bg-[rgba(34,197,94,.9)] px-3 py-1.5 text-sm text-white hover:bg-[rgba(34,197,94,1)] disabled:opacity-50  ">
          {busy ? "Зберігаю…" : "Завершити та додати на склад"}
        </button>
      </>}
    >
      <form id="close-batch-form" onSubmit={submit} className="space-y-4 text-sm">
        <p className="text-[var(--text-muted)] mb-2">Вкажіть, скільки деталей з цієї партії піде на склад.</p>
        
        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="mb-1 block text-[var(--state-ok)] font-medium">Якісні деталі</span>
            <input type="number" required min={0} value={goodQty} onChange={(e) => setGoodQty(e.target.value)} className={inputCls} />
          </label>
          <label className="block">
            <span className="mb-1 block text-[var(--state-error)] font-medium">Брак</span>
            <input type="number" required min={0} value={defectQty} onChange={(e) => setDefectQty(e.target.value)} className={inputCls} />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)]">Склад для якісних</span>
            <select required={parseInt(goodQty) > 0} value={whGoodId} onChange={(e) => setWhGoodId(e.target.value)} className={inputCls}>
              <option value="">— обери склад —</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)]">Склад для браку</span>
            <select required={parseInt(defectQty) > 0} value={whDefectId} onChange={(e) => setWhDefectId(e.target.value)} className={inputCls}>
              <option value="">— обери склад —</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
        </div>

        {error && <p className="text-sm text-[var(--state-error)]">{error}</p>}
      </form>
    </Modal>
  );
}
