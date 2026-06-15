"use client";

import { PrintLaunchModal } from "@/components/files/PrintLaunchModal";
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
    <PrintLaunchModal
      printers={printers}
      defaultPrinterId={printer.id}
      onClose={onClose}
    />
  );
}
