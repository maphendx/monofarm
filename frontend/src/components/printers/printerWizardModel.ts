export function buildAnycubicCreateBody(name: string, ip: string) {
  return {
    name: name.trim(),
    kind: "anycubic" as const,
    anycubic_dev_ip: ip.trim(),
  };
}

export function buildAnycubicUpdateFields(kind: string, ip: string) {
  if (kind !== "anycubic") return {};
  return { anycubic_dev_ip: ip.trim() || null };
}

export async function runSingleSubmission(
  lock: { current: boolean },
  submit: () => Promise<void>,
): Promise<boolean> {
  if (lock.current) return false;
  lock.current = true;
  try {
    await submit();
    return true;
  } finally {
    lock.current = false;
  }
}
