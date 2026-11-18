"use client";
import type { Schemas } from "@shopkit/sdk";
import { Alert, Button, Field, Input, Select } from "@shopkit/ui";
import { useState, type FormEvent } from "react";
import { text } from "@/lib/form";
import { errorMessage, fieldErrors } from "@/lib/api-client";

type Settings = Schemas["Settings"];
export type ShippingTaxBody =
  | {
      shipFrom: { name: string; address: { line1?: string; city?: string; postalCode?: string; country?: string } };
      zone: { name: string; countries: string[] };
      rate: { name: string; amount: number; freeOver: number | null };
      tax:
        | { mode: "india_gst"; defaultRateBps: number; gstin?: string; registeredState?: string }
        | { mode: "generic"; pricesIncludeTax: boolean; defaultRateBps: number; label: string };
    };

/** Money inputs are in major units for humans and sent as integer minor units. */
const toMinor = (v: string) => Math.round(Number(v || 0) * 100);
const toMajor = (v: number | null | undefined) => (v === null || v === undefined ? "" : (v / 100).toString());

export function ShippingTaxForm({
  settings,
  shipFrom,
  currency,
  submitLabel,
  onSubmit,
  showShipFrom = true,
}: {
  showShipFrom?: boolean;
  settings: Settings;
  shipFrom: { name: string; address: { line1?: string; city?: string; postalCode?: string; country?: string } } | null;
  currency: string;
  submitLabel: string;
  onSubmit: (body: ShippingTaxBody) => Promise<{ error?: unknown }>;
}) {
  const [taxMode, setTaxMode] = useState<"india_gst" | "generic">(settings.tax.mode);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => text(f, k).trim();
    const rateBps = Math.round(Number(s("taxRate") || 0) * 100);
    const body: ShippingTaxBody = {
      shipFrom: { name: s("shipFromName"), address: { line1: s("shipLine1") || undefined, city: s("shipCity") || undefined, postalCode: s("shipPostal") || undefined, country: s("shipCountry") || undefined } },
      zone: { name: s("zoneName"), countries: s("zoneCountries").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean) },
      rate: { name: s("rateName"), amount: toMinor(s("rateAmount")), freeOver: s("freeOver") ? toMinor(s("freeOver")) : null },
      tax:
        taxMode === "india_gst"
          ? { mode: "india_gst", defaultRateBps: rateBps, ...(s("gstin") ? { gstin: s("gstin").toUpperCase() } : {}), ...(s("registeredState") ? { registeredState: s("registeredState") } : {}) }
          : { mode: "generic", pricesIncludeTax: f.get("pricesIncludeTax") === "on", defaultRateBps: rateBps, label: s("taxLabel") || "Tax" },
    };
    setBusy(true);
    setErrors({});
    setMessage(null);
    const { error } = await onSubmit(body);
    setBusy(false);
    if (error) {
      setErrors(fieldErrors(error));
      setMessage({ ok: false, text: errorMessage(error) });
    } else setMessage({ ok: true, text: "Saved." });
  }

  const sh = settings.shipping;
  return (
    <form onSubmit={(e) => void submit(e)} className="grid gap-6" noValidate>
      <section className={showShipFrom ? "grid gap-4 sm:grid-cols-2" : "hidden"}>
        <h3 className="font-medium sm:col-span-2">Ship from</h3>
        <Field id="shipFromName" label="Location name" required error={errors["shipFrom.name"]}>
          <Input id="shipFromName" name="shipFromName" defaultValue={shipFrom?.name ?? "Warehouse"} required />
        </Field>
        <Field id="shipLine1" label="Address">
          <Input id="shipLine1" name="shipLine1" defaultValue={shipFrom?.address.line1 ?? ""} />
        </Field>
        <Field id="shipCity" label="City">
          <Input id="shipCity" name="shipCity" defaultValue={shipFrom?.address.city ?? ""} />
        </Field>
        <Field id="shipPostal" label="Postal code">
          <Input id="shipPostal" name="shipPostal" defaultValue={shipFrom?.address.postalCode ?? ""} />
        </Field>
        <Field id="shipCountry" label="Country (ISO code)">
          <Input id="shipCountry" name="shipCountry" maxLength={2} defaultValue={shipFrom?.address.country ?? "IN"} />
        </Field>
      </section>
      <section className="grid gap-4 sm:grid-cols-2">
        <h3 className="font-medium sm:col-span-2">Default zone and flat rate</h3>
        <Field id="zoneName" label="Zone name" required error={errors["zone.name"]}>
          <Input id="zoneName" name="zoneName" defaultValue={sh.zoneName} required />
        </Field>
        <Field id="zoneCountries" label="Countries" description="Comma-separated ISO codes, e.g. IN" required error={errors["zone.countries"]}>
          <Input id="zoneCountries" name="zoneCountries" defaultValue={sh.countries.join(", ") || "IN"} required />
        </Field>
        <Field id="rateName" label="Rate name" required error={errors["rate.name"]}>
          <Input id="rateName" name="rateName" defaultValue={sh.rateName} required />
        </Field>
        <Field id="rateAmount" label={`Flat rate (${currency})`} required error={errors["rate.amount"]}>
          <Input id="rateAmount" name="rateAmount" type="number" min="0" step="0.01" defaultValue={toMajor(sh.rateAmount)} required />
        </Field>
        <Field id="freeOver" label={`Free shipping over (${currency})`} description="Leave empty for never">
          <Input id="freeOver" name="freeOver" type="number" min="0" step="0.01" defaultValue={toMajor(sh.freeOver)} />
        </Field>
      </section>
      <section className="grid gap-4 sm:grid-cols-2">
        <h3 className="font-medium sm:col-span-2">Taxes</h3>
        <Field id="taxMode" label="Tax mode">
          <Select id="taxMode" value={taxMode} onChange={(e) => setTaxMode(e.target.value as "india_gst" | "generic")}>
            <option value="india_gst">India GST (prices include tax; CGST/SGST/IGST)</option>
            <option value="generic">VAT / sales tax</option>
          </Select>
        </Field>
        <Field id="taxRate" label="Default rate (%)" error={errors["tax.defaultRateBps"]}>
          <Input id="taxRate" name="taxRate" type="number" min="0" max="100" step="0.01" defaultValue={(settings.tax.defaultRateBps / 100 || (taxMode === "india_gst" ? 18 : 0)).toString()} />
        </Field>
        {taxMode === "india_gst" ? (
          <>
            <Field id="gstin" label="GSTIN" error={errors["tax.gstin"]}>
              <Input id="gstin" name="gstin" maxLength={15} defaultValue={settings.tax.gstin ?? ""} />
            </Field>
            <Field id="registeredState" label="Registered state">
              <Input id="registeredState" name="registeredState" defaultValue={settings.tax.registeredState ?? ""} />
            </Field>
          </>
        ) : (
          <>
            <Field id="taxLabel" label="Tax label">
              <Input id="taxLabel" name="taxLabel" defaultValue={settings.tax.label ?? "Tax"} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="pricesIncludeTax" defaultChecked={settings.tax.pricesIncludeTax} /> Prices include tax
            </label>
          </>
        )}
      </section>
      {message ? <Alert variant={message.ok ? "success" : "error"}>{message.text}</Alert> : null}
      <div>
        <Button type="submit" loading={busy}>{submitLabel}</Button>
      </div>
    </form>
  );
}
