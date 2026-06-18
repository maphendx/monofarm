"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { MascotLoader } from "@/components/ui/MascotLoader";
import { getToken } from "@/lib/api";

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace(getToken() ? "/dashboard" : "/login");
  }, [router]);
  return <MascotLoader />;
}
