import { KanbanSkeleton } from "@/components/ui/ContentSkeleton";

export default function QueueLoading() {
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="skeleton h-7 w-44 rounded-lg" />
        <div className="flex items-center gap-2">
          <div className="skeleton h-9 w-28 rounded-lg" />
          <div className="skeleton h-9 w-36 rounded-lg" />
        </div>
      </div>
      <KanbanSkeleton columns={4} cardsPerCol={3} />
    </div>
  );
}
