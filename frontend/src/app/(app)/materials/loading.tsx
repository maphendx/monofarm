import { StatsSkeleton, CardsSkeleton } from "@/components/ui/ContentSkeleton";

export default function MaterialsLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="skeleton h-7 w-40 rounded-lg" />
        <div className="skeleton h-9 w-28 rounded-lg" />
      </div>
      <StatsSkeleton count={3} />
      <div className="skeleton h-10 w-full rounded-lg" />
      <CardsSkeleton count={8} cols={4} />
    </div>
  );
}
