import { PageSkeleton } from "@/components/ui/ContentSkeleton";

export default function WarehouseLoading() {
  return (
    <div className="p-6 space-y-6">
      <PageSkeleton rows={10} cols={6} withStats={true} statsCount={4} />
    </div>
  );
}
