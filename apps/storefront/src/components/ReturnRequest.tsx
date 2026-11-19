"use client";
import { useState } from "react";
import { sf, ShopError, type OrderPublic } from "@/lib/shop-client";

const REASONS = [
  ["size", "Size didn't fit"],
  ["unwanted", "No longer wanted"],
  ["not_as_described", "Not as described"],
  ["wrong_item", "Wrong item sent"],
  ["defective", "Damaged or defective"],
  ["other", "Other"],
] as const;

/**
 * "Request a return" for shipped items (status page by signed link, or the account order page).
 * The shop approves it; the shopper sees its status on the same page.
 */
export function ReturnRequest({ order, endpoint, onDone }: { order: OrderPublic; endpoint: string; onDone?: (o: OrderPublic) => void }) {
  const returnable = order.lines.filter((l) => (order.returnable[l.id] ?? 0) > 0);
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [reason, setReason] = useState<(typeof REASONS)[number][0]>("size");
  const [note, setNote] = useState("");
  const [state, setState] = useState<{ busy?: boolean; error?: string; sent?: boolean }>({});
  if (returnable.length === 0 || order.status === "cancelled") return null;
  if (state.sent) return <p role="status" className="rounded-md border border-input p-3 text-sm">Return requested. We'll email you once the shop reviews it.</p>;
  const lines = Object.entries(qty)
    .filter(([, q]) => q > 0)
    .map(([orderLineId, quantity]) => ({ orderLineId, quantity, reason }));

  async function submit() {
    setState({ busy: true });
    try {
      const next = await sf<OrderPublic>("POST", endpoint, { lines, ...(note.trim() ? { note: note.trim() } : {}) });
      setState({ sent: true });
      onDone?.(next);
    } catch (e) {
      setState({ error: e instanceof ShopError ? e.message : "Could not send the request" });
    }
  }

  if (!open) {
    return (
      <button type="button" className="h-11 justify-self-start rounded-md border border-input px-4 text-sm font-medium" onClick={() => setOpen(true)}>
        Request a return
      </button>
    );
  }
  return (
    <section aria-labelledby="ret-h" className="grid gap-3 rounded-md border border-input p-4 text-sm">
      <h2 id="ret-h" className="text-lg font-semibold">
        Request a return
      </h2>
      {returnable.map((l) => {
        const max = order.returnable[l.id] ?? 0;
        return (
          <label key={l.id} className="flex items-center justify-between gap-3">
            <span>
              {l.title}
              {l.variantTitle ? <span className="text-muted-foreground"> · {l.variantTitle}</span> : null}
            </span>
            <input
              type="number"
              min={0}
              max={max}
              value={qty[l.id] ?? 0}
              onChange={(e) => setQty({ ...qty, [l.id]: Math.max(0, Math.min(max, Number(e.target.value) || 0)) })}
              aria-label={`How many ${l.title} to return (up to ${max})`}
              className="h-10 w-20 rounded-md border border-input bg-background px-2"
            />
          </label>
        );
      })}
      <label className="grid gap-1">
        <span className="font-medium">Reason</span>
        <select value={reason} onChange={(e) => setReason(e.target.value as typeof reason)} className="h-10 rounded-md border border-input bg-background px-2">
          {REASONS.map(([v, text]) => (
            <option key={v} value={v}>
              {text}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1">
        <span className="font-medium">Anything else? (optional)</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} className="rounded-md border border-input bg-background p-2" />
      </label>
      {state.error ? (
        <p role="alert" className="text-red-700">
          {state.error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button type="button" disabled={lines.length === 0 || state.busy} onClick={() => void submit()} className="h-11 rounded-md bg-primary px-4 font-medium text-primary-foreground disabled:opacity-50">
          {state.busy ? "Sending…" : "Send request"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="h-11 rounded-md px-4">
          Cancel
        </button>
      </div>
    </section>
  );
}
