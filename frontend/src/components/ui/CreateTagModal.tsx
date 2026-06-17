"use client";

import { useState } from "react";
import { api } from "@/lib/api";

const NOZZLE_SIZES = [0.2, 0.25, 0.4, 0.6, 0.8, 1.0];
const MATERIAL_TYPES = ["PLA", "PETG", "ABS", "ASA", "TPU", "PA", "PC", "PLA-CF", "PETG-CF"];
const BED_TYPES = ["PEI", "Textured PEI", "Smooth PEI", "Cool Plate", "Engineering Plate", "High Temp Plate", "Glass", "Garolite"];
const BADGE_COLORS = [
  "#e74c3c", "#e67e22", "#f1c40f", "#2ecc71", "#1abc9c",
  "#3498db", "#9b59b6", "#6b7280", "#111827",
];

type Kind = "nozzle" | "material" | "bed_type" | "custom";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function CreateTagModal({ open, onClose, onCreated }: Props) {
  const [kind, setKind] = useState<Kind>("custom");
  const [label, setLabel] = useState("");
  const [color, setColor] = useState(BADGE_COLORS[5]);
  const [nozzle, setNozzle] = useState(0.4);
  const [matType, setMatType] = useState("PLA");
  const [matColor, setMatColor] = useState("#ffffff");
  const [matColorName, setMatColorName] = useState("");
  const [bedType, setBedType] = useState("PEI");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      let body: Record<string, unknown>;
      if (kind === "nozzle") {
        body = { kind: "nozzle", meta: { diameter: nozzle } };
      } else if (kind === "material") {
        body = {
          kind: "material",
          meta: { type: matType, color: matColor, color_name: matColorName || matType },
        };
      } else if (kind === "bed_type") {
        body = { kind: "bed_type", meta: { bed_type: bedType } };
      } else {
        body = { kind: "custom", label: label.trim(), color };
      }
      await api("/api/tags", { method: "POST", body: JSON.stringify(body) });
      onCreated();
      onClose();
      setLabel(""); setKind("custom");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create tag");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-gray-900 shadow-2xl p-6">
        <h2 className="text-lg font-semibold mb-4">Create tag</h2>

        {/* Kind selector */}
        <div className="flex gap-2 mb-5">
          {(["nozzle", "material", "bed_type", "custom"] as Kind[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`flex-1 rounded-lg border py-1.5 text-sm font-medium transition-colors ${
                kind === k
                  ? "border-blue-600 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                  : "border-gray-200 text-gray-500 hover:border-gray-300"
              }`}
            >
              {k === "bed_type" ? "Bed" : k}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          {kind === "nozzle" && (
            <div>
              <label className="block text-sm font-medium mb-1">Nozzle diameter (mm)</label>
              <div className="flex flex-wrap gap-2">
                {NOZZLE_SIZES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setNozzle(s)}
                    className={`rounded-full border px-3 py-1 text-sm font-mono ${
                      nozzle === s
                        ? "border-indigo-600 bg-indigo-50 text-indigo-700"
                        : "border-gray-200 text-gray-600 hover:border-gray-300"
                    }`}
                  >
                    Ø{s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {kind === "material" && (
            <>
              <div>
                <label className="block text-sm font-medium mb-1">Material type</label>
                <div className="flex flex-wrap gap-2">
                  {MATERIAL_TYPES.map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMatType(m)}
                      className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                        matType === m
                          ? "border-sky-600 bg-sky-50 text-sky-700"
                          : "border-gray-200 text-gray-600 hover:border-gray-300"
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-sm font-medium mb-1">Color</label>
                  <input
                    type="color"
                    value={matColor}
                    onChange={(e) => setMatColor(e.target.value)}
                    className="h-9 w-full rounded-lg border border-gray-200 cursor-pointer"
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-sm font-medium mb-1">Color name</label>
                  <input
                    type="text"
                    placeholder="e.g. Bambu Green"
                    value={matColorName}
                    onChange={(e) => setMatColorName(e.target.value)}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                  />
                </div>
              </div>
            </>
          )}

          {kind === "bed_type" && (
            <div>
              <label className="block text-sm font-medium mb-1">Bed surface type</label>
              <div className="flex flex-wrap gap-2">
                {BED_TYPES.map((b) => (
                  <button
                    key={b}
                    type="button"
                    onClick={() => setBedType(b)}
                    className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                      bedType === b
                        ? "border-amber-600 bg-amber-50 text-amber-700"
                        : "border-gray-200 text-gray-600 hover:border-gray-300"
                    }`}
                  >
                    {b}
                  </button>
                ))}
              </div>
            </div>
          )}

          {kind === "custom" && (
            <>
              <div>
                <label className="block text-sm font-medium mb-1">Label</label>
                <input
                  type="text"
                  placeholder="e.g. maintenance, clogged, PEI sheet"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  required
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Badge color</label>
                <div className="flex gap-2 flex-wrap">
                  {BADGE_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setColor(c)}
                      className="h-6 w-6 rounded-full border-2 transition-transform hover:scale-110"
                      style={{
                        backgroundColor: c,
                        borderColor: color === c ? "#3b82f6" : "transparent",
                      }}
                    />
                  ))}
                </div>
              </div>
            </>
          )}

          {error && <p className="text-xs text-red-500">{error}</p>}

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-lg border border-gray-200 py-2 text-sm hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 rounded-lg bg-blue-600 py-2 text-sm text-white font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? "Creating..." : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
