import { CardsSkeleton } from "@/components/ui/ContentSkeleton";

export default function PrintersLoading() {
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="skeleton h-7 w-36 rounded-lg" />
        <div className="skeleton h-9 w-32 rounded-lg" />
      </div>
      <CardsSkeleton count={6} cols={3} />
    </div>
  );
}
