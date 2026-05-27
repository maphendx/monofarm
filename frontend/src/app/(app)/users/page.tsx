"use client";

import { UsersSection } from "@/components/users/UsersSection";
import { usePageTitle } from "@/lib/usePageTitle";

export default function UsersPage() {
  usePageTitle("nav.users");
  return <UsersSection />;
}
