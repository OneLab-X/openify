import { asc, customers, eq, invoices, orderLines, orders, and, type Executor, type MailingAddress, type TaxLine } from "@shopkit/db";
import { currencyDigits } from "@shopkit/providers";
import type { CoreDeps } from "../deps.js";
import { now } from "../deps.js";
import { AppError, notFound } from "../errors.js";
import { A4, PdfDocument, wrap } from "../pdf.js";
import { getSetting } from "../settings.js";
import { getStore } from "../stores.js";
import { nextNumber } from "./orders.js";
import { isIntraState } from "./tax.js";

/**
 * Tax invoices (Phase 4). The first request issues a number from a per-store sequence and freezes
 * the invoice data, so reprints never change. Amounts come from the order lines' stored tax (the
 * same per-line split the checkout charged), so the invoice totals equal the sum of line taxes:
 * CGST + SGST for intra-state supplies, IGST inter-state (GST rule 46 fields: seller and buyer
 * GSTIN, place of supply, HSN, taxable value, rate and amount per tax head).
 */
export interface InvoiceLine {
  description: string;
  hsn: string | null;
  quantity: number;
  unitPrice: number;
  discount: number;
  taxableValue: number;
  rateBps: number;
  cgst: number;
  sgst: number;
  igst: number;
  otherTax: number;
  total: number;
}

export interface InvoiceData {
  number: string;
  issuedAt: string;
  orderName: string;
  orderDate: string;
  currency: string;
  mode: "india_gst" | "generic";
  taxesIncluded: boolean;
  seller: { name: string; legalName: string | null; address: string[]; taxId: string | null; state: string | null; email: string | null; phone: string | null };
  buyer: { name: string; address: string[]; taxId: string | null; email: string | null; phone: string | null };
  placeOfSupply: string | null;
  intraState: boolean;
  lines: InvoiceLine[];
  totals: { taxableValue: number; cgst: number; sgst: number; igst: number; otherTax: number; tax: number; discount: number; total: number; paid: number; giftCard: number };
  taxSummary: TaxLine[];
  amountInWords: string | null;
}

const fullName = (a: MailingAddress | null | undefined) => [a?.firstName, a?.lastName].filter(Boolean).join(" ");
const addressLines = (a: MailingAddress | null | undefined) =>
  a ? [a.company, a.line1, a.line2, [a.city, a.province, a.postalCode].filter(Boolean).join(", "), a.country].filter((x): x is string => !!x && x.trim() !== "") : [];

/** Splits one line's stored tax lines into the GST heads. */
function heads(taxLines: TaxLine[]) {
  const by = (t: string) => taxLines.filter((x) => x.title === t).reduce((s, x) => s + x.amount, 0);
  const cgst = by("CGST");
  const sgst = by("SGST");
  const igst = by("IGST");
  const total = taxLines.reduce((s, x) => s + x.amount, 0);
  return { cgst, sgst, igst, otherTax: total - cgst - sgst - igst, total };
}

/** Builds invoice data from an order (pure apart from the reads). */
export async function buildInvoiceData(db: Executor, storeId: string, orderId: string, number: string, issuedAt: Date): Promise<InvoiceData> {
  const [order] = await db.select().from(orders).where(and(eq(orders.storeId, storeId), eq(orders.id, orderId)));
  if (!order?.placedAt) throw notFound("Order");
  const store = await getStore(db, storeId);
  const tax = await getSetting(db, storeId, "tax.config");
  const lines = await db.select().from(orderLines).where(eq(orderLines.orderId, orderId)).orderBy(asc(orderLines.position));
  const [customer] = order.customerId ? await db.select({ taxId: customers.taxId }).from(customers).where(eq(customers.id, order.customerId)) : [];
  const buyerAddress = order.billingAddress ?? order.shippingAddress;
  const intraState = tax.mode === "india_gst" && isIntraState(tax, order.shippingAddress);

  const invLines: InvoiceLine[] = lines.map((l) => {
    const gross = l.unitPrice * l.quantity - l.discountAmount;
    const h = heads(l.taxLines);
    const taxableValue = order.taxesIncluded ? gross - h.total : gross;
    return {
      description: l.title + (l.variantTitle ? ` – ${l.variantTitle}` : ""),
      hsn: l.hsnCode,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discount: l.discountAmount,
      taxableValue,
      rateBps: l.taxLines.reduce((s, t) => s + t.rateBps, 0),
      cgst: h.cgst,
      sgst: h.sgst,
      igst: h.igst,
      otherTax: h.otherTax,
      total: taxableValue + h.total,
    };
  });

  // Shipping is a line of its own; its tax is whatever the order charged beyond the item lines.
  const orderHeads = heads(order.taxLines);
  const lineSum = invLines.reduce((s, l) => ({ cgst: s.cgst + l.cgst, sgst: s.sgst + l.sgst, igst: s.igst + l.igst, other: s.other + l.otherTax }), { cgst: 0, sgst: 0, igst: 0, other: 0 });
  if (order.shippingLine && order.shippingTotal > 0) {
    const sh = { cgst: orderHeads.cgst - lineSum.cgst, sgst: orderHeads.sgst - lineSum.sgst, igst: orderHeads.igst - lineSum.igst, other: orderHeads.otherTax - lineSum.other };
    const shTax = sh.cgst + sh.sgst + sh.igst + sh.other;
    const taxableValue = order.taxesIncluded ? order.shippingTotal - shTax : order.shippingTotal;
    const rate = shTax > 0 ? tax.defaultRateBps : 0;
    invLines.push({ description: `Shipping – ${order.shippingLine.title}`, hsn: tax.mode === "india_gst" ? "996812" : null, quantity: 1, unitPrice: order.shippingLine.amount, discount: order.shippingLine.discount, taxableValue, rateBps: rate, cgst: sh.cgst, sgst: sh.sgst, igst: sh.igst, otherTax: sh.other, total: taxableValue + shTax });
  }

  const totals = invLines.reduce(
    (t, l) => ({ ...t, taxableValue: t.taxableValue + l.taxableValue, cgst: t.cgst + l.cgst, sgst: t.sgst + l.sgst, igst: t.igst + l.igst, otherTax: t.otherTax + l.otherTax }),
    { taxableValue: 0, cgst: 0, sgst: 0, igst: 0, otherTax: 0 },
  );
  const taxTotal = totals.cgst + totals.sgst + totals.igst + totals.otherTax;
  const a = store.address ?? {};
  return {
    number,
    issuedAt: issuedAt.toISOString(),
    orderName: order.name ?? "",
    orderDate: order.placedAt.toISOString(),
    currency: order.currency,
    mode: tax.mode,
    taxesIncluded: order.taxesIncluded,
    seller: {
      name: store.name,
      legalName: store.legalName,
      address: [a.line1, a.line2, [a.city, a.province, a.postalCode].filter(Boolean).join(", "), a.country].filter((x): x is string => !!x && x.trim() !== ""),
      taxId: tax.gstin ?? null,
      state: tax.registeredState ?? a.province ?? null,
      email: store.email,
      phone: store.phone,
    },
    buyer: { name: fullName(buyerAddress) || order.email || "Customer", address: addressLines(buyerAddress), taxId: order.buyerTaxId ?? customer?.taxId ?? null, email: order.email, phone: order.phone },
    placeOfSupply: order.shippingAddress?.province ?? null,
    intraState,
    lines: invLines,
    totals: { ...totals, tax: taxTotal, discount: order.discountTotal, total: order.total, paid: order.amountPaid, giftCard: order.giftCardTotal },
    taxSummary: order.taxLines,
    amountInWords: order.currency === "INR" ? rupeesInWords(order.total) : null,
  };
}

/** Issues (once) and returns the invoice for an order. */
export async function getInvoice(deps: CoreDeps, storeId: string, orderId: string): Promise<InvoiceData> {
  const [existing] = await deps.db.select().from(invoices).where(and(eq(invoices.storeId, storeId), eq(invoices.orderId, orderId)));
  if (existing) return existing.data as unknown as InvoiceData;
  return deps.db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(and(eq(orders.storeId, storeId), eq(orders.id, orderId))).for("update");
    if (!order?.placedAt) throw notFound("Order");
    if (order.status === "cancelled" && order.amountPaid === 0) throw new AppError("conflict", "Cancelled unpaid orders have no invoice");
    const [again] = await tx.select().from(invoices).where(eq(invoices.orderId, orderId));
    if (again) return again.data as unknown as InvoiceData;
    const n = await nextNumber(tx, storeId, "invoice");
    const issuedAt = now(deps);
    const number = `INV-${String(n).padStart(5, "0")}`;
    const data = await buildInvoiceData(tx, storeId, orderId, number, issuedAt);
    await tx.insert(invoices).values({ storeId, orderId, number, data: data as unknown as Record<string, unknown>, issuedAt });
    return data;
  });
}

// ── Amount in words (Indian numbering) ───────────────────────────────────────
const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function below100(n: number) {
  return n < 20 ? ONES[n]! : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`;
}
function below1000(n: number) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : "", r ? below100(r) : ""].filter(Boolean).join(" ");
}
export function indianWords(n: number): string {
  if (n === 0) return "Zero";
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1000);
  const rest = n % 1000;
  if (crore) parts.push(`${indianWords(crore)} Crore`);
  if (lakh) parts.push(`${below100(lakh)} Lakh`);
  if (thousand) parts.push(`${below100(thousand)} Thousand`);
  if (rest) parts.push(below1000(rest));
  return parts.join(" ");
}
export function rupeesInWords(paise: number): string {
  const r = Math.floor(paise / 100);
  const p = paise % 100;
  return `Rupees ${indianWords(r)}${p ? ` and ${below100(p)} Paise` : ""} Only`;
}

// ── PDF ──────────────────────────────────────────────────────────────────────
function money(minor: number, currency: string) {
  const d = currencyDigits(currency);
  const v = (minor / 10 ** d).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
  return v;
}

export function renderInvoicePdf(inv: InvoiceData): Buffer {
  const doc = new PdfDocument({ title: `Invoice ${inv.number}`, author: inv.seller.name });
  const M = 36;
  const W = A4.width - 2 * M;
  const gst = inv.mode === "india_gst";
  let y = 48;

  doc.text(M, y, gst ? "TAX INVOICE" : "INVOICE", { size: 16, font: "bold" });
  doc.text(A4.width - M, y, inv.number, { size: 12, font: "bold", align: "right" });
  y += 16;
  doc.text(A4.width - M, y, `Date: ${inv.issuedAt.slice(0, 10)}   Order: ${inv.orderName} (${inv.orderDate.slice(0, 10)})`, { size: 8, align: "right" });
  y += 18;

  // Seller | Buyer
  const col = W / 2;
  const block = (x: number, title: string, rows: string[]) => {
    let yy = y;
    doc.text(x, yy, title, { size: 7, font: "bold", color: [0.4, 0.4, 0.4] });
    yy += 11;
    rows.forEach((r, i) => {
      for (const part of wrap(r, i === 0 ? 10 : 8.5, col - 12, i === 0 ? "bold" : "regular")) {
        doc.text(x, yy, part, { size: i === 0 ? 10 : 8.5, font: i === 0 ? "bold" : "regular" });
        yy += i === 0 ? 13 : 11;
      }
    });
    return yy;
  };
  const sellerRows = [inv.seller.legalName || inv.seller.name, ...inv.seller.address, ...(inv.seller.taxId ? [`${gst ? "GSTIN" : "Tax ID"}: ${inv.seller.taxId}`] : []), ...(inv.seller.state && gst ? [`State: ${inv.seller.state}`] : []), ...(inv.seller.email ? [inv.seller.email] : [])];
  const buyerRows = [inv.buyer.name, ...inv.buyer.address, ...(inv.buyer.taxId ? [`${gst ? "GSTIN" : "Tax ID"}: ${inv.buyer.taxId}`] : []), ...(gst && inv.placeOfSupply ? [`Place of supply: ${inv.placeOfSupply}`] : []), ...(inv.buyer.email ? [inv.buyer.email] : [])];
  y = Math.max(block(M, "SOLD BY", sellerRows), block(M + col, "BILL TO", buyerRows)) + 10;

  // Table
  const cols = gst
    ? inv.intraState
      ? [
          { k: "description", t: "Item", w: 150 },
          { k: "hsn", t: "HSN/SAC", w: 50 },
          { k: "quantity", t: "Qty", w: 28, r: true },
          { k: "taxableValue", t: "Taxable value", w: 70, r: true },
          { k: "rate", t: "Rate", w: 34, r: true },
          { k: "cgst", t: "CGST", w: 56, r: true },
          { k: "sgst", t: "SGST", w: 56, r: true },
          { k: "total", t: "Total", w: W - 444, r: true },
        ]
      : [
          { k: "description", t: "Item", w: 180 },
          { k: "hsn", t: "HSN/SAC", w: 56 },
          { k: "quantity", t: "Qty", w: 30, r: true },
          { k: "taxableValue", t: "Taxable value", w: 80, r: true },
          { k: "rate", t: "Rate", w: 40, r: true },
          { k: "igst", t: "IGST", w: 70, r: true },
          { k: "total", t: "Total", w: W - 456, r: true },
        ]
    : [
        { k: "description", t: "Item", w: 220 },
        { k: "quantity", t: "Qty", w: 34, r: true },
        { k: "taxableValue", t: "Net", w: 90, r: true },
        { k: "rate", t: "Rate", w: 46, r: true },
        { k: "otherTax", t: "Tax", w: 70, r: true },
        { k: "total", t: "Total", w: W - 460, r: true },
      ];
  doc.rect(M, y, W, 16, 0.92);
  let x = M;
  for (const c of cols) {
    doc.text(c.r ? x + c.w - 4 : x + 4, y + 11, c.t, { size: 7.5, font: "bold", align: c.r ? "right" : "left" });
    x += c.w;
  }
  y += 16;
  const cell = (l: InvoiceLine, k: string) =>
    k === "description" ? l.description : k === "hsn" ? (l.hsn ?? "") : k === "quantity" ? String(l.quantity) : k === "rate" ? `${l.rateBps / 100}%` : money(l[k as "cgst"], inv.currency);
  for (const l of inv.lines) {
    const desc = wrap(l.description, 8, cols[0]!.w - 8);
    const h = Math.max(14, desc.length * 10 + 4);
    if (y + h > A4.height - 140) {
      doc.addPage();
      y = 48;
    }
    x = M;
    for (const c of cols) {
      if (c.k === "description") desc.forEach((d, i) => doc.text(x + 4, y + 10 + i * 10, d, { size: 8 }));
      else doc.text(c.r ? x + c.w - 4 : x + 4, y + 10, cell(l, c.k), { size: 8, align: c.r ? "right" : "left" });
      x += c.w;
    }
    y += h;
    doc.line(M, y, M + W, y, 0.3, 0.8);
  }

  // Totals
  y += 10;
  const right = A4.width - M;
  const row = (label: string, value: string, bold = false) => {
    doc.text(right - 110, y, label, { size: 9, font: bold ? "bold" : "regular", align: "right" });
    doc.text(right, y, value, { size: 9, font: bold ? "bold" : "regular", align: "right" });
    y += 13;
  };
  row("Taxable value", money(inv.totals.taxableValue, inv.currency));
  if (gst && inv.totals.cgst) row("CGST", money(inv.totals.cgst, inv.currency));
  if (gst && inv.totals.sgst) row("SGST", money(inv.totals.sgst, inv.currency));
  if (gst && inv.totals.igst) row("IGST", money(inv.totals.igst, inv.currency));
  if (inv.totals.otherTax) row("Tax", money(inv.totals.otherTax, inv.currency));
  row(`Invoice total (${inv.currency})`, money(inv.totals.total, inv.currency), true);
  if (inv.totals.giftCard) row("Paid by gift card", money(inv.totals.giftCard, inv.currency));
  if (inv.amountInWords) {
    y += 4;
    for (const part of wrap(inv.amountInWords, 8.5, W)) {
      doc.text(M, y, part, { size: 8.5, font: "bold" });
      y += 11;
    }
  }
  y += 16;
  doc.text(M, y, inv.taxesIncluded ? "Prices include tax." : "Tax is charged on the taxable value.", { size: 7.5, color: [0.4, 0.4, 0.4] });
  y += 11;
  doc.text(M, y, "This is a computer-generated invoice and needs no signature.", { size: 7.5, color: [0.4, 0.4, 0.4] });
  doc.text(right, y, `For ${inv.seller.legalName || inv.seller.name}`, { size: 8, font: "bold", align: "right" });
  return doc.toBuffer();
}
