"use client";

import Link from "next/link";

import { useCallback, useEffect, useRef, useState } from "react";
import { GitBranch, Plus, Printer as PrinterIcon, RotateCw, Trash2 } from "lucide-react";
import { FlowView } from "@/components/dashboard/FlowView";
import { FlowEditor } from "@/components/workflows/FlowEditor";
import { RunsPanel } from "@/components/workflows/RunsPanel";
import { api, ApiError } from "@/lib/api";
import { useUser } from "@/lib/auth-context";
import { useT } from "@/lib/i18n";
import type { Printer } from "@/lib/types";
import type { Catalog, Workflow, WorkflowRun } from "@/lib/workflows";

export function FlowWorkspace({ printers, initialWorkflowId, initialMode = "production" }: { printers?: Printer[]; initialWorkflowId?: number; initialMode?: "production" | "automation" }) {
  const t = useT();
  const user = useUser();
  const canManage = user.role === "admin" || user.role === "operator";
  const canEdit = canManage && !!user.org_workflows_enabled;
  const [mode, setMode] = useState(initialWorkflowId ? "automation" : initialMode);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(initialWorkflowId ?? null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const dirty = useRef(false);
  const inFlight = useRef(false);

  useEffect(() => {
    if (mode !== "automation") return;
    let active = true;
    setLoading(true);
    setError(null);
    Promise.all([api<Workflow[]>("/api/workflows"), api<Catalog>("/api/workflows/catalog")]).then(([list, specs]) => {
      if (!active) return;
      setWorkflows(list); setCatalog(specs);
      setSelectedId(current => current ?? list[0]?.id ?? null);
    }).catch(error => {
      if (!active) return;
      setError(error instanceof ApiError ? error.message : t("common.error"));
    })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [mode, reload, t]);

  function allowSwitch() { return !dirty.current || window.confirm(t("flowStudio.discard")); }
  function switchMode(next: "production" | "automation") {
    if (next === mode || !allowSwitch()) return;
    dirty.current = false; setMode(next);
  }
  const saved = useCallback((workflow: Workflow) => setWorkflows(current => current.map(item => item.id === workflow.id ? workflow : item)), []);
  async function create() {
    if (inFlight.current || !name.trim() || !allowSwitch()) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const workflow = await api<Workflow>("/api/workflows", { method: "POST", body: JSON.stringify({ name: name.trim(), enabled: false, graph: { nodes: [{ key: "n1", type: "trigger.manual", config: {}, position: { x: 100, y: 160 } }], edges: [] } }) });
      setWorkflows(current => [workflow, ...current]); setSelectedId(workflow.id); setCreating(false); setName(""); dirty.current = false;
    } catch (error) { setError(error instanceof Error ? error.message : t("common.error")); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function remove(workflow: Workflow) {
    if (inFlight.current || !window.confirm(t("workflows.deleteConfirm"))) return;
    inFlight.current = true; setBusy(true);
    try {
      await api(`/api/workflows/${workflow.id}`, { method: "DELETE" });
      const next = workflows.filter(item => item.id !== workflow.id);
      setWorkflows(next); setSelectedId(next[0]?.id ?? null); dirty.current = false;
    } catch (error) { setError(error instanceof Error ? error.message : t("common.error")); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function disableWorkflow(workflow: Workflow) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const updated = await api<Workflow>(`/api/workflows/${workflow.id}`, { method: "PUT", body: JSON.stringify({ enabled: false }) });
      saved(updated);
    } catch (error) { setError(error instanceof Error ? error.message : t("common.error")); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const workflow = workflows.find(workflow => workflow.id === selectedId);

  return <section className="flex min-w-0 flex-col gap-3" aria-label={t("flowStudio.title")}>
    <div className="flex flex-wrap items-center gap-3">
      {printers ? <div className="inline-flex rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-0.5" role="group" aria-label={t("flowStudio.view")}>
        {([{ id: "production", icon: PrinterIcon }, { id: "automation", icon: GitBranch }] as const).map(item => <button key={item.id} type="button" aria-pressed={mode === item.id} onClick={() => switchMode(item.id)} className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors ${mode === item.id ? "bg-[var(--surface-hi)] font-medium text-[var(--text-hi)]" : "text-[var(--text-muted)] hover:bg-[var(--surface-hi)]"}`}><item.icon size={13} />{t(`flowStudio.${item.id}`)}</button>)}
      </div> : <div className="flex items-center gap-2"><GitBranch size={17} className="text-[var(--accent)]" /><h1 className="text-base font-semibold">{t("flowStudio.title")}</h1></div>}
      {mode === "automation" && <>
        <span className="rounded-full border border-[var(--state-warn)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--state-warn)]">{t("common.experimental")}</span>
        {workflows.length > 0 && <select aria-label={t("flowStudio.selectWorkflow")} className="input min-w-0 max-w-[240px] text-xs" value={selectedId ?? ""} onChange={event => { if (allowSwitch()) { dirty.current = false; setSelectedId(Number(event.target.value)); } }}>
          {workflows.map(workflow => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}
        </select>}
        <div className="ml-auto flex items-center gap-2">
          {canEdit && user.role === "admin" && workflow && <button className="btn btn-ghost btn-sm" disabled={busy} aria-label={t("workflows.delete")} onClick={() => void remove(workflow)}><Trash2 size={13} /></button>}
          {canEdit && <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setCreating(true)}><Plus size={14} />{t("flowStudio.new")}</button>}
        </div>
      </>}
    </div>
    {mode === "automation" && !user.org_workflows_enabled && <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--border)] p-3 text-sm text-[var(--text-muted)]">
      <p>{t("settingsNotifications.editorOff")}</p>
      {user.role === "admin" && <Link className="btn btn-secondary btn-sm" href="/settings?section=notifications">{t("settingsNotifications.openSettings")}</Link>}
      {canManage && workflow?.enabled && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void disableWorkflow(workflow)}>{t("settingsNotifications.disableWorkflow")}</button>}
    </div>}
    {mode === "production" && printers ? <FlowView printers={printers} /> : <>
      {creating && <form onSubmit={event => { event.preventDefault(); void create(); }} className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-3">
        <input autoFocus aria-label={t("workflows.namePlaceholder")} maxLength={120} className="input min-w-0 flex-1 text-sm" value={name} onChange={event => setName(event.target.value)} placeholder={t("workflows.namePlaceholder")} disabled={busy} />
        <button className="btn btn-primary btn-sm" disabled={busy || !name.trim()}>{t(busy ? "common.saving" : "common.create")}</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setCreating(false)}>{t("common.cancel")}</button>
      </form>}
      {error && <div role="alert" className="flex items-center gap-2 rounded-lg border border-[var(--border)] p-3 text-xs text-[var(--state-error)]">
        {error}
        {<button className="btn btn-ghost btn-sm" onClick={() => setReload(value => value + 1)}><RotateCw size={13} />{t("printOutput.retry")}</button>}
      </div>}
      {loading ? <div role="status" className="flex min-h-[520px] items-center justify-center rounded-xl border border-[var(--border)] text-sm text-[var(--text-muted)]">{t("common.loading")}</div> : workflow && catalog ?
        <WorkflowStudio key={workflow.id} workflow={workflow} catalog={catalog} onSaved={saved} onDirtyChange={value => { dirty.current = value; }} /> : !error &&
        <div className="flex min-h-[520px] items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--bg)] p-6" style={{ backgroundImage: "radial-gradient(circle, var(--border) 1px, transparent 1px)", backgroundSize: "28px 28px" }}>
          <div className="max-w-sm rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-6 text-center shadow-md">
            <GitBranch size={24} strokeWidth={1.5} className="mx-auto text-[var(--accent)]" />
            <h2 className="mt-3 text-sm font-semibold">{selectedId ? t("workflows.notFound") : t("flowStudio.emptyTitle")}</h2>
            <p className="mt-2 text-xs leading-relaxed text-[var(--text-muted)]">{t("flowStudio.emptyHint")}</p>
            {canEdit && <button className="btn btn-primary btn-sm mt-4" onClick={() => setCreating(true)}><Plus size={14} />{t("flowStudio.new")}</button>}
          </div>
        </div>}
    </>}
  </section>;
}

function WorkflowStudio({ workflow, catalog, onSaved, onDirtyChange }: { workflow: Workflow; catalog: Catalog; onSaved: (workflow: Workflow) => void; onDirtyChange: (dirty: boolean) => void }) {
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [selectedRun, setSelectedRun] = useState<WorkflowRun | null>(null);
  const selectRun = useCallback((run: WorkflowRun | null) => { setSelectedRunId(run?.id ?? null); setSelectedRun(run); }, []);
  return <FlowEditor workflow={workflow} catalog={catalog} onSaved={updated => { setSelectedRunId(null); setSelectedRun(null); onSaved(updated); }} selectedRun={selectedRun} onDirtyChange={onDirtyChange}
    onRunCreated={id => { setSelectedRunId(id); setSelectedRun(null); }}
    runsPanel={<RunsPanel workflowId={workflow.id} selectedRunId={selectedRunId} onSelectRun={selectRun} />} />;
}
