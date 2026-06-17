"use client";

import { useState, useEffect, useCallback } from "react";
import { api, API_URL } from "@/lib/api";
import type { Tag } from "@/components/ui/TagBadge";

export interface TagsMatchResult {
  printer_id: number;
  printer_name: string;
  matches: boolean;
  reasons: string[];
}

export function useTags() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<Tag[]>(`${API_URL}/api/tags`);
      setTags(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const deleteTag = async (id: number) => {
    await api(`${API_URL}/api/tags/${id}`, { method: "DELETE" });
    await reload();
  };

  const setPrinterTags = async (printerId: number, tagIds: number[]) => {
    await api(`${API_URL}/api/printers/${printerId}/tags`, {
      method: "PUT",
      body: JSON.stringify({ tag_ids: tagIds }),
    });
  };

  const setTaskTags = async (taskId: number, tagIds: number[]) => {
    await api(`${API_URL}/api/queue/${taskId}/tags`, {
      method: "PUT",
      body: JSON.stringify({ tag_ids: tagIds }),
    });
  };

  const setFileTags = async (fileId: number, tagIds: number[]) => {
    await api(`${API_URL}/api/files/${fileId}/tags`, {
      method: "PUT",
      body: JSON.stringify({ tag_ids: tagIds }),
    });
  };

  const getMatchingPrinters = async (taskId: number): Promise<TagsMatchResult[]> => {
    return api<TagsMatchResult[]>(`${API_URL}/api/queue/${taskId}/matching-printers`);
  };

  return { tags, loading, reload, deleteTag, setPrinterTags, setTaskTags, setFileTags, getMatchingPrinters };
}
