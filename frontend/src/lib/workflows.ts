// Shared types + helpers for the workflow engine UI.
// Backend source of truth: app/services/workflow_nodes.py, app/schemas/workflow.py

export type Locale = "uk" | "en";
type Lstr = { uk: string; en: string };

export interface CatalogField {
  key: string;
  type: "text" | "textarea" | "number" | "select" | "switch" | "keyvalue" | "assignments";
  label: Lstr;
  required?: boolean;
  options?: { value: string; label: Lstr }[];
  placeholder?: string;
  hint?: Lstr;
}

export interface CatalogNode {
  type: string;
  category: "trigger" | "flow" | "action";
  icon: string;
  title: Lstr;
  description: Lstr;
  outputs: { name: string; title: Lstr }[];
  config: CatalogField[];
}

export interface CatalogEvent {
  type: string;
  title: Lstr;
  payload: string[];
}

export interface Catalog {
  nodes: CatalogNode[];
  events: CatalogEvent[];
}

export interface GraphNode {
  key: string;
  type: string;
  name?: string;
  config: Record<string, unknown>;
  position: { x: number; y: number };
}

export interface GraphEdge {
  source: string;
  target: string;
  source_port?: string;
}

export interface WorkflowGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface Workflow {
  id: number;
  name: string;
  description: string | null;
  graph: WorkflowGraph;
  enabled: boolean;
  version: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface RunNodeState {
  status: "pending" | "running" | "waiting" | "success" | "failed" | "skipped";
  outputs?: Record<string, unknown>;
  error?: string | null;
  wake_at?: string | null;
  input?: unknown;
  started_at?: string | null;
  finished_at?: string | null;
}

export interface WorkflowRun {
  id: number;
  workflow_id: number;
  status: "pending" | "running" | "waiting" | "success" | "failed" | "stopped";
  trigger_type: string;
  trigger_payload: Record<string, unknown>;
  graph_snapshot?: WorkflowGraph;
  node_states: Record<string, RunNodeState>;
  variables: Record<string, unknown>;
  error: string | null;
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export function pick(value: Lstr | undefined, locale: Locale): string {
  if (!value) return "";
  return locale === "en" ? value.en || value.uk : value.uk || value.en;
}

export const RUN_STATUS_COLORS: Record<string, string> = {
  pending: "var(--text-faint)",
  running: "var(--state-print)",
  waiting: "var(--state-warn)",
  success: "var(--state-ok)",
  failed: "var(--state-error)",
  stopped: "var(--state-offline)",
};

export function nextNodeKey(graph: WorkflowGraph): string {
  let max = 0;
  for (const n of graph.nodes) {
    const m = /^n(\d+)$/.exec(n.key);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `n${max + 1}`;
}
