"use client";

import { useRouter } from "next/navigation";
import { ScannerModal } from "@/components/warehouse/ScannerModal";

/** Fullscreen scanner workstation — iPad/worker mode without dashboard chrome. */
export default function ScannerPage() {
  const router = useRouter();
  return <ScannerModal fullscreen onClose={() => router.push("/warehouse")} />;
}
