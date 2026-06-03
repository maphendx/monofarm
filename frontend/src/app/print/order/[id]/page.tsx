"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";

type OrderStatus = "new" | "confirmed" | "in_production" | "ready" | "shipped" | "cancelled";

type OrderItem = {
  id: number;
  product_id: number;
  product_name: string;
  product_sku: string | null;
  image_url: string | null;
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
  customer_phone: string | null;
  customer_email: string | null;
  delivery_city: string | null;
  delivery_service: string | null;
  delivery_address: string | null;
  payment_method: string | null;
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

function shortMoney(value: string | null | undefined) {
  if (value === null || value === undefined || value === "") return "0 ₴";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return `${value} ₴`;
  return `${parsed.toLocaleString("uk-UA", { maximumFractionDigits: 2 })} ₴`;
}

function moneyPlain(value: string | null | undefined) {
  if (value === null || value === undefined || value === "") return "0.00";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return parsed.toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

function plural(value: number, one: string, few: string, many: string) {
  const mod10 = value % 10;
  const mod100 = value % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function threeDigitsToWords(value: number, feminine = false) {
  const hundreds = ["", "сто", "двісті", "триста", "чотириста", "п'ятсот", "шістсот", "сімсот", "вісімсот", "дев'ятсот"];
  const teens = ["десять", "одинадцять", "дванадцять", "тринадцять", "чотирнадцять", "п'ятнадцять", "шістнадцять", "сімнадцять", "вісімнадцять", "дев'ятнадцять"];
  const tens = ["", "", "двадцять", "тридцять", "сорок", "п'ятдесят", "шістдесят", "сімдесят", "вісімдесят", "дев'яносто"];
  const ones = feminine
    ? ["", "одна", "дві", "три", "чотири", "п'ять", "шість", "сім", "вісім", "дев'ять"]
    : ["", "один", "два", "три", "чотири", "п'ять", "шість", "сім", "вісім", "дев'ять"];

  const parts: string[] = [];
  const h = Math.floor(value / 100);
  const t = Math.floor((value % 100) / 10);
  const o = value % 10;
  if (h) parts.push(hundreds[h]);
  if (t === 1) parts.push(teens[o]);
  else {
    if (t) parts.push(tens[t]);
    if (o) parts.push(ones[o]);
  }
  return parts.join(" ");
}

function amountInWords(value: string | null | undefined) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) return "";
  const hryvnia = Math.floor(amount);
  const kopiykas = Math.round((amount - hryvnia) * 100);
  const thousands = Math.floor(hryvnia / 1000);
  const remainder = hryvnia % 1000;
  const parts: string[] = [];
  if (thousands) {
    parts.push(threeDigitsToWords(thousands, true));
    parts.push(plural(thousands, "тисяча", "тисячі", "тисяч"));
  }
  if (remainder) parts.push(threeDigitsToWords(remainder, false));
  if (!parts.length) parts.push("нуль");
  const text = parts.join(" ");
  const currency = plural(hryvnia, "грн", "грн", "грн");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)} ${currency} ${String(kopiykas).padStart(2, "0")} коп.`;
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

  const orderNumber = order?.order_number ?? params.id;
  const documentDate = formatDate(order?.created_at, true);
  const invoiceDate = formatDate(order?.created_at);
  const invoiceDigits = order?.order_number.replace(/\D/g, "");
  const invoiceNumber = invoiceDigits || orderNumber;
  const customerName = order?.counterparty_name ?? order?.customer_name ?? "Покупець";
  const totalQty = order?.items.reduce((sum, item) => sum + item.quantity, 0) ?? 0;
  const barcode = makeBarcodeSeed(orderNumber);
  const payableWords = amountInWords(order?.outstanding);
  const deliveryLines = [
    order?.delivery_city,
    order?.delivery_service,
    order?.delivery_address,
  ].filter((line): line is string => Boolean(line));
  const paymentText = order ? order.payment_method || PAYMENT_LABELS[order.payment_status] : "-";

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

        <section className="mt-6 grid grid-cols-[1fr_58mm] gap-8">
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-[32mm_1fr] gap-3">
              <div className="font-bold text-[#4b5563]">Постачальник</div>
              <div>
                <div className="font-semibold">{org?.name ?? "monofarm"}</div>
                <div className="text-[#6b7280]">CRM складів monofarm</div>
              </div>
            </div>
            <div className="grid grid-cols-[32mm_1fr] gap-3">
              <div className="font-bold text-[#4b5563]">Одержувач</div>
              <div>
                <div className="font-semibold">{customerName}</div>
                {order.customer_phone && <div>{order.customer_phone}</div>}
                {order.customer_email && <div>{order.customer_email}</div>}
              </div>
            </div>
            <div className="grid grid-cols-[32mm_1fr] gap-3">
              <div className="font-bold text-[#4b5563]">Доставка</div>
              <div className="space-y-0.5">
                {deliveryLines.length > 0 ? deliveryLines.map((line) => <div key={line}>{line}</div>) : <div>-</div>}
              </div>
            </div>
            <div className="grid grid-cols-[32mm_1fr] gap-3">
              <div className="font-bold text-[#4b5563]">Оплата</div>
              <div>{paymentText}</div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold">Рахунок №{invoiceNumber}</div>
            <div className="mt-1 text-sm text-[#4b5563]">від {invoiceDate}</div>
            <div className="mt-4 rounded-md bg-[#f3f4f6] px-3 py-2 text-left text-xs text-[#4b5563]">
              <div>Джерело: {SOURCE_LABELS[order.source] ?? order.source}</div>
              <div>Статус: {STATUS_LABELS[order.status]}</div>
              <div>Позицій: {order.items.length}</div>
              <div>Кількість: {totalQty} шт</div>
            </div>
          </div>
        </section>

        <section className="mt-6 overflow-hidden rounded-lg border border-[#111827]">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-[#111827] text-left text-[11px] uppercase tracking-wider text-white">
                <th className="w-10 px-3 py-2 font-semibold">№</th>
                <th className="w-16 px-3 py-2 font-semibold">Фото</th>
                <th className="px-3 py-2 font-semibold">Товар</th>
                <th className="w-20 px-3 py-2 text-right font-semibold">Кіл-ть</th>
                <th className="w-14 px-3 py-2 text-right font-semibold">Од.</th>
                <th className="w-28 px-3 py-2 text-right font-semibold">Ціна, грн</th>
                <th className="w-32 px-3 py-2 text-right font-semibold">Сума, грн</th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((item, index) => (
                <tr key={item.id} className="border-b border-[#e5e7eb] last:border-0">
                  <td className="px-3 py-2 align-top text-[#6b7280]">{index + 1}</td>
                  <td className="px-3 py-2 align-top">
                    {item.image_url ? (
                      <img
                        src={item.image_url}
                        alt=""
                        className="h-11 w-11 rounded-md border border-[#d1d5db] object-cover"
                      />
                    ) : (
                      <div className="flex h-11 w-11 items-center justify-center rounded-md border border-dashed border-[#cbd5e1] bg-[#f8fafc] text-[10px] font-semibold text-[#94a3b8]">
                        SKU
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <div className="font-medium">{item.product_name}</div>
                    <div className="mt-1 font-mono text-[11px] font-semibold uppercase tracking-normal text-[#6b7280]">
                      Артикул: {item.product_sku || "-"}
                    </div>
                  </td>
                  <td className="px-3 py-2 align-top text-right font-semibold tabular-nums">
                    {item.quantity}
                  </td>
                  <td className="px-3 py-2 align-top text-right text-[#4b5563]">шт.</td>
                  <td className="px-3 py-2 align-top text-right tabular-nums">{moneyPlain(item.unit_price)}</td>
                  <td className="px-3 py-2 align-top text-right font-semibold tabular-nums">{moneyPlain(item.total_price)}</td>
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
              <span className="text-[#4b5563]">Всього</span>
              <span className="font-semibold tabular-nums">{moneyPlain(order.total_amount)}</span>
            </div>
            <div className="flex justify-between border-b border-[#d1d5db] px-4 py-2 text-sm">
              <span className="text-[#4b5563]">Доставка</span>
              <span className="font-semibold">За тарифами перевізника</span>
            </div>
            <div className="flex justify-between border-b border-[#d1d5db] px-4 py-2 text-sm">
              <span className="text-[#4b5563]">Загальна сума</span>
              <span className="font-semibold tabular-nums">{moneyPlain(order.total_amount)}</span>
            </div>
            <div className="flex justify-between bg-[#f3f4f6] px-4 py-3 text-base">
              <span className="font-bold">До сплати</span>
              <span className="font-bold tabular-nums">{shortMoney(order.outstanding)}</span>
            </div>
          </div>
        </section>

        <section className="mt-5 text-sm">
          <div className="font-bold">Загальна сума до сплати:</div>
          <div className="mt-1 text-[#374151]">{payableWords}</div>
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
