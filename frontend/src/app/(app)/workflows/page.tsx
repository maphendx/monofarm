"use client";

import { FlowWorkspace } from "@/components/workflows/FlowWorkspace";
import { usePageTitle } from "@/lib/usePageTitle";

export default function WorkflowsPage() {
  usePageTitle("nav.workflows");
  return <FlowWorkspace initialMode="automation" />;
}
