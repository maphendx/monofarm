"use client";

import { useRef, useState } from "react";
import { ConfirmDialog, type ConfirmOptions } from "@/components/ui/ConfirmDialog";

export function useConfirm() {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<((v: boolean) => void) | null>(null);

  function confirm(options: ConfirmOptions | string): Promise<boolean> {
    const o: ConfirmOptions = typeof options === "string" ? { message: options } : options;
    return new Promise<boolean>((res) => {
      resolveRef.current = res;
      setOpts(o);
    });
  }

  function handleConfirm() {
    setOpts(null);
    resolveRef.current?.(true);
  }

  function handleCancel() {
    setOpts(null);
    resolveRef.current?.(false);
  }

  const dialog = opts ? (
    <ConfirmDialog
      open
      opts={opts}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    />
  ) : null;

  return { confirm, dialog };
}
