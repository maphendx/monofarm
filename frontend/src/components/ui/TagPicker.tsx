"use client";

import { useState, useRef, useEffect } from "react";
import { Plus, Tag as TagIcon } from "lucide-react";
import { TagBadge, Tag } from "./TagBadge";

interface Props {
  /** All tags available in the org */
  available: Tag[];
  /** Currently assigned tag IDs */
  selected: number[];
  onChange: (ids: number[]) => void;
  disabled?: boolean;
  /** Open "Create tag" modal */
  onCreateTag?: () => void;
}

export function TagPicker({ available, selected, onChange, disabled, onCreateTag }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const selectedTags = available.filter((t) => selected.includes(t.id));
  const unselected = available.filter((t) => !selected.includes(t.id));

  const toggle = (id: number) => {
    if (selected.includes(id)) {
      onChange(selected.filter((s) => s !== id));
    } else {
      onChange([...selected, id]);
    }
  };

  return (
    <div className="relative inline-block" ref={ref}>
      {/* Selected tags strip */}
      <div className="flex flex-wrap gap-1 items-center">
        {selectedTags.map((tag) => (
          <TagBadge
            key={tag.id}
            tag={tag}
            onRemove={disabled ? undefined : () => toggle(tag.id)}
          />
        ))}

        {!disabled && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="inline-flex items-center gap-1 rounded-full border-2 border-dashed border-gray-300 hover:border-gray-400 px-2 py-0.5 text-xs text-gray-400 hover:text-gray-600 transition-colors"
          >
            <Plus className="h-3 w-3" />
            {selectedTags.length === 0 && "Add tag"}
          </button>
        )}
      </div>

      {/* Dropdown */}
      {open && (
        <div className="absolute z-50 mt-1 w-64 rounded-lg border border-gray-200 bg-white shadow-lg dark:bg-gray-900 dark:border-gray-700">
          <div className="p-2 border-b border-gray-100 dark:border-gray-800">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Assign tags</p>
          </div>

          {unselected.length === 0 && (
            <p className="px-3 py-2 text-xs text-gray-400">All tags assigned</p>
          )}

          <ul className="max-h-48 overflow-y-auto">
            {unselected.map((tag) => (
              <li key={tag.id}>
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-800 text-left"
                  onClick={() => toggle(tag.id)}
                >
                  <TagIcon className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                  <TagBadge tag={tag} />
                </button>
              </li>
            ))}
          </ul>

          {onCreateTag && (
            <div className="border-t border-gray-100 dark:border-gray-800 p-2">
              <button
                type="button"
                className="w-full text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1"
                onClick={() => { setOpen(false); onCreateTag(); }}
              >
                <Plus className="h-3 w-3" /> Create new tag
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
