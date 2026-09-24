"use client";

import { useParams } from "next/navigation";
import { FlowWorkspace } from "@/components/workflows/FlowWorkspace";
import { usePageTitle } from "@/lib/usePageTitle";

export default function WorkflowEditorPage() {
  usePageTitle("nav.workflows");
  const params = useParams<{ id: string }>();
  return <FlowWorkspace key={params.id} initialMode="automation" initialWorkflowId={Number(params.id)} />;
}
