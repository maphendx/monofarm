"use client";

import { SendModal } from "@/components/files/SendModal";
import type { Printer } from "@/lib/types";

export function StartPrintModal({
  printer,
  printers,
  onClose,
}: {
  printer: Printer;
  printers: Printer[];
  onClose: () => void;
}) {
  return (
    <SendModal
      printers={printers}
      defaultPrinterId={printer.id}
      onClose={onClose}
    />
  );
}
