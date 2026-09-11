import { CardsSkeleton } from "@/components/ui/ContentSkeleton";

export default function FilesLoading() {
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="skeleton h-7 w-40 rounded-lg" />
        <div className="flex items-center gap-2">
          <div className="skeleton h-9 w-32 rounded-lg" />
          <div className="skeleton h-9 w-28 rounded-lg" />
        </div>
      </div>
      <div className="skeleton h-10 w-full max-w-md rounded-lg" />
      <CardsSkeleton count={6} cols={3} />
    </div>
  );
}
