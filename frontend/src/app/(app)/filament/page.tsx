"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { LabelGeneratorModal } from "@/components/labels/LabelGeneratorModal";
import { Modal } from "@/components/Modal";
import { ApiError, api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useUser } from "@/lib/auth-context";
import type { Filament, FilamentColor } from "@/lib/types";

// ── constants ─────────────────────────────────────────────────────────────────

const FULL_SPOOL_G = 1000;

const MATERIALS = ["PLA", "PETG", "ABS", "ASA", "TPU", "PA", "PC", "HIPS", "PVA", "PP"];
const BRANDS = ["Bambu Lab", "eSun", "Polymaker", "Polydream", "Prusament", "Creality", "FormFutura", "Sunlu"];

// ── SVG spool ─────────────────────────────────────────────────────────────────

function SpoolSVG({ hexColor }: { hexColor: string | null }) {
  const color = hexColor || "#E8DBB7";
  return (
    <svg viewBox="0 0 260 345" className="w-full h-full" aria-hidden="true">
      <path fill={color} d="M69.12 7.12h120.01l39.53 40.48 10.65 58.64 12.96 53.46-4.61 54.95-10.95 62.89-30.99 43.47-27.99 8.89-18.22 4.81H60.15l-23.98-24.62-7.18-17.43-18.46-48.47-3.59-30-1.8-46.16 3.09-47.8 7.43-38.1 15.45-41.6 26.06-30.47 11.95-2.94z" />
      <path fill="#120e18" d="M252.09 101.68c-4.27-21.86-10.66-43.05-21.24-62.78-5.69-10.61-12.47-20.41-21.77-28.25-13.66-11.52-29.94-14.48-45.92-4.87a7.43 7.43 0 0 1-4.13.75q-30.18-.13-60.37-.24a8.51 8.51 0 0 1-4.26-1.15C81.47-2 68.67-1.65 56.08 6c-7.79 4.72-13.91 11.22-19.21 18.52-11.66 16.05-19 34.14-24.4 53.05C3 110.49-.6 144.15.08 178.34a356.46 356.46 0 0 0 7.29 66.26c4.26 20.22 10.32 39.85 20 58.21 6 11.44 13.25 22 23.43 30.21 13.86 11.22 29.7 12.8 44.18 4.3a11.3 11.3 0 0 1 6-1.65c18.37 0 36.75.05 55.13-.12a16.06 16.06 0 0 1 8.49 2.15c10.94 6.14 22.17 6.8 33.68 1.39 8.46-4 15.08-10.12 20.84-17.28 10.83-13.46 18-28.88 23.5-45.08 10.77-31.51 15.21-64 16.05-97v-.66q.07-3.34.12-6.7v-3.44a364.16 364.16 0 0 0-6.7-67.25ZM200.25 37a4.6 4.6 0 0 1 4 .87 3.41 3.41 0 0 1 .59.61 69.23 69.23 0 0 1 9.57 12.66A46.86 46.86 0 0 0 197 40.05a4.57 4.57 0 0 1 3.25-3.05Zm-11.79 266c-.8.07-1.62.09-2.43.09-13.68 0-26.38-8.61-36.86-23.3a160.8 160.8 0 0 1-8.55-22.31 3.93 3.93 0 0 1-.36-1.21 4.41 4.41 0 0 1 .88-3.34l.76-1c.9 2.17 1.83 4.3 2.8 6.36 11 23.42 25.68 36.31 41.3 36.31.8 0 1.6 0 2.39-.1Zm-32.19-132.24a252.15 252.15 0 0 0 1.28 25.76l-5.67 8a249 249 0 0 1 .06-68l5.68 7.7a253.8 253.8 0 0 0-1.35 26.54Zm1.77-25.9 1.9 2.56a4.63 4.63 0 0 1 .88 2.59l-.89 41.49a4.66 4.66 0 0 1-1 3l-1 1.41c-.8-8-1.22-16.41-1.22-25.16a254.83 254.83 0 0 1 1.29-25.89Zm-6.51-8.86a250.86 250.86 0 0 0-.06 69.09l-5.44 7.7a246.62 246.62 0 0 1 0-84.2l5.46 7.4ZM142 170.82a239.74 239.74 0 0 0 3.68 42.58l-5.25 7.44a237.6 237.6 0 0 1-5.11-50 237.9 237.9 0 0 1 5.1-49.95l5.29 7.18a239.48 239.48 0 0 0-3.71 42.75Zm-10.42 44.72q-.56-4.49-1-9.11c-1.05-11.28-1.61-23.1-1.61-35.28 0-12.59.59-24.8 1.72-36.41q1.2-8.33 2.93-16.12a3.94 3.94 0 0 1 1.1-.65 3.8 3.8 0 0 1 4.46 1.38l.82 1.11a238.58 238.58 0 0 0-5.18 50.48 238.48 238.48 0 0 0 5.2 50.54l-.88 1.24a3.77 3.77 0 0 1-4.44 1.27 4.13 4.13 0 0 1-1.75-1.4 4.34 4.34 0 0 1-.68-1.36 5 5 0 0 1-.19-1.35v-.11c-.21-1.46-.39-2.84-.55-4.23Zm-20-103.84a359 359 0 0 0 3.67 137.83c4.52 20.34 11.14 40 21.55 58.14a128.74 128.74 0 0 0 8.93 13.33 3.27 3.27 0 0 1-2.53-1.54c-8.07-8.25-14-17.94-19-28.26-9.17-19-14.75-39.07-18.4-59.74a344.17 344.17 0 0 1-4.8-78.3c1.66-31.74 6.86-62.79 19-92.39 5.37-13.12 12.08-25.47 21.74-36 1-1.11 2.13-2.11 3.2-3.17l.4-.38.54-.16-.15.5-.4.53c-19.57 26.73-28.43 57.57-33.75 89.61ZM188.37 294c-.8.07-1.59.11-2.39.11-17.45 0-33.13-16.54-43.75-42.66l4.78-6.12c.86 2.25 1.77 4.45 2.71 6.58 9.66 21.73 22.52 33.7 36.21 33.7a23 23 0 0 0 2.35-.12Zm-.09-9a23 23 0 0 1-2.35.12c-15.42 0-29.27-15.64-38.56-40.27l4.8-6.15c.82 2.36 1.68 4.64 2.6 6.84 8.29 20 19.34 31.08 31.12 31.08a17.76 17.76 0 0 0 2.3-.15Zm-.1-9a17.5 17.5 0 0 1-2.29.15c-13.39 0-25.38-14.75-33.36-37.91l4.84-6.2q1.14 3.71 2.45 7.14c6.92 18.36 16.17 28.47 26 28.47a14.25 14.25 0 0 0 2.26-.18Zm-.09-9a14 14 0 0 1-2.25.18c-11.33 0-21.46-13.88-28.11-35.6l4.89-6.28q1 3.93 2.24 7.53c5.57 16.67 13 25.85 20.94 25.85a10.22 10.22 0 0 0 2.2-.24Zm-.09-9a9.65 9.65 0 0 1-2.2.26c-9.24 0-17.49-13.06-22.82-33.37l2.05-2.63a4.39 4.39 0 0 1 3.21-1.68h.16q.71 3.09 1.51 5.94c4.2 15 9.82 23.25 15.84 23.25a6.5 6.5 0 0 0 2.16-.37Zm-.1-9.1a6.41 6.41 0 0 1-2.15.38c-6.79 0-12.86-11.18-16.87-28.69a4.35 4.35 0 0 1 2.73 1.29l5 5.11c2.58 8.95 5.72 13.78 9 13.78a3.9 3.9 0 0 0 2.11-.66Zm-.13-9.33a3.57 3.57 0 0 1-2.07.73c-3 0-5.89-4.5-8.34-12.59l9.19 9.32a4.31 4.31 0 0 1 1.22 2.52Zm-9.64-128.19c2.28-6.6 4.91-10.23 7.57-10.23a3 3 0 0 1 .72.09 4.43 4.43 0 0 1-1.26 3Zm7.57-10.71c-3 0-5.9 4-8.35 11.49l-7.13 7.23a4.11 4.11 0 0 1-1.18.86c4-17.13 10-28 16.71-28h.66v8.49a3.53 3.53 0 0 0-.71-.09Zm.05-8.92c-6 0-11.64 8.25-15.84 23.25-.5 1.75-1 3.58-1.4 5.46a4.16 4.16 0 0 1-1.4.24h-.34a4.38 4.38 0 0 1-3.22-1.81l-.83-1.15C168 96.8 176.4 83.29 185.8 83.29h.6v8.45q-.32-.01-.65-.01Zm.05-8.92c-7.94 0-15.37 9.18-20.94 25.85q-1.35 4.07-2.51 8.55l-4.8-6.65c6.65-22 16.86-36.19 28.29-36.19h.55v8.45Zm0-8.92c-9.85 0-19.1 10.11-26 28.47-.94 2.46-1.81 5-2.62 7.71l-4.73-6.54c8-23.26 20-38.09 33.42-38.09h.49v8.46Zm0-8.92c-11.78 0-22.83 11-31.12 31.08-.93 2.25-1.82 4.58-2.65 7l-4.67-6.46c9.3-24.51 23.1-40.06 38.48-40.06h.44V65Zm0-8.92c-13.69 0-26.55 12-36.21 33.69-.91 2.06-1.78 4.17-2.62 6.35l-4.63-6.41c10.74-25.8 26.32-42.1 43.66-42.1h.38v8.45Zm0-8.93c-15.62 0-30.29 12.9-41.3 36.32-.89 1.87-1.73 3.8-2.56 5.77l-.74-1a4.33 4.33 0 0 1-.79-3.43 3.56 3.56 0 0 1 .23-.72 158.36 158.36 0 0 1 8.87-22.75C160.07 47 172.58 38.68 186 38.68h.32v8.45Zm-5.17-16.43a4.28 4.28 0 0 1 1.23-.15 3.87 3.87 0 0 1 1.26.21 4.38 4.38 0 0 1 3 4.16v3.3H186c-12.6 0-24.65 7.13-35 20.46 8.4-16.16 18.67-26.32 29.81-28Zm-108.5 301.7c-4.53.1-10.25-2.38-10.74-2.6a52.88 52.88 0 0 1-13.11-11C37.67 307 30.86 293 25.39 278.26c-7.77-20.9-12.21-42.58-14.72-64.69a368.65 368.65 0 0 1-1.86-62.85c1.85-32.61 7.16-64.52 20-94.82 5.49-13.06 12.41-25.29 22.65-35.37a46.54 46.54 0 0 1 14.42-9.77h.06a29.9 29.9 0 0 1 9.57-1.47c-14.8 6.23-24.3 18.07-32.19 31.48-10.42 17.7-16.7 37-21.28 56.93a323.75 323.75 0 0 0-7.86 73c0 32.87 3.81 65.27 14 96.68 5.3 16.34 12.09 32 22.65 45.76 6.28 8.18 13.56 15.14 23 19.3a13.32 13.32 0 0 0-1.7-.03Zm10.75.93h-.08c-5.29-.34-9.8-2.65-14.17-5.34-9.33-5.86-16.11-14.19-21.94-23.35C37.42 290 31.51 274 26.87 257.5 20 233.13 16.72 208.24 15.88 183a333.34 333.34 0 0 1 4.81-71C24.88 89 31 66.6 42.12 45.85c5.69-10.61 12.51-20.39 22.06-28a40.24 40.24 0 0 1 18.53-8.63l.45-.07v.07c-.24.31-.31.5-.45.56-11 4.6-19 12.64-25.86 22.09-8.37 11.52-14.28 24.29-19 37.63C28.54 95.76 24 122.93 22.5 150.66a351.65 351.65 0 0 0 4.36 79.77c4.16 23.91 10.73 47.08 22.48 68.51 5.95 10.85 13.14 20.72 23.16 28.26 3.22 2.42 6.88 4 10.3 6.09h.12ZM70 323.21c-10.05-8.76-17.05-19.75-22.76-31.6-9-18.74-14.72-38.57-18.42-59a348.18 348.18 0 0 1-4.69-84.24C26 118.09 31.42 88.51 43 60.28c5-12.23 11.26-23.77 20-33.81 6.27-7.21 13.48-13.16 22.77-16.14a25.93 25.93 0 0 1 2.76-.7 3.1 3.1 0 0 1 .9.09c.12 1-.68.8-1.1 1-10.19 4.84-17.78 12.6-24.11 21.68-15.81 22.6-23.7 48.35-28.78 75.05-7.4 38.8-7.66 77.78-1.85 116.8 3.66 24.63 10 48.54 21.42 70.86 5.71 11.14 12.57 21.46 22.2 29.68a47.82 47.82 0 0 0 12.21 7.71c.54.23 1 .55 1.58.82-8.21-.97-15-4.83-21-10.11Zm17.8 6.84c-9.66-4.92-16.79-12.6-22.88-21.34C54.6 294 48 277.55 43 260.43c-6.16-21.06-9.5-42.61-11-64.48a346.17 346.17 0 0 1 3-77C39 92.57 45.76 67 58.87 43.49c5.56-10 12.26-19 21.39-26.12C85.91 13 92.9 9.82 98.48 9.27c0 .12 0 .31-.09.34C85.43 15.1 76.5 25 69.08 36.5 59.46 51.42 53.16 67.8 48.4 84.81a301.49 301.49 0 0 0-9.78 57 366.59 366.59 0 0 0-.35 53.64c2.17 32.69 8 64.58 22 94.55 5.81 12.52 13 24.15 23.29 33.54A50.44 50.44 0 0 0 96.09 332c.47.22 1.09.3 1.46 1.27a28.06 28.06 0 0 1-9.8-3.22Zm7.69 0c-10.32-5.3-17.75-13.66-24.07-23.12-10.64-15.93-17.21-33.63-22.16-52a299.72 299.72 0 0 1-9.14-55.22 361.3 361.3 0 0 1-.75-46.76c1.68-31.66 6.79-62.65 18.9-92.18C63 49.06 68.87 37.92 77 28.15c6.9-8.28 14.81-15.23 25.52-18.15 1-.28 2-.5 3-.72a2.6 2.6 0 0 1 .72 0c-.1.17-.15.35-.26.4C91.64 15.8 82.32 27.15 74.6 40.06 64 57.72 57.65 77 53.05 96.93a306.52 306.52 0 0 0-7.31 53.35C44 185 46.22 219.3 54.88 253c4.77 18.58 11.31 36.47 21.69 52.74 7.17 11.24 15.76 21.06 28.23 26.75.12.06.18.24.62.84a31.81 31.81 0 0 1-9.98-3.33Zm18.34 3.3h-.06c-5.31-.22-9.84-2.62-14.19-5.32-8.57-5.33-15-12.84-20.52-21.14-9.57-14.38-15.87-30.24-20.64-46.74-7.61-26.32-11-53.25-11.68-80.59-.75-30.32 2.1-60.25 9.64-89.65 4.62-18 11-35.39 20.89-51.25C82.95 29.6 89.6 21.38 98.64 15.4a34.44 34.44 0 0 1 14.6-5.95l.81-.1c0 .45-.34.32-.58.39C97.87 16.79 88.05 29.52 80.08 44c-10.43 18.9-16.66 39.3-20.89 60.36-6.23 30.94-7.64 62.17-5.36 93.61 2 27.86 7 55.11 17.17 81.24 5.23 13.42 11.73 26.15 21.07 37.25 5.72 6.81 12.31 12.53 20.57 16.12a6.35 6.35 0 0 1 1.08.75h.09Zm-10.1-7.82c-10.42-8-17.62-18.55-23.63-30-10-19-15.89-39.29-19.89-60.23a344.31 344.31 0 0 1-5.18-87c1.93-30.35 7.28-60 19-88.3 5.04-12.26 11.29-23.8 20.07-33.8 6.53-7.44 14-13.5 23.79-16.24 1.18-.33 2.38-.55 3.9-.89-.37.49-.43.67-.55.72C108 15.41 99.1 25.65 91.67 37.41c-11.33 18-18.12 37.79-22.9 58.33-7 30.05-9.22 60.53-7.86 91.32 1.17 26.7 5 53 13 78.51 5 16 11.55 31.36 21.4 45.1 6.89 9.6 15 17.77 26.2 22.38.13.05.2.22.52.59a39.07 39.07 0 0 1-18.35-8.12Zm19 6.3c-10-3.81-17.56-10.87-24-19.17-10.32-13.31-17-28.49-22.29-44.36-7.08-21.37-11-43.37-13-65.78a348.1 348.1 0 0 1-.88-51.26C64.45 119 69.89 87.42 82.78 57.5c5-11.62 11.15-22.6 19.7-32 7-7.77 15.12-14 25.7-16.13a2.07 2.07 0 0 1 1.26.09c-2.23 1.17-4.53 2.24-6.69 3.54-10.38 6.25-17.83 15.34-24 25.51-10.34 16.9-16.87 35.34-21.54 54.54-8.13 33.37-10.34 67.2-8.19 101.4 1.72 27.48 6.39 54.4 15.79 80.35 5.19 14.35 11.73 28.05 21.39 40 5.89 7.3 12.67 13.51 21.31 17.45.35.16.77.26.81.9a13.79 13.79 0 0 1-5.66-1.33Zm11.35 1.17c-8.15-2.07-14.83-6.63-20.72-12.45-10.26-10.17-17.21-22.47-22.91-35.55-8.69-19.95-13.81-40.91-17-62.37a346.48 346.48 0 0 1-3.33-69.17c1.76-33.1 7.21-65.46 20.46-96.11 5.78-13.4 13-25.89 23.74-36.07 6.14-5.84 13.1-10.2 21.52-11.92.38-.08.77-.12 1.15-.18a61.32 61.32 0 0 0-18.7 13.66C110.75 30.8 105 40 100.2 49.75c-10.5 21.3-16.38 44-20.14 67.32a320.2 320.2 0 0 0-4 46.58c-.5 36.09 3.22 71.63 14.7 106 4.92 14.79 11.27 28.92 20.51 41.59 6.47 8.89 14.07 16.51 24.27 21.13a3.31 3.31 0 0 1 .59.54c-.78.6-1.44.23-2.05.09Zm10.59.37c-2.92.14-5.53-1-8.11-2.11-10.4-4.45-18-12.25-24.42-21.24-10.61-14.78-17.38-31.39-22.5-48.71-6.68-22.65-10.17-45.84-11.52-69.4a339.11 339.11 0 0 1 6.29-89.74C88.8 81 95.25 60.6 106.16 41.84c5.65-9.73 12.37-18.59 21.57-25.29 4.91-3.55 10.27-6.33 16.36-7.16l.8-.1c0 .45-.34.32-.58.38-18.76 8.77-29.2 25-37.64 42.75-10.79 22.75-16.58 47-19.94 71.8a332.31 332.31 0 0 0-3 43.33c-.15 35.95 3.82 71.3 15.87 105.39 5.47 15.52 12.41 30.35 23.07 43.12 5.86 7 12.6 12.91 21.1 16.59a3.75 3.75 0 0 1 .87.64h.09Zm-12.23-9.5c-9-7.57-15.52-17.07-21-27.35-11.13-20.93-17.38-43.45-21.4-66.66a346.74 346.74 0 0 1-4.81-55.07c-.38-32.69 3.3-64.8 12.89-96.11 5.23-17.14 12.2-33.5 23.12-47.89 6.4-8.45 13.91-15.62 24-19.62 1.86-.74 3.73-1.62 6-1.42-.26.34-.36.58-.54.67-13.11 6.15-21.89 16.73-29.2 28.73-11.08 18.18-17.7 38.12-22.34 58.78-6.63 29.47-8.69 59.32-7.35 89.46 1.15 26 4.81 51.55 12.46 76.46 5.28 17.2 12.18 33.66 23 48.23 6.64 9 14.48 16.58 25 20.88a.73.73 0 0 1 .49.45c-7.84-.99-14.41-4.61-20.32-9.57Zm17.11 6.24c-9.06-4.6-15.91-11.67-21.77-19.78-10.54-14.54-17.33-30.89-22.41-48-10.44-35.14-13.63-71.11-12.1-107.6a303.61 303.61 0 0 1 11-70.93c5-17.6 11.7-34.5 22.2-49.65 5.49-7.95 11.92-15 20.32-20a35.71 35.71 0 0 1 9.48-4.07 4.45 4.45 0 0 1-2.3 2.51c-12.3 7.71-20.72 18.89-27.58 31.41-9.77 17.79-15.9 36.89-20.11 56.65a342.5 342.5 0 0 0-6.38 93.79c1.71 26.51 6 52.52 14.81 77.67 5.42 15.47 12.28 30.22 22.66 43.1a64.37 64.37 0 0 0 15.95 14.44 30.08 30.08 0 0 1 2.63 2 8.08 8.08 0 0 1 .85 1.14 29.85 29.85 0 0 1-7.25-2.71Zm36-18.58a3.82 3.82 0 0 1-.86.2 3.39 3.39 0 0 1-.55 0 3.6 3.6 0 0 1-.56 0c-12.44-.32-23.91-11.19-33.09-29.25C161 296.22 173.21 303.6 186 303.6c.82 0 1.63 0 2.44-.09v3.8a4.39 4.39 0 0 1-2.89 4.19Zm11.24-269.92a4.31 4.31 0 0 1 .11-1.08c6.58 2.25 12.82 6.52 18.57 12.47 5.76 10 10.79 22.66 14.83 37.34-1-2.37-2-4.67-3-6.9-8.4-17.87-18.93-29.61-30.39-34.17Zm.1 8.19c13.93 5.68 26.1 22 34.56 44.89l.48 1.31a4.85 4.85 0 0 1 .25 1.59 4.79 4.79 0 0 1-.68 2.4l-3.43 5.7a144.71 144.71 0 0 0-5.92-16c-7-15.74-15.68-26.36-25.14-31Zm.13 9.48c12.67 6.4 23.58 23.56 30.7 47l-4.7 7.83a144.22 144.22 0 0 0-6-18.06c-5.59-13.49-12.41-22.9-19.87-27.61Zm9.71 173.58a136.83 136.83 0 0 0 3.77-13.81l3.13-3.44a4.17 4.17 0 0 1 3.7-1.37 4 4 0 0 1 .84.21c-3.89 20.25-10.38 36.38-18.3 45.25l.2-11.84a74.54 74.54 0 0 0 6.66-15Zm-6.65 14 .25-14.81a5 5 0 0 1 1.26-3.26l8.25-9.06c-2.51 11.19-5.84 20.51-9.76 27.18ZM217.63 185l.75-29a5.59 5.59 0 0 1 .63-2.52l2.26-3.28c.54 6.63.83 13.51.83 20.57 0 7.28-.31 14.38-.89 21.2l-2.89-4a5.65 5.65 0 0 1-.69-2.97Zm-5.76 54.21a150.06 150.06 0 0 0 6.75-24.57 4.61 4.61 0 0 1 1.95 2l3.14 6.06c-5.25 22.43-13.79 39.76-24 48.08l.18-10.31c4.41-4.85 8.49-12 11.98-21.25Zm5.14 6.37a148.54 148.54 0 0 0 7.05-22.24l4.6 8.86c-6.64 23.48-17 41.15-29.15 48.79l.16-9.61c6.48-5.11 12.4-13.85 17.33-25.79Zm4.64-53c.61-7.07.92-14.37.92-21.8 0-7.22-.29-14.32-.87-21.2l5.88-8.55a247.35 247.35 0 0 1 1.77 29.79 246.42 246.42 0 0 1-1.8 30ZM197.15 69c10.68 7 19.75 23.54 25.51 45.67l-4.32 7.18a4.2 4.2 0 0 1-.59.78 145.62 145.62 0 0 0-5.88-20.3c-4.16-11-9.15-19.06-14.6-23.73Zm.13 10.25c8.53 7.56 15.66 23.33 20.05 43.77a4.41 4.41 0 0 1-2.32 1 4.19 4.19 0 0 1-.5 0 4.44 4.44 0 0 1-3.21-1.38l-1-1a133.2 133.2 0 0 0-3.59-13c-2.71-8.12-5.87-14.47-9.32-18.84Zm.15 11.32c4.95 6.55 9.19 17.14 12.24 30.39l-9.14-9.56a72.28 72.28 0 0 0-2.94-7.78Zm.2 16v-1.75c.77 1.79 1.5 3.75 2.2 5.86l-.88-.91a4.71 4.71 0 0 1-1.32-3.21Zm9.74 194.55a4.53 4.53 0 0 1-1.4 1.57 4.09 4.09 0 0 1-2.37.75 4.23 4.23 0 0 1-1-.11 4.5 4.5 0 0 1-3-2.57 49.42 49.42 0 0 0 15.58-11 75.26 75.26 0 0 1-7.81 11.35Zm8.88-13.12a50.55 50.55 0 0 1-16.78 12.3 5.24 5.24 0 0 1-.25-1.69l.12-7.2c10.5-5.18 20.14-16.49 27.94-33.08q1.53-3.24 2.93-6.68c-3.85 14.22-8.58 26.54-13.96 36.35Zm16.45-46.36a5 5 0 0 1-.37 1.61c-.33 1.43-.68 2.84-1 4.24-7.95 21.28-19.13 36.86-31.94 43.33l.15-9.22c8.5-5.21 16.27-15.3 22.65-29.65a146.16 146.16 0 0 0 6.81-19.09l3.15 6.08a5 5 0 0 1 .55 2.65Zm0-33.64-4.7-6.59a248.39 248.39 0 0 0 1.85-30.59 249.43 249.43 0 0 0-1.82-30.4l4.7-6.83a3.53 3.53 0 0 1 1-1.17 245.74 245.74 0 0 1 2.95 38.43 246.34 246.34 0 0 1-2.92 38.26 3.55 3.55 0 0 1-1.07-1.11Zm5.48-2.79a5.85 5.85 0 0 1 0 .73 4.48 4.48 0 0 1-2.07 3.39 2.13 2.13 0 0 1-1.92.06 247.76 247.76 0 0 0 2.93-38.52 247.8 247.8 0 0 0-3-38.73 2.17 2.17 0 0 1 2 0 4.23 4.23 0 0 1 2 3.24 5.29 5.29 0 0 1 .07.9v.05c.77 11.11 1.18 22.76 1.18 34.75-.06 11.75-.46 23.18-1.2 34.11Z" />
      <ellipse cx="189.44" cy="170.76" fill="#0f0f0f" rx="21.22" ry="46.9" />
    </svg>
  );
}

// ── FilamentCard (SimplyPrint style) ──────────────────────────────────────────

function FilamentCard({
  f, canEdit, isAdmin, selected, onSelect,
  onAdjust, onEdit, onDelete, onLabel,
}: {
  f: Filament; canEdit: boolean; isAdmin: boolean; selected: boolean;
  onSelect: () => void; onAdjust: () => void; onEdit: () => void;
  onDelete: () => void; onLabel: () => void;
}) {
  const pct = Math.min(100, Math.round((f.grams_remaining / FULL_SPOOL_G) * 100));
  const isLow = f.is_low;
  const barColor = isLow ? "#f59e0b" : pct < 20 ? "#f97316" : "#3b82f6";

  return (
    <div className={[
      "group flex flex-col rounded-xl border bg-[var(--bg-elevated)]  overflow-hidden transition hover:shadow-md cursor-pointer",
      selected
        ? "border-blue-500 ring-2 ring-blue-500/20"
        : isLow
          ? "border-amber-300 dark:border-amber-700"
          : "border-[var(--border)] ",
    ].join(" ")} onClick={onSelect}>

      {/* spool area */}
      <div className="relative flex items-center justify-center bg-[var(--bg)]  py-5 px-4">
        <div className="h-20 w-20">
          <SpoolSVG hexColor={f.hex_color ?? null} />
        </div>

        {/* selection checkbox */}
        <div
          className={[
            "absolute top-2 left-2 flex h-5 w-5 items-center justify-center rounded border transition",
            selected
              ? "border-blue-500 bg-blue-500 text-white"
              : "border-[var(--border-strong)] bg-[var(--bg-elevated)] opacity-0 group-hover:opacity-100  ",
          ].join(" ")}
          onClick={e => { e.stopPropagation(); onSelect(); }}
        >
          {selected && (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M1.5 5L4 7.5L8.5 2.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>

        {/* Spool ID badge */}
        {f.label_id && (
          <button
            type="button"
            onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(f.label_id!); }}
            title="Копіювати ID котушки"
            className="absolute top-2 right-2 rounded bg-[var(--surface-hi)]/80 px-1.5 py-0.5 text-[10px] font-mono font-bold tracking-widest text-[var(--text)] hover:bg-[var(--surface-hi)]   "
          >
            {f.label_id}
          </button>
        )}

        {/* low badge */}
        {isLow && (
          <span className="absolute bottom-2 left-2 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
            мало
          </span>
        )}
      </div>

      {/* info */}
      <div className="flex flex-col gap-2 p-3" onClick={e => e.stopPropagation()}>
        {/* color + brand */}
        <div>
          <div className="flex items-center gap-1.5">
            {f.hex_color && (
              <span
                className="inline-block h-3 w-3 shrink-0 rounded-full ring-1 ring-black/10"
                style={{ background: f.hex_color }}
              />
            )}
            <p className="truncate text-sm font-semibold">{f.color}</p>
          </div>
          <p className="mt-0.5 truncate text-xs text-[var(--text-muted)] ">
            {[f.brand, f.material].filter(Boolean).join(" · ")}
          </p>
        </div>

        {/* progress */}
        <div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-hi)] ">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${pct}%`, background: barColor }}
            />
          </div>
          <div className="mt-1 flex items-center justify-between text-[11px] text-[var(--text-muted)]">
            <span className="font-medium">{pct}% left</span>
            <span className="tabular-nums">{f.grams_remaining} / {FULL_SPOOL_G}g</span>
          </div>
        </div>

        {/* cost / note */}
        {(f.cost_per_kg != null || f.note) && (
          <p className="truncate text-[11px] text-[var(--text-faint)]">
            {f.cost_per_kg != null && `${f.cost_per_kg} грн/кг`}
            {f.cost_per_kg != null && f.note && " · "}
            {f.note}
          </p>
        )}

        {/* actions */}
        <div className="flex items-center gap-1 pt-0.5">
          {canEdit && (
            <button
              type="button"
              onClick={e => { e.stopPropagation(); onAdjust(); }}
              className="flex-1 rounded-md border border-[var(--border)] py-1.5 text-xs font-medium text-[var(--text)] hover:bg-[var(--surface-hi)]   "
            >
              ± Грами
            </button>
          )}
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onLabel(); }}
            className="rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)]  "
            title="Лейбл"
          >
            🏷
          </button>
          {canEdit && (
            <button
              type="button"
              onClick={e => { e.stopPropagation(); onEdit(); }}
              className="rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)]  "
              title="Редагувати"
            >
              ✎
            </button>
          )}
          {isAdmin && (
            <button
              type="button"
              onClick={e => { e.stopPropagation(); onDelete(); }}
              className="rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-red-600  "
              title="Видалити"
            >
              ✕
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── preset data ───────────────────────────────────────────────────────────────

const SPOOL_PRESETS = [250, 500, 750, 1000, 1200];

const PRESET_COLORS = [
  "#ffffff","#000000","#808080","#c0c0c0","#ff0000","#cc0000",
  "#ff4500","#ff6600","#ff8c00","#ffa500","#ffcc00","#ffff00",
  "#adff2f","#00cc44","#008000","#00fa9a","#00ced1","#00bfff",
  "#1e90ff","#4169e1","#0000cd","#6a0dad","#9370db","#da70d6",
  "#ff00ff","#ff69b4","#ffb6c1","#f5deb3","#daa520","#d2691e",
  "#a52a2a","#8b0000","#ffe4e1","#ffdab9","#b0e0e6","#e6e6fa",
];

// ── FilamentFormModal (SimplyPrint style) ─────────────────────────────────────

function FilamentFormModal({
  open, initial, onClose, onSaved,
}: {
  open: boolean; initial: Filament | null; onClose: () => void; onSaved: (f: Filament) => void;
}) {
  const [material, setMaterial] = useState("");
  const [color, setColor] = useState("");
  const [hexColor, setHexColor] = useState("");
  const [brand, setBrand] = useState("");
  const [gramsTotal, setGramsTotal] = useState(1000);
  const [amountMode, setAmountMode] = useState<"gram" | "pct">("pct");
  const [amountInput, setAmountInput] = useState("100");
  const [minGrams, setMinGrams] = useState("100");
  const [costPerKg, setCostPerKg] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const gramsRemaining = amountMode === "pct"
    ? Math.round(gramsTotal * Math.min(100, Math.max(0, parseFloat(amountInput) || 0)) / 100)
    : Math.min(gramsTotal, Math.max(0, parseInt(amountInput) || 0));

  const pct = Math.min(100, Math.round((gramsRemaining / gramsTotal) * 100));

  useEffect(() => {
    if (!open) return;
    setMaterial(initial?.material ?? "");
    setColor(initial?.color ?? "");
    setHexColor(initial?.hex_color ?? "");
    setBrand(initial?.brand ?? "");
    const gr = initial?.grams_remaining ?? 1000;
    const gt = SPOOL_PRESETS.includes(gr) ? gr : 1000;
    setGramsTotal(gt);
    setAmountMode("gram");
    setAmountInput(String(gr));
    setMinGrams(String(initial?.min_grams ?? 100));
    setCostPerKg(initial?.cost_per_kg != null ? String(initial.cost_per_kg) : "");
    setNote(initial?.note ?? "");
    setError(null);
  }, [open, initial]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!color.trim() || !material.trim()) return;
    setBusy(true); setError(null);
    try {
      const body = {
        material: material.trim(),
        color: color.trim(),
        hex_color: hexColor.trim() || null,
        brand: brand.trim() || null,
        grams_remaining: gramsRemaining,
        min_grams: parseInt(minGrams) || 0,
        cost_per_kg: costPerKg.trim() ? parseInt(costPerKg) : null,
        note: note.trim() || null,
      };
      const saved = initial
        ? await api<Filament>(`/api/filaments/${initial.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : await api<Filament>("/api/filaments", { method: "POST", body: JSON.stringify(body) });
      onSaved(saved); onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка");
    } finally { setBusy(false); }
  }

  const inp = "w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-sm outline-none focus:border-neutral-500  ";

  return (
    <Modal open={open} onClose={() => { if (!busy) onClose(); }} size="2xl"
      title={initial ? "Редагувати котушку" : "Нова котушка"}
      footer={<>
        <button type="button" onClick={onClose} disabled={busy}
          className="rounded-md px-3 py-1.5 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)]  ">
          Скасувати
        </button>
        <button type="submit" form="filament-form" disabled={busy || !material.trim() || !color.trim()}
          className="rounded-md bg-[var(--surface)] px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50  ">
          {busy ? "Зберігаю…" : initial ? "Зберегти" : "Створити котушку"}
        </button>
      </>}>
      <form id="filament-form" onSubmit={submit}>
        <div className="grid grid-cols-2 gap-x-6 gap-y-0">

          {/* ── LEFT COLUMN ── */}
          <div className="space-y-3 text-sm">

            {/* brand */}
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Виробник пластику</span>
              <input type="text" autoFocus value={brand} onChange={e => setBrand(e.target.value)}
                list="brand-presets-f" placeholder="Bambu Lab, eSun, Polymaker…" className={inp} />
              <datalist id="brand-presets-f">{BRANDS.map(b => <option key={b} value={b} />)}</datalist>
            </label>

            {/* material + cost row */}
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Матеріал *</span>
                <input type="text" required value={material} onChange={e => setMaterial(e.target.value)}
                  list="material-presets-f" placeholder="PLA" className={inp} />
                <datalist id="material-presets-f">{MATERIALS.map(m => <option key={m} value={m} />)}</datalist>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Ціна (грн/кг)</span>
                <input type="number" min={0} value={costPerKg} onChange={e => setCostPerKg(e.target.value)}
                  placeholder="800" className={inp} />
              </label>
            </div>

            {/* spool size visual picker */}
            <div>
              <span className="mb-2 block text-xs font-medium text-[var(--text-muted)]">Розмір котушки</span>
              <div className="flex items-end gap-2">
                {SPOOL_PRESETS.map(g => (
                  <button key={g} type="button" onClick={() => setGramsTotal(g)}
                    className={[
                      "flex flex-col items-center gap-1 rounded-lg border px-1.5 py-1.5 transition",
                      gramsTotal === g
                        ? "border-neutral-900 bg-[var(--bg)]  "
                        : "border-[var(--border)] hover:border-neutral-400  dark:hover:border-neutral-500",
                    ].join(" ")}>
                    <div style={{ width: `${20 + (g / 1200) * 16}px`, height: `${20 + (g / 1200) * 16}px` }}>
                      <SpoolSVG hexColor={hexColor || "#9ca3af"} />
                    </div>
                    <span className="text-[10px] font-medium tabular-nums text-[var(--text-muted)] ">
                      {g >= 1000 ? `${(g / 1000).toLocaleString()}kg` : `${g}g`}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* how much is left */}
            <div>
              <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Скільки залишилось?</span>
              <div className="flex items-center gap-2">
                <input
                  type="number" min={0} max={amountMode === "pct" ? 100 : gramsTotal}
                  value={amountInput} onChange={e => setAmountInput(e.target.value)}
                  className={`flex-1 ${inp}`}
                />
                <div className="flex rounded-md border border-[var(--border-strong)]  overflow-hidden text-xs">
                  {(["gram", "pct"] as const).map(m => (
                    <button key={m} type="button" onClick={() => {
                      if (m === amountMode) return;
                      setAmountMode(m);
                      setAmountInput(m === "pct" ? String(pct) : String(gramsRemaining));
                    }}
                      className={[
                        "px-2.5 py-1.5 font-medium transition",
                        amountMode === m
                          ? "bg-[var(--surface)] text-white  "
                          : "text-[var(--text-muted)] hover:bg-[var(--surface-hi)] ",
                      ].join(" ")}>
                      {m === "gram" ? "г" : "%"}
                    </button>
                  ))}
                </div>
              </div>
              <p className="mt-1 text-[11px] text-[var(--text-faint)]">
                {gramsRemaining} г · {pct}%
              </p>
            </div>

            {/* low threshold */}
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Поріг «мало» (г)</span>
              <input type="number" min={0} value={minGrams} onChange={e => setMinGrams(e.target.value)} className={inp} />
            </label>
          </div>

          {/* ── RIGHT COLUMN ── */}
          <div className="space-y-3 text-sm">

            {/* color grid */}
            <div>
              <span className="mb-2 block text-xs font-medium text-[var(--text-muted)]">Колір</span>
              <div className="grid grid-cols-9 gap-1">
                {PRESET_COLORS.map(c => (
                  <button key={c} type="button" onClick={() => setHexColor(c)}
                    className={[
                      "h-6 w-6 rounded transition ring-offset-1",
                      hexColor.toLowerCase() === c.toLowerCase()
                        ? "ring-2 ring-neutral-900 "
                        : "hover:scale-110",
                    ].join(" ")}
                    style={{ background: c, border: c === "#ffffff" ? "1px solid #e5e7eb" : undefined }}
                    title={c}
                  />
                ))}
              </div>
            </div>

            {/* color name + hex */}
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Назва кольору *</span>
                <input type="text" required value={color} onChange={e => setColor(e.target.value)}
                  placeholder="Чорний" className={inp} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">HEX код</span>
                <div className="flex gap-1.5">
                  <input type="color" value={hexColor || "#000000"} onChange={e => setHexColor(e.target.value)}
                    className="h-[34px] w-9 shrink-0 cursor-pointer rounded border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-0.5  " />
                  <input type="text" value={hexColor} onChange={e => setHexColor(e.target.value)}
                    placeholder="#000000" maxLength={7} className={`flex-1 font-mono ${inp}`} />
                </div>
              </label>
            </div>

            {/* live spool preview */}
            <div className="flex items-center gap-3 rounded-lg bg-[var(--bg)] px-3 py-2.5 ">
              <div className="h-12 w-12 shrink-0">
                <SpoolSVG hexColor={hexColor || null} />
              </div>
              <div>
                <p className="text-sm font-medium">{color || "Назва кольору"}</p>
                <p className="text-xs text-[var(--text-faint)]">{[brand, material].filter(Boolean).join(" · ") || "Виробник · Матеріал"}</p>
                <p className="mt-0.5 text-xs font-medium tabular-nums text-[var(--text-muted)]">{gramsRemaining} / {gramsTotal} г</p>
              </div>
            </div>

            {/* note */}
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Нотатка</span>
              <textarea value={note} onChange={e => setNote(e.target.value)} rows={2}
                placeholder="Опціонально…"
                className={`${inp} resize-none`} />
            </label>
          </div>
        </div>

        {error && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p>}
      </form>
    </Modal>
  );
}

// ── AdjustModal ───────────────────────────────────────────────────────────────

function AdjustModal({
  filament, onClose, onSaved,
}: {
  filament: Filament | null; onClose: () => void; onSaved: (f: Filament) => void;
}) {
  const [delta, setDelta] = useState("");
  const [direction, setDirection] = useState<"add" | "consume">("consume");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (filament) { setDelta(""); setDirection("consume"); setReason(""); setError(null); }
  }, [filament]);

  if (!filament) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const grams = parseInt(delta);
      if (!grams || grams <= 0) throw new ApiError(400, "Введи позитивне число");
      const signed = direction === "add" ? grams : -grams;
      const saved = await api<Filament>(`/api/filaments/${filament!.id}/adjust`, {
        method: "POST",
        body: JSON.stringify({ delta_grams: signed, reason: reason.trim() || null }),
      });
      onSaved(saved); onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка");
    } finally { setBusy(false); }
  }

  const previewGrams = filament.grams_remaining + (direction === "add" ? 1 : -1) * (parseInt(delta) || 0);
  const previewPct = Math.min(100, Math.round((Math.max(0, previewGrams) / FULL_SPOOL_G) * 100));
  const inputCls = "w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-sm outline-none focus:border-neutral-900  ";

  return (
    <Modal open={!!filament} onClose={() => { if (!busy) onClose(); }}
      title={`${filament.material} · ${filament.color}`}
      footer={<>
        <button type="button" onClick={onClose} disabled={busy}
          className="rounded-md px-3 py-1.5 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)]  ">
          Скасувати
        </button>
        <button type="submit" form="adjust-form" disabled={busy || !delta}
          className="rounded-md bg-[var(--surface)] px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50  ">
          {busy ? "Зберігаю…" : "Застосувати"}
        </button>
      </>}>
      <form id="adjust-form" onSubmit={submit} className="space-y-3 text-sm">
        <div className="flex items-center gap-4 rounded-lg bg-[var(--bg)] px-4 py-3 ">
          <div className="h-12 w-12 shrink-0">
            <SpoolSVG hexColor={filament.hex_color ?? null} />
          </div>
          <div>
            <div className="text-xs text-[var(--text-muted)]">{delta ? "Стане" : "Зараз на котушці"}</div>
            <div className="mt-0.5 text-xl font-semibold tabular-nums">
              {delta ? Math.max(0, previewGrams) : filament.grams_remaining} г
              {delta && previewGrams < 0 && (
                <span className="ml-2 text-sm font-normal text-red-500">не вистачає!</span>
              )}
            </div>
            {filament.sku && <div className="mt-0.5 font-mono text-[10px] text-[var(--text-faint)]">{filament.sku}</div>}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {(["consume", "add"] as const).map(d => (
            <button key={d} type="button" onClick={() => setDirection(d)}
              className={["rounded-lg border py-2.5 text-sm font-medium transition", direction === d
                ? d === "consume"
                  ? "border-red-300 bg-red-50 text-red-700 dark:border-red-700 dark:bg-red-950/30 dark:text-red-300"
                  : "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300"
                : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--surface-hi)]   ",
              ].join(" ")}>
              {d === "consume" ? "− Списати" : "+ Надійшло"}
            </button>
          ))}
        </div>
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--text-muted)]">Грами</span>
          <input type="number" required min={1} autoFocus value={delta} onChange={e => setDelta(e.target.value)}
            placeholder="напр. 250" className={inputCls} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--text-muted)]">Причина (необов'язково)</span>
          <input type="text" value={reason} onChange={e => setReason(e.target.value)}
            placeholder="Нова котушка, витрата на замовлення #12…" className={inputCls} />
        </label>
        {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      </form>
    </Modal>
  );
}

// ── FilamentColorsSection ─────────────────────────────────────────────────────

function FilamentColorsSection({ canEdit }: { canEdit: boolean }) {
  const [colors, setColors] = useState<FilamentColor[]>([]);
  const [loading, setLoading] = useState(true);
  const [editColor, setEditColor] = useState<FilamentColor | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState("");
  const [hex, setHex] = useState("#ffffff");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setColors(await api<FilamentColor[]>("/api/filament-colors")); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  function openAdd() { setName(""); setHex("#3b82f6"); setEditColor(null); setError(null); setAddOpen(true); }
  function openEdit(c: FilamentColor) { setName(c.name); setHex(c.hex_color); setEditColor(c); setError(null); setAddOpen(true); }

  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      if (editColor) {
        const updated = await api<FilamentColor>(`/api/filament-colors/${editColor.id}`, { method: "PATCH", body: JSON.stringify({ name: name.trim(), hex_color: hex }) });
        setColors(prev => prev.map(c => c.id === updated.id ? updated : c));
      } else {
        const created = await api<FilamentColor>("/api/filament-colors", { method: "POST", body: JSON.stringify({ name: name.trim(), hex_color: hex }) });
        setColors(prev => [...prev, created]);
      }
      setAddOpen(false);
    } catch (err) { setError(err instanceof ApiError ? err.message : "Помилка"); }
    finally { setBusy(false); }
  }

  async function remove(c: FilamentColor) {
    if (!confirm(`Видалити колір "${c.name}"?`)) return;
    await api(`/api/filament-colors/${c.id}`, { method: "DELETE" });
    setColors(prev => prev.filter(x => x.id !== c.id));
  }

  const inputCls = "w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-sm outline-none focus:border-neutral-900  ";

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-[var(--text)] ">Каталог кольорів</h2>
        {canEdit && (
          <button onClick={openAdd}
            className="rounded-md border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)]   ">
            + Колір
          </button>
        )}
      </div>
      {loading ? <p className="text-xs text-[var(--text-faint)]">Завантаження…</p>
        : colors.length === 0 ? <p className="text-xs text-[var(--text-faint)]">Каталог порожній</p>
        : (
          <div className="flex flex-wrap gap-1.5">
            {colors.map(c => (
              <div key={c.id}
                className="group flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1  ">
                <span className="h-3 w-3 shrink-0 rounded-full border border-black/10" style={{ background: c.hex_color }} />
                <span className="text-xs">{c.name}</span>
                {canEdit && (
                  <div className="ml-0.5 hidden gap-0.5 group-hover:flex">
                    <button onClick={() => openEdit(c)} className="text-[10px] text-[var(--text-faint)] hover:text-[var(--text)] ">✎</button>
                    <button onClick={() => remove(c)} className="text-[10px] text-[var(--text-faint)] hover:text-red-600">✕</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      <Modal open={addOpen} onClose={() => { if (!busy) setAddOpen(false); }}
        title={editColor ? "Редагувати колір" : "Новий колір"}
        footer={<>
          <button type="button" onClick={() => setAddOpen(false)} disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)]  ">Скасувати</button>
          <button type="submit" form="color-form" disabled={busy || !name.trim()}
            className="rounded-md bg-[var(--surface)] px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50  ">
            {busy ? "Зберігаю…" : "Зберегти"}
          </button>
        </>}>
        <form id="color-form" onSubmit={save} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs text-[var(--text-muted)]">Назва</span>
            <input type="text" required autoFocus value={name} onChange={e => setName(e.target.value)}
              placeholder="Чорний, Galaxy Black…" className={inputCls} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-[var(--text-muted)]">Колір</span>
            <div className="flex items-center gap-3">
              <input type="color" value={hex} onChange={e => setHex(e.target.value)}
                className="h-10 w-14 cursor-pointer rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-1  " />
              <input type="text" value={hex} onChange={e => setHex(e.target.value)}
                pattern="^#[0-9a-fA-F]{6}$" className="w-28 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 font-mono text-sm outline-none focus:border-neutral-900  " />
            </div>
          </label>
          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
        </form>
      </Modal>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function FilamentPage() {
  const t = useT();
  const me = useUser();
  const isAdmin = me.role === "admin";
  const canEdit = isAdmin || me.role === "operator";

  const [filaments, setFilaments] = useState<Filament[]>([]);
  const [loading, setLoading] = useState(true);
  const [editFilament, setEditFilament] = useState<Filament | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [adjustFilament, setAdjustFilament] = useState<Filament | null>(null);
  const [labelFilaments, setLabelFilaments] = useState<Filament[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try { setFilaments(await api<Filament[]>("/api/filaments")); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  function upsert(f: Filament) {
    setFilaments(prev => {
      const idx = prev.findIndex(x => x.id === f.id);
      if (idx === -1) return [...prev, f];
      const copy = [...prev]; copy[idx] = f; return copy;
    });
  }

  async function remove(f: Filament) {
    if (!confirm(`Видалити ${f.material} · ${f.color}?`)) return;
    await api(`/api/filaments/${f.id}`, { method: "DELETE" });
    setFilaments(prev => prev.filter(x => x.id !== f.id));
    setSelected(prev => { const s = new Set(prev); s.delete(f.id); return s; });
  }

  function toggleSelect(id: number) {
    setSelected(prev => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id); else s.add(id);
      return s;
    });
  }

  const stats = useMemo(() => ({
    total: filaments.length,
    totalGrams: filaments.reduce((s, f) => s + f.grams_remaining, 0),
    low: filaments.filter(f => f.is_low).length,
  }), [filaments]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return filaments;
    return filaments.filter(f =>
      f.material.toLowerCase().includes(q) ||
      f.color.toLowerCase().includes(q) ||
      (f.brand ?? "").toLowerCase().includes(q) ||
      (f.sku ?? "").toLowerCase().includes(q) ||
      (f.label_id ?? "").toLowerCase().includes(q),
    );
  }, [filaments, search]);

  const grouped = useMemo(() => {
    const map = new Map<string, Filament[]>();
    for (const f of filtered) {
      const key = f.material.toUpperCase();
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(f);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  const selectedFilaments = useMemo(
    () => filaments.filter(f => selected.has(f.id)),
    [filaments, selected],
  );

  if (loading) return <div className="text-sm text-[var(--text-muted)]">{t("common.loading")}</div>;

  return (
    <div className="space-y-6">
      {/* header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">{t("filament.title")}</h1>
          {stats.low > 0 && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
              ⚠ {stats.low} мало
            </span>
          )}
        </div>
        {canEdit && (
          <button onClick={() => { setEditFilament(null); setEditOpen(true); }}
            className="rounded-md bg-[var(--surface)] px-3 py-1.5 text-sm text-white hover:bg-neutral-700  ">
            + Котушка
          </button>
        )}
      </div>

      {/* stats */}
      {filaments.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Котушок", value: stats.total },
            { label: "Всього грам", value: `${stats.totalGrams.toLocaleString()} г` },
            { label: "Мало залишку", value: stats.low, warn: stats.low > 0 },
          ].map(({ label, value, warn }) => (
            <div key={label} className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-3  ">
              <div className="text-xs text-[var(--text-muted)]">{label}</div>
              <div className={["mt-0.5 text-xl font-semibold tabular-nums", warn ? "text-amber-600 dark:text-amber-400" : ""].join(" ")}>
                {value}
              </div>
            </div>
          ))}
        </div>
      )}

      {filaments.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border-strong)] px-4 py-16 text-center text-sm text-[var(--text-faint)] ">
          Немає котушок — натисни + Котушка
        </div>
      ) : (
        <>
          <input type="search" placeholder="Пошук за матеріалом, кольором, SKU…"
            value={search} onChange={e => setSearch(e.target.value)}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-sm outline-none focus:border-neutral-400  " />

          {grouped.length === 0 ? (
            <p className="text-sm text-[var(--text-faint)]">Нічого не знайдено</p>
          ) : (
            <div className="space-y-6">
              {grouped.map(([material, spools]) => (
                <div key={material}>
                  <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-[var(--text-faint)]">{material}</h2>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                    {spools.map(f => (
                      <FilamentCard
                        key={f.id}
                        f={f}
                        canEdit={canEdit}
                        isAdmin={isAdmin}
                        selected={selected.has(f.id)}
                        onSelect={() => toggleSelect(f.id)}
                        onAdjust={() => setAdjustFilament(f)}
                        onEdit={() => { setEditFilament(f); setEditOpen(true); }}
                        onDelete={() => remove(f)}
                        onLabel={() => setLabelFilaments([f])}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <FilamentFormModal open={editOpen} initial={editFilament}
        onClose={() => setEditOpen(false)} onSaved={upsert} />
      <AdjustModal filament={adjustFilament}
        onClose={() => setAdjustFilament(null)} onSaved={upsert} />
      {labelFilaments && (
        <LabelGeneratorModal filaments={labelFilaments} onClose={() => setLabelFilaments(null)} />
      )}

      {filaments.length > 0 && (
        <div className="border-t border-[var(--border)] pt-6 ">
          <FilamentColorsSection canEdit={canEdit} />
        </div>
      )}

      {/* bulk action bar */}
      {selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2">
          <div className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-2.5 shadow-xl  ">
            <span className="text-sm text-[var(--text-muted)] ">
              Виділено {selected.size}
            </span>
            <button
              type="button"
              onClick={() => setLabelFilaments(selectedFilaments)}
              className="rounded-md bg-[var(--surface)] px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700  "
            >
              🏷 Генерувати лейбли
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="rounded-md px-2.5 py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)] "
            >
              Скасувати
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
