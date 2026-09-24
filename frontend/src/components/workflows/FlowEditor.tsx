"use client";

import "@xyflow/react/dist/style.css";
import { Background, BackgroundVariant, Controls, ReactFlow, ReactFlowProvider, applyEdgeChanges, applyNodeChanges, useReactFlow, type Connection, type Edge, type EdgeChange, type NodeChange } from "@xyflow/react";
import { Check, History, Plus, Play, Save, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { NodeConfigPanel } from "@/components/workflows/NodeConfigPanel";
import { NodePalette } from "@/components/workflows/NodePalette";
import { WorkflowNodeView, NODE_TYPE_NAME, type WFNode } from "@/components/workflows/WorkflowNode";
import { api } from "@/lib/api";
import { useUser } from "@/lib/auth-context";
import { useLocale, useT } from "@/lib/i18n";
import { nextNodeKey, pick, type Catalog, type Workflow, type WorkflowGraph, type WorkflowRun } from "@/lib/workflows";
import styles from "./FlowEditor.module.css";

const nodeTypes = { wf: WorkflowNodeView };
function graphToNodes(graph: WorkflowGraph, catalog: Catalog, locale: "uk" | "en"): WFNode[] {
  return graph.nodes.map((node, index) => {
    const spec = catalog.nodes.find(spec => spec.type === node.type) ?? {
      type: node.type, category: "action" as const, icon: "", title: { uk: node.type, en: node.type }, description: { uk: "", en: "" }, outputs: [], config: [],
    };
    return { id: node.key, type: NODE_TYPE_NAME, position: node.position ?? { x: 80 + index * 320, y: 180 }, data: { spec, node, locale, category: spec.category } };
  });
}
function graphToEdges(graph: WorkflowGraph): Edge[] {
  return graph.edges.map((edge, index) => ({ id: `e${index}`, source: edge.source, target: edge.target, sourceHandle: edge.source_port ?? "out", type: "default" }));
}
function toGraph(nodes: WFNode[], edges: Edge[]): WorkflowGraph {
  return { nodes: nodes.map(node => ({ ...node.data.node, position: { x: Math.round(node.position.x), y: Math.round(node.position.y) } })), edges: edges.map(edge => ({ source: edge.source, target: edge.target, source_port: edge.sourceHandle ?? "out" })) };
}

interface EditorProps {
  workflow: Workflow;
  catalog: Catalog;
  onSaved: (workflow: Workflow) => void;
  selectedRun: WorkflowRun | null;
  onRunCreated: (id: number) => void;
  onDirtyChange?: (dirty: boolean) => void;
  runsPanel?: ReactNode;
}

function Canvas({ workflow, catalog, onSaved, selectedRun, onRunCreated, onDirtyChange, runsPanel }: EditorProps) {
  const { locale } = useLocale();
  const t = useT();
  const user = useUser();
  const canEdit = !!user.org_workflows_enabled && (user.role === "admin" || user.role === "operator");
  const rf = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<WFNode[]>(() => graphToNodes(workflow.graph, catalog, locale));
  const [edges, setEdges] = useState<Edge[]>(() => graphToEdges(workflow.graph));
  const [name, setName] = useState(workflow.name);
  const [enabled, setEnabled] = useState(workflow.enabled);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [panel, setPanel] = useState<"library" | "config" | "runs" | null>(null);
  const inFlight = useRef(false);
  const dirtyCallback = useRef(onDirtyChange);
  useEffect(() => { dirtyCallback.current = onDirtyChange; }, [onDirtyChange]);
  useEffect(() => { dirtyCallback.current?.(dirty); }, [dirty]);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);

  const sameRunGraph = !selectedRun?.graph_snapshot || JSON.stringify(selectedRun.graph_snapshot) === JSON.stringify(workflow.graph);
  const overlayRun = !dirty && sameRunGraph ? selectedRun : null;
  const displayNodes = useMemo(() => nodes.map(node => ({ ...node, data: { ...node.data, locale, runState: overlayRun?.node_states[node.id] } })), [nodes, locale, overlayRun]);
  const displayEdges = useMemo(() => edges.map(edge => {
    const source = nodes.find(node => node.id === edge.source);
    const port = source?.data.spec.outputs.find(port => port.name === edge.sourceHandle);
    const state = overlayRun?.node_states[edge.source]?.status;
    return { ...edge, label: source && source.data.spec.outputs.length > 1 ? pick(port?.title, locale) : undefined, animated: state === "running" || state === "waiting", style: { stroke: "var(--state-print)", strokeWidth: 1.5 } };
  }), [edges, nodes, locale, overlayRun]);

  function changeNodes(changes: NodeChange<WFNode>[]) {
    if (inFlight.current || !canEdit) return;
    setNodes(current => applyNodeChanges(changes, current));
    if (changes.some(change => change.type !== "select" && change.type !== "dimensions")) setDirty(true);
  }
  function changeEdges(changes: EdgeChange[]) {
    if (inFlight.current || !canEdit) return;
    setEdges(current => applyEdgeChanges(changes, current));
    if (changes.some(change => change.type === "remove")) setDirty(true);
  }
  const validConnection = useCallback((connection: Edge | Connection) => {
    if (connection.source === connection.target || nodes.find(node => node.id === connection.target)?.data.category === "trigger") return false;
    const visited = new Set<string>();
    const reaches = (key: string): boolean => {
      if (key === connection.source) return true;
      if (visited.has(key)) return false;
      visited.add(key);
      return edges.filter(edge => edge.source === key).some(edge => reaches(edge.target));
    };
    return !reaches(connection.target);
  }, [nodes, edges]);
  function connect(connection: Connection) {
    if (!canEdit || inFlight.current || !validConnection(connection)) return;
    setEdges(current => current.some(edge => edge.source === connection.source && edge.target === connection.target && edge.sourceHandle === connection.sourceHandle) ? current : [...current, { ...connection, id: crypto.randomUUID(), type: "default" }]);
    setDirty(true);
  }
  function addNode(type: string, point?: { x: number; y: number }) {
    if (!canEdit || inFlight.current) return;
    const spec = catalog.nodes.find(spec => spec.type === type);
    if (!spec) return;
    const rect = wrapper.current?.getBoundingClientRect();
    const position = point ?? rf.screenToFlowPosition({ x: (rect?.left ?? 0) + (rect?.width ?? 900) * .45, y: (rect?.top ?? 0) + (rect?.height ?? 600) * .45 });
    const key = nextNodeKey(toGraph(nodes, edges));
    const node = { key, type, name: "", config: {}, position };
    setNodes(current => [...current, { id: key, type: NODE_TYPE_NAME, position, data: { spec, node, locale, category: spec.category } }]);
    setSelectedKey(key);
    setPanel("config");
    setDirty(true);
  }
  function patchNode(patch: Partial<WFNode["data"]["node"]>) {
    if (!canEdit || inFlight.current) return;
    setNodes(current => current.map(node => node.id === selectedKey ? { ...node, data: { ...node.data, node: { ...node.data.node, ...patch } } } : node));
    setDirty(true);
  }
  function deleteSelected() {
    if (!canEdit || inFlight.current) return;
    setNodes(current => current.filter(node => node.id !== selectedKey));
    setEdges(current => current.filter(edge => edge.source !== selectedKey && edge.target !== selectedKey));
    setSelectedKey(null); setPanel(null); setDirty(true);
  }

  async function persist(run = false, nextEnabled = enabled) {
    if (inFlight.current || !canEdit) return;
    if (!name.trim()) { setError(t("flowStudio.nameRequired")); return; }
    const graph = toGraph(nodes, edges);
    for (const node of graph.nodes) {
      const spec = catalog.nodes.find(spec => spec.type === node.type);
      for (const field of spec?.config ?? []) {
        const value = node.config[field.key];
        if (field.required && (value == null || value === "" || (Array.isArray(value) && !value.length))) {
          setError(`${node.name || pick(spec?.title, locale)} · ${pick(field.label, locale)}: ${t("flowStudio.required")}`);
          return;
        }
      }
    }
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const updated = await api<Workflow>(`/api/workflows/${workflow.id}`, { method: "PUT", body: JSON.stringify({ name: name.trim(), graph, enabled: nextEnabled }) });
      // Use server-returned graph (including generated webhook tokens).
      setNodes(graphToNodes(updated.graph, catalog, locale));
      setEdges(graphToEdges(updated.graph));
      setEnabled(updated.enabled); setDirty(false); onSaved(updated);
      if (run) {
        const result = await api<{ id: number }>(`/api/workflows/${workflow.id}/run`, { method: "POST", body: JSON.stringify({ payload: {} }) });
        onRunCreated(result.id); setPanel("runs");
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : t("common.error"));
    } finally { inFlight.current = false; setBusy(false); }
  }
  const saveRef = useRef(persist);
  useEffect(() => { saveRef.current = persist; });
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void saveRef.current(); }
      if (event.key === "Escape") setPanel(null);
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, []);
  const selected = nodes.find(node => node.id === selectedKey);

  return <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="workflow-editor">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <input aria-label={t("workflows.namePlaceholder")} value={name} disabled={!canEdit || busy} onChange={event => { setName(event.target.value); setDirty(true); }} className="min-w-0 max-w-[260px] rounded-md border border-transparent bg-transparent px-1 py-1 text-sm font-semibold text-[var(--text-hi)] outline-none focus:border-[var(--border-strong)]" />
        <span className="flex items-center gap-1 text-[10px] text-[var(--text-faint)]">{dirty ? t("flowStudio.unsaved") : <><Check size={12} />{t("flowStudio.saved")}</>}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" role="switch" aria-checked={enabled} aria-label={t("flowStudio.enabled")} disabled={!canEdit || busy} onClick={() => void persist(false, !enabled)} className="flex items-center gap-1.5 rounded-full border border-[var(--border)] px-2.5 py-1 text-[11px] disabled:opacity-50" style={{ color: enabled ? "var(--state-ok)" : "var(--text-muted)" }}>
          <span className="h-1.5 w-1.5 rounded-full bg-current" />{enabled ? t("workflows.enabled") : t("workflows.disabled")}
        </button>
        <button className="btn btn-ghost btn-sm" aria-pressed={panel === "runs"} onClick={() => setPanel(panel === "runs" ? null : "runs")}><History size={14} />{t("flowStudio.runs")}</button>
        {canEdit && <><button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void persist()}><Save size={14} />{t(busy ? "common.saving" : "common.save")}</button>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void persist(true)}><Play size={13} />{t("flowStudio.run")}</button></>}
      </div>
    </div>
    {selectedRun && !sameRunGraph && <p className="text-xs text-[var(--text-muted)]">{t("flowStudio.oldRun")}</p>}
    {error && <p role="alert" className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-xs text-[var(--state-error)]">{error}</p>}
    <div className="relative flex min-h-[520px] flex-1 gap-3" style={{ height: "clamp(520px, 68vh, 820px)" }}>
      <div className="relative min-w-0 flex-1 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg)]" ref={wrapper}
        onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const type = event.dataTransfer.getData("application/monofarm-node"); if (type) addNode(type, rf.screenToFlowPosition({ x: event.clientX, y: event.clientY })); }}>
        <ReactFlow<WFNode> nodes={displayNodes} edges={displayEdges} nodeTypes={nodeTypes} onNodesChange={changeNodes} onEdgesChange={changeEdges} onConnect={connect} isValidConnection={validConnection}
          onNodeClick={(_, node) => { setSelectedKey(node.id); setPanel("config"); }} onPaneClick={() => setPanel(null)}
          nodesDraggable={canEdit && !busy} nodesConnectable={canEdit && !busy} edgesReconnectable={canEdit && !busy} deleteKeyCode={canEdit && !busy ? ["Backspace", "Delete"] : null}
          fitView fitViewOptions={{ padding: .28, maxZoom: 1 }} minZoom={.25} maxZoom={1.75} defaultEdgeOptions={{ type: "default", style: { stroke: "var(--state-print)", strokeWidth: 1.5 } }} proOptions={{ hideAttribution: true }} className={styles.canvas}>
          <Background variant={BackgroundVariant.Dots} gap={28} size={1} color="var(--border)" />
          <Controls position="bottom-right" showInteractive={false} />
        </ReactFlow>
        {canEdit && <button className="btn btn-secondary btn-sm absolute left-3 top-3 z-10 shadow-sm" disabled={busy} aria-expanded={panel === "library"} onClick={() => setPanel(panel === "library" ? null : "library")}><Plus size={14} />{t("flowStudio.addStep")}</button>}
        <p className="pointer-events-none absolute bottom-3 left-3 max-w-[70%] rounded-lg bg-[var(--bg-elevated)] px-2.5 py-1.5 text-[10px] text-[var(--text-faint)]">{t("flowStudio.canvasHint")}</p>
      </div>
      {panel && <aside className="absolute inset-y-0 right-0 z-20 flex w-[min(310px,100%)] flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-lg lg:static lg:w-[280px] lg:shrink-0 lg:shadow-none" aria-label={t(`flowStudio.${panel}`)}>
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-3 py-2.5">
          <span className="text-xs font-medium text-[var(--text-muted)]">{t(`flowStudio.${panel}`)}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setPanel(null)} aria-label={t("common.close")}><X size={14} /></button>
        </div>
        {panel === "library" && <NodePalette catalog={catalog.nodes} locale={locale} onAdd={addNode} />}
        {panel === "config" && selected && <fieldset disabled={busy || !canEdit} className="flex min-h-0 flex-1 flex-col"><NodeConfigPanel node={selected.data.node} spec={selected.data.spec} workflowId={workflow.id} onPatchConfig={config => patchNode({ config })} onRename={name => patchNode({ name })} onDelete={deleteSelected} /></fieldset>}
        {panel === "runs" && runsPanel}
      </aside>}
    </div>
  </div>;
}

export function FlowEditor(props: EditorProps) {
  return <ReactFlowProvider><Canvas key={props.workflow.id} {...props} /></ReactFlowProvider>;
}
