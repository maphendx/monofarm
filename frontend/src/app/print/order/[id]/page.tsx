"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";

type OrderStatus = "new" | "confirmed" | "in_production" | "ready" | "shipped" | "cancelled";

type OrderItem = {
  id: number;
  product_id: number;
  product_name: string;
  quantity: number;
  unit_price: string;
  total_price: string;
  warehouse_id: number | null;
};

type Order = {
  id: number;
  order_number: string;
  counterparty_name: string | null;
  customer_name: string | null;
  source: string;
  status: OrderStatus;
  total_amount: string | null;
  paid_amount: string;
  outstanding: string;
  payment_status: "unpaid" | "partial" | "paid";
  due_date: string | null;
  notes: string | null;
  items: OrderItem[];
  created_at: string;
};

type OrgSettings = {
  id: number;
  name: string;
  slug: string;
};

const STATUS_LABELS: Record<OrderStatus, string> = {
  new: "Нове",
  confirmed: "Зарезервовано",
  in_production: "Виробництво",
  ready: "Готово",
  shipped: "Відправлено",
  cancelled: "Скасовано",
};

const PAYMENT_LABELS: Record<Order["payment_status"], string> = {
  unpaid: "Не оплачено",
  partial: "Частково оплачено",
  paid: "Оплачено",
};

const SOURCE_LABELS: Record<string, string> = {
  manual: "Ручне",
  etsy: "Etsy",
  shopify: "Shopify",
  keycrm: "KeyCRM",
  horoshop: "Хорошоп",
  api: "API",
};

function money(value: string | null | undefined) {
  if (value === null || value === undefined || value === "") return "0 ₴";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return `${value} ₴`;
  return `${parsed.toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₴`;
}

function shortMoney(value: string | null | undefined) {
  if (value === null || value === undefined || value === "") return "0 ₴";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return `${value} ₴`;
  return `${parsed.toLocaleString("uk-UA", { maximumFractionDigits: 2 })} ₴`;
}

function formatDate(value: string | null | undefined, withTime = false) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  });
}

function makeBarcodeSeed(value: string) {
  const source = value || "MONOFARM";
  return Array.from({ length: 42 }, (_, index) => {
    const code = source.charCodeAt(index % source.length);
    return 1 + ((code + index * 7) % 4);
  });
}

export default function OrderPrintPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [order, setOrder] = useState<Order | null>(null);
  const [org, setOrg] = useState<OrgSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const printedRef = useRef(false);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    Promise.all([
      api<Order>(`/api/warehouse/orders/${params.id}`, { signal: controller.signal }),
      api<OrgSettings>("/api/orgs/me", { signal: controller.signal }).catch(() => null),
    ])
      .then(([nextOrder, nextOrg]) => {
        if (!active) return;
        setOrder(nextOrder);
        setOrg(nextOrg);
      })
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof ApiError && err.status === 401) {
          setError("Потрібно увійти в monofarm, щоб переглянути накладну.");
        } else if (err instanceof DOMException && err.name === "AbortError") {
          setError("API monofarm не відповідає. Перевірте, чи запущений бекенд.");
        } else {
          setError(err instanceof Error ? err.message : "Не вдалося завантажити накладну.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [params.id]);

  const documentDate = useMemo(() => formatDate(order?.created_at, true), [order?.created_at]);
  const customerName = order?.counterparty_name ?? order?.customer_name ?? "Покупець";
  const totalQty = useMemo(() => order?.items.reduce((sum, item) => sum + item.quantity, 0) ?? 0, [order]);
  const barcode = useMemo(() => makeBarcodeSeed(order?.order_number ?? params.id), [order?.order_number, params.id]);

  useEffect(() => {
    if (!order || printedRef.current) return;
    const autoPrint = new URLSearchParams(window.location.search).get("auto") === "1";
    if (!autoPrint) return;
    printedRef.current = true;
    const timer = window.setTimeout(() => window.print(), 450);
    return () => window.clearTimeout(timer);
  }, [order]);

  if (loading) {
    return (
      <main className="min-h-screen bg-[#eef1f4] px-4 py-8 text-[#111827]">
        <div className="mx-auto w-full max-w-[210mm] rounded-lg bg-white px-8 py-10 shadow-sm">
          Завантажую накладну...
        </div>
      </main>
    );
  }

  if (error || !order) {
    return (
      <main className="min-h-screen bg-[#eef1f4] px-4 py-8 text-[#111827]">
        <div className="mx-auto w-full max-w-xl rounded-lg bg-white p-6 shadow-sm">
          <h1 className="text-xl font-semibold">Накладна недоступна</h1>
          <p className="mt-2 text-sm text-[#6b7280]">{error ?? "Замовлення не знайдено."}</p>
          <button
            type="button"
            onClick={() => router.back()}
            className="mt-5 rounded-md bg-[#111827] px-4 py-2 text-sm font-medium text-white"
          >
            Назад
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#eef1f4] px-4 py-6 text-[#111827] print:bg-white print:p-0">
      <div className="print-toolbar mx-auto mb-4 flex w-full max-w-[210mm] flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => router.back()}
          className="rounded-md border border-[#cbd5e1] bg-white px-4 py-2 text-sm font-medium text-[#374151] shadow-sm hover:bg-[#f8fafc]"
        >
          Назад
        </button>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => navigator.clipboard?.writeText(order.order_number)}
            className="rounded-md border border-[#cbd5e1] bg-white px-4 py-2 text-sm font-medium text-[#374151] shadow-sm hover:bg-[#f8fafc]"
          >
            Копіювати номер
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="rounded-md bg-[#111827] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[#0f172a]"
          >
            Друк
          </button>
        </div>
      </div>

      <section className="invoice-page mx-auto w-full max-w-[210mm] bg-white p-[12mm] shadow-xl print:shadow-none">
        <header className="grid grid-cols-[1fr_auto] gap-8 border-b-2 border-[#111827] pb-5">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#0e7490]">monofarm</div>
            <h1 className="mt-2 text-3xl font-bold tracking-normal text-[#111827]">Накладна</h1>
            <p className="mt-1 text-sm text-[#4b5563]">
              Замовлення {order.order_number} від {documentDate}
            </p>
          </div>
          <div className="text-right">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[#6b7280]">Документ</div>
            <div className="mt-1 font-mono text-xl font-bold text-[#111827]">{order.order_number}</div>
            <div className="mt-3 flex items-end justify-end gap-[2px]" aria-hidden="true">
              {barcode.map((height, index) => (
                <span
                  key={`${height}-${index}`}
                  className="inline-block w-[2px] bg-[#111827]"
                  style={{ height: `${14 + height * 5}px` }}
                />
              ))}
            </div>
          </div>
        </header>

        <section className="mt-6 grid grid-cols-2 gap-5">
          <div className="rounded-lg border border-[#d1d5db] p-4">
            <div className="text-[11px] font-bold uppercase tracking-wider text-[#6b7280]">Продавець</div>
            <div className="mt-2 text-base font-semibold">{org?.name ?? "monofarm"}</div>
            <div className="mt-1 text-sm text-[#4b5563]">CRM складів monofarm</div>
            {org?.slug && <div className="mt-1 text-xs text-[#6b7280]">Організація: {org.slug}</div>}
          </div>
          <div className="rounded-lg border border-[#d1d5db] p-4">
            <div className="text-[11px] font-bold uppercase tracking-wider text-[#6b7280]">Покупець</div>
            <div className="mt-2 text-base font-semibold">{customerName}</div>
            <div className="mt-1 text-sm text-[#4b5563]">Джерело: {SOURCE_LABELS[order.source] ?? order.source}</div>
            <div className="mt-1 text-xs text-[#6b7280]">Статус: {STATUS_LABELS[order.status]}</div>
          </div>
        </section>

        <section className="mt-5 grid grid-cols-4 gap-3">
          <div className="rounded-md bg-[#f3f4f6] px-3 py-2">
            <div className="text-[10px] font-bold uppercase tracking-wider text-[#6b7280]">Оплата</div>
            <div className="mt-1 text-sm font-semibold">{PAYMENT_LABELS[order.payment_status]}</div>
          </div>
          <div className="rounded-md bg-[#f3f4f6] px-3 py-2">
            <div className="text-[10px] font-bold uppercase tracking-wider text-[#6b7280]">До дати</div>
            <div className="mt-1 text-sm font-semibold">{formatDate(order.due_date)}</div>
          </div>
          <div className="rounded-md bg-[#f3f4f6] px-3 py-2">
            <div className="text-[10px] font-bold uppercase tracking-wider text-[#6b7280]">Позицій</div>
            <div className="mt-1 text-sm font-semibold">{order.items.length}</div>
          </div>
          <div className="rounded-md bg-[#f3f4f6] px-3 py-2">
            <div className="text-[10px] font-bold uppercase tracking-wider text-[#6b7280]">Кількість</div>
            <div className="mt-1 text-sm font-semibold">{totalQty} шт</div>
          </div>
        </section>

        <section className="mt-6 overflow-hidden rounded-lg border border-[#111827]">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-[#111827] text-left text-[11px] uppercase tracking-wider text-white">
                <th className="w-10 px-3 py-2 font-semibold">#</th>
                <th className="px-3 py-2 font-semibold">Товар</th>
                <th className="w-20 px-3 py-2 text-right font-semibold">К-сть</th>
                <th className="w-28 px-3 py-2 text-right font-semibold">Ціна</th>
                <th className="w-32 px-3 py-2 text-right font-semibold">Сума</th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((item, index) => (
                <tr key={item.id} className="border-b border-[#e5e7eb] last:border-0">
                  <td className="px-3 py-2 align-top text-[#6b7280]">{index + 1}</td>
                  <td className="px-3 py-2 align-top font-medium">{item.product_name}</td>
                  <td className="px-3 py-2 align-top text-right tabular-nums">{item.quantity}</td>
                  <td className="px-3 py-2 align-top text-right tabular-nums">{money(item.unit_price)}</td>
                  <td className="px-3 py-2 align-top text-right font-semibold tabular-nums">{money(item.total_price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="mt-5 grid grid-cols-[1fr_78mm] gap-6">
          <div className="rounded-lg border border-[#d1d5db] p-4">
            <div className="text-[11px] font-bold uppercase tracking-wider text-[#6b7280]">Коментар</div>
            <p className="mt-2 min-h-12 whitespace-pre-wrap text-sm leading-6 text-[#374151]">
              {order.notes || "Без коментарів"}
            </p>
          </div>
          <div className="rounded-lg border border-[#111827]">
            <div className="flex justify-between border-b border-[#d1d5db] px-4 py-2 text-sm">
              <span className="text-[#4b5563]">Разом</span>
              <span className="font-semibold tabular-nums">{money(order.total_amount)}</span>
            </div>
            <div className="flex justify-between border-b border-[#d1d5db] px-4 py-2 text-sm">
              <span className="text-[#4b5563]">Оплачено</span>
              <span className="font-semibold tabular-nums">{money(order.paid_amount)}</span>
            </div>
            <div className="flex justify-between bg-[#f3f4f6] px-4 py-3 text-base">
              <span className="font-bold">Борг</span>
              <span className="font-bold tabular-nums">{shortMoney(order.outstanding)}</span>
            </div>
          </div>
        </section>

        <footer className="mt-10 grid grid-cols-2 gap-12 text-sm">
          <div>
            <div className="h-10 border-b border-[#111827]" />
            <div className="mt-2 text-[#4b5563]">Відпустив</div>
          </div>
          <div>
            <div className="h-10 border-b border-[#111827]" />
            <div className="mt-2 text-[#4b5563]">Отримав</div>
          </div>
        </footer>
      </section>

      <style jsx global>{`
        @page {
          size: A4;
          margin: 0;
        }

        @media print {
          html,
          body {
            background: #fff !important;
          }

          .print-toolbar {
            display: none !important;
          }

          .invoice-page {
            width: 210mm !important;
            min-height: 297mm !important;
            max-width: none !important;
            margin: 0 !important;
            box-shadow: none !important;
            print-color-adjust: exact;
            -webkit-print-color-adjust: exact;
          }
        }
      `}</style>
    </main>
  );
}
