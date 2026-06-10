import { redirect } from "next/navigation";

export default function PlanPage() {
  redirect("/queue?view=calendar");
}
