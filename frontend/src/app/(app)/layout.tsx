import { AppClientShell } from "@/components/layout/AppClientShell";


export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppClientShell>{children}</AppClientShell>;
}
