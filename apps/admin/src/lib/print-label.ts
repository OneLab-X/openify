import type { Schemas } from "@shopkit/sdk";

/**
 * Box label for one fulfillment, printed from this tab (ported from PLS `printLabel.ts`): the label
 * is added to the page, print CSS hides everything else, and it is removed after the print dialog
 * closes. A6 (105 × 148 mm) for label sheets, or A4 with the label in the top-left quarter.
 */
type Order = Schemas["OrderAdmin"];
type Fulfillment = Schemas["Fulfillment"];

const ROOT_ID = "print-label-root";

const esc = (value: string | null | undefined) =>
  (value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const lines = (parts: (string | null | undefined)[]) => parts.filter((p) => p && p.trim()).map(esc).join("<br>");

export function labelHtml(order: Order, f: Fulfillment | null, size: "A6" | "A4"): string {
  const a = order.shippingAddress;
  const name = [a?.firstName, a?.lastName].filter(Boolean).join(" ") || order.email || "";
  const items = order.lines
    .map((l) => {
      const qty = f ? (f.lines.find((x) => x.orderLineId === l.id)?.quantity ?? 0) : l.quantity;
      return qty > 0 ? `${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ""} × ${qty}` : null;
    })
    .filter(Boolean)
    .join(", ");
  const placed = order.placedAt ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(order.placedAt)) : "";
  const prepaid = order.amountPaid >= order.total && order.total > 0;
  const via = f ? [f.carrierName, f.trackingNumber ? `AWB <strong>${esc(f.trackingNumber)}</strong>` : null, f.driverName ? `${esc(f.driverName)}${f.driverMobile ? ` · ${esc(f.driverMobile)}` : ""}` : null].filter(Boolean).join(" · ") : "";
  const from = order.shipFrom;
  const width = size === "A6" ? "auto" : "93mm";

  return `
<style>
  @page { size: ${size}; margin: 6mm; }
  @media screen { #${ROOT_ID} { display: none; } }
  @media print {
    body > *:not(#${ROOT_ID}) { display: none !important; }
    #${ROOT_ID} { display: block; }
  }
  #${ROOT_ID} { font: 11pt/1.35 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #000; }
  #${ROOT_ID} .label { border: 1.5pt solid #000; padding: 4mm; width: ${width}; }
  #${ROOT_ID} .tag { font-size: 8pt; font-weight: 700; letter-spacing: 1.5pt; text-transform: uppercase; margin: 0 0 1mm; }
  #${ROOT_ID} .name { font-size: 15pt; font-weight: 700; margin: 0; }
  #${ROOT_ID} .pin { font-size: 18pt; font-weight: 800; letter-spacing: 1pt; margin: 1mm 0 0; }
  #${ROOT_ID} .row { border-top: 1pt dashed #000; margin-top: 3mm; padding-top: 3mm; }
  #${ROOT_ID} .order-id { font-size: 14pt; font-weight: 800; letter-spacing: 1pt; margin: 0; }
  #${ROOT_ID} p { margin: 0; }
  #${ROOT_ID} .small { font-size: 9pt; }
</style>
<div class="label">
  <p class="tag">Deliver to</p>
  <p class="name">${esc(name)}</p>
  <p>${lines([a?.company, a?.line1, a?.line2, [a?.city, a?.province].filter(Boolean).join(", "), a?.country])}</p>
  ${a?.postalCode ? `<p class="pin">PIN ${esc(a.postalCode)}</p>` : ""}
  ${a?.phone || order.phone ? `<p>Mobile: <strong>${esc(a?.phone || order.phone)}</strong></p>` : ""}
  <div class="row">
    <p class="tag">Order</p>
    <p class="order-id">${esc(order.name)}</p>
    <p>${esc(items)}</p>
    <p class="small">${placed ? `Placed ${esc(placed)}` : ""}${prepaid ? " · <strong>PREPAID</strong>" : " · <strong>COLLECT PAYMENT</strong>"}</p>
    ${via ? `<p class="small">Via ${via}</p>` : ""}
  </div>
  <div class="row small">
    <p class="tag">From</p>
    <p><strong>${esc(from.name)}</strong></p>
    <p>${lines([from.line1, from.line2, [from.city, from.province, from.postalCode].filter(Boolean).join(", "), from.country])}</p>
    ${from.phone ? `<p>Phone: ${esc(from.phone)}</p>` : ""}
  </div>
</div>`;
}

export function printLabel(order: Order, f: Fulfillment | null, size: "A6" | "A4"): void {
  document.getElementById(ROOT_ID)?.remove();
  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.innerHTML = labelHtml(order, f, size);
  document.body.appendChild(root);
  // "Save as PDF" names the file after the page title.
  const title = document.title;
  document.title = `${order.name.replace(/[^A-Za-z0-9-]/g, "")}${f ? `-${f.name.replace(/[^A-Za-z0-9-]/g, "")}` : ""}-label`;
  const cleanup = () => {
    root.remove();
    document.title = title;
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  window.print();
}
