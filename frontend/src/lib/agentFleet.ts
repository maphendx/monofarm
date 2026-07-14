export type AgentReleaseHealth =
  | "current"
  | "update_required"
  | "not_connected"
  | "release_unavailable";

export function togglePrinterAssignment(
  assignedPrinterIds: number[],
  printerId: number,
): number[] {
  const next = assignedPrinterIds.includes(printerId)
    ? assignedPrinterIds.filter((id) => id !== printerId)
    : [...assignedPrinterIds, printerId];
  return [...new Set(next)].sort((a, b) => a - b);
}

export function getAgentReleaseHealth(
  installedVersion: string | null,
  currentVersion: string,
  releaseAvailable: boolean,
): AgentReleaseHealth {
  if (!releaseAvailable) return "release_unavailable";
  if (!installedVersion) return "not_connected";
  return installedVersion === currentVersion ? "current" : "update_required";
}
