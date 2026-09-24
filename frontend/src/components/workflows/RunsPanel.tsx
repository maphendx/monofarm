"use client";

import { useEffect, useRef, useState } from "react";
import { Square } from "lucide-react";
import { api } from "@/lib/api";
import { useUser } from "@/lib/auth-context";
import { useLocale, useT } from "@/lib/i18n";
import { RUN_STATUS_COLORS, type WorkflowRun } from "@/lib/workflows";

const activeStatuses = new Set(["pending", "running", "waiting"]);
function JsonBlock({ value }: { value: unknown }) {
  return <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-[var(--border)] bg-[var(--bg)] p-2 font-mono text-[10px] text-[var(--text-muted)]">{JSON.stringify(value, null, 2)}</pre>;
}

export function RunsPanel({ workflowId, selectedRunId, onSelectRun }: { workflowId: number; selectedRunId: number | null; onSelectRun: (run: WorkflowRun | null) => void }) {
  const t = useT();
  const { locale } = useLocale();
  const user = useUser();
  const canEdit = user.role === "admin" || user.role === "operator";
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [detail, setDetail] = useState<WorkflowRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [stopping, setStopping] = useState(false);
  const stopInFlight = useRef(false);
  const callback = useRef(onSelectRun);
  useEffect(() => { callback.current = onSelectRun; }, [onSelectRun]);
  useEffect(() => {
    let active = true;
    let pending = false;
    if (selectedRunId === null) setDetail(null);
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const [list, fresh] = await Promise.all([
          api<WorkflowRun[]>(`/api/workflows/${workflowId}/runs?limit=50`),
          selectedRunId === null ? Promise.resolve(null) : api<WorkflowRun>(`/api/workflows/runs/${selectedRunId}`),
        ]);
        if (!active) return;
        setRuns(list); setDetail(fresh); setError(null);
        if (fresh) callback.current(fresh);
      } catch (error) { if (active) setError(error instanceof Error ? error.message : t("common.error")); }
      finally { pending = false; if (active) setLoading(false); }
    };
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [workflowId, selectedRunId, reload, t]);

  async function stopRun(id: number) {
    if (stopInFlight.current) return;
    stopInFlight.current = true; setStopping(true);
    try { await api(`/api/workflows/runs/${id}/stop`, { method: "POST", body: JSON.stringify({}) }); setReload(value => value + 1); }
    catch (error) { setError(error instanceof Error ? error.message : t("common.error")); }
    finally { stopInFlight.current = false; setStopping(false); }
  }
  return <div className="flex min-h-0 flex-1 flex-col">
    {error && <div role="alert" className="px-3 py-2 text-xs text-[var(--state-error)]">{error}<button className="btn btn-ghost btn-sm" onClick={() => setReload(value => value + 1)}>{t("printOutput.retry")}</button></div>}
    <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
      {!runs.length && <p className="px-1 py-2 text-xs leading-relaxed text-[var(--text-muted)]">{t(loading ? "common.loading" : "flowStudio.noRuns")}</p>}
      {runs.map(run => <button key={run.id} onClick={() => onSelectRun(run.id === selectedRunId ? null : run)} className={`w-full rounded-lg border px-2.5 py-2 text-left transition-colors hover:bg-[var(--surface-hi)] ${run.id === selectedRunId ? "border-[var(--accent)] bg-[var(--surface-hi)]" : "border-[var(--border)]"}`}>
        <span className="flex items-center justify-between gap-2 text-[11px]"><span className="flex items-center gap-1.5" style={{ color: RUN_STATUS_COLORS[run.status] }}><span className="h-1.5 w-1.5 rounded-full bg-current" />{t(`flowStudio.${run.status}`)}</span><span className="font-mono text-[10px] text-[var(--text-faint)]">#{run.id}</span></span>
        <span className="mt-1 flex justify-between gap-2 text-[10px] text-[var(--text-muted)]"><span className="truncate">{run.trigger_type}</span><span className="shrink-0">{run.created_at ? new Date(run.created_at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) : "—"}</span></span>
      </button>)}
    </div>
    {detail && <div className="max-h-[60%] space-y-2 overflow-y-auto border-t border-[var(--border)] p-3">
      <div className="flex items-center justify-between"><p className="text-xs font-medium">{t("flowStudio.runDetails")} #{detail.id}</p>{canEdit && activeStatuses.has(detail.status) && <button className="btn btn-ghost btn-sm text-[var(--state-error)]" disabled={stopping} onClick={() => void stopRun(detail.id)}><Square size={11} />{t("flowStudio.stop")}</button>}</div>
      {detail.error && <p className="text-xs text-[var(--state-error)]">{detail.error}</p>}
      {Object.entries(detail.node_states).map(([key, state]) => <div key={key} className="rounded-lg border border-[var(--border)] p-2">
        <div className="flex items-center justify-between text-[10px]"><span className="font-mono text-[var(--text-muted)]">{key}</span><span style={{ color: RUN_STATUS_COLORS[state.status] }}>{t(`flowStudio.${state.status}`)}</span></div>
        {state.error && <p className="mt-1 break-words text-[11px] text-[var(--state-error)]">{state.error}</p>}
        {state.outputs && <details className="mt-1 text-[10px] text-[var(--text-faint)]"><summary className="cursor-pointer">{t("flowStudio.output")}</summary><JsonBlock value={state.outputs} /></details>}
      </div>)}
      <details className="text-[10px] text-[var(--text-faint)]"><summary className="cursor-pointer">{t("flowStudio.input")}</summary><JsonBlock value={detail.trigger_payload} /></details>
      {Object.keys(detail.variables).length > 0 && <details className="text-[10px] text-[var(--text-faint)]"><summary className="cursor-pointer">{t("flowStudio.variables")}</summary><JsonBlock value={detail.variables} /></details>}
    </div>}
  </div>;
}
