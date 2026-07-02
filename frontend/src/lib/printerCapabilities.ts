export function isA1Mini(model: string | null, devId: string | null): boolean {
  const normalized = (model ?? "")
    .toLowerCase()
    .replaceAll("-", "")
    .replaceAll("_", "")
    .replaceAll(" ", "");
  return normalized === "n1"
    || (normalized.includes("a1") && normalized.includes("mini"))
    || (devId ?? "").toUpperCase().startsWith("030");
}
