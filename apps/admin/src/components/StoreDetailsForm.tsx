"use client";
import type { Schemas } from "@shopkit/sdk";
import { Alert, Button, Field, Input, Select } from "@shopkit/ui";
import { useState, type FormEvent } from "react";
import { text } from "@/lib/form";
import { errorMessage, fieldErrors } from "@/lib/api-client";

type Store = Schemas["Store"];
export interface StoreDetailsBody {
  name: string;
  legalName?: string;
  email: string;
  phone?: string;
  address: { line1?: string; line2?: string; city?: string; province?: string; postalCode?: string; country?: string };
  country: string;
  currency: string;
  timezone: string;
  locale: string;
  weightUnit: "kg" | "g" | "lb" | "oz";
  brand: { primaryColor?: string; accentColor?: string };
  publicUrl: string;
}

const CURRENCIES = ["INR", "USD", "EUR", "GBP", "AUD", "CAD", "SGD", "AED", "JPY"];
const opt = (v: string) => (v.trim() === "" ? undefined : v.trim());

export function StoreDetailsForm({
  store,
  defaultPublicUrl,
  submitLabel,
  onSubmit,
}: {
  store: Store;
  defaultPublicUrl: string;
  submitLabel: string;
  onSubmit: (body: StoreDetailsBody) => Promise<{ error?: unknown }>;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const tz = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => text(f, k);
    const body: StoreDetailsBody = {
      name: s("name"),
      ...(opt(s("legalName")) ? { legalName: opt(s("legalName"))! } : {}),
      email: s("email"),
      ...(opt(s("phone")) ? { phone: opt(s("phone"))! } : {}),
      address: {
        line1: opt(s("line1")), line2: opt(s("line2")), city: opt(s("city")), province: opt(s("province")),
        postalCode: opt(s("postalCode")), country: opt(s("country")),
      },
      country: s("country"),
      currency: s("currency"),
      timezone: s("timezone"),
      locale: s("locale"),
      weightUnit: s("weightUnit") as StoreDetailsBody["weightUnit"],
      brand: { primaryColor: opt(s("primaryColor")), accentColor: opt(s("accentColor")) },
      publicUrl: s("publicUrl"),
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

  const err = (k: string) => errors[k];
  return (
    <form onSubmit={(e) => void submit(e)} className="grid gap-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="name" label="Store name" required error={err("name")}>
          <Input id="name" name="name" defaultValue={store.name} required />
        </Field>
        <Field id="legalName" label="Legal name" error={err("legalName")}>
          <Input id="legalName" name="legalName" defaultValue={store.legalName ?? ""} />
        </Field>
        <Field id="email" label="Store email" required error={err("email")}>
          <Input id="email" name="email" type="email" defaultValue={store.email ?? ""} required />
        </Field>
        <Field id="phone" label="Phone" error={err("phone")}>
          <Input id="phone" name="phone" type="tel" defaultValue={store.phone ?? ""} />
        </Field>
        <Field id="line1" label="Address" className="sm:col-span-2">
          <Input id="line1" name="line1" defaultValue={store.address.line1 ?? ""} />
        </Field>
        <Field id="line2" label="Address line 2" className="sm:col-span-2">
          <Input id="line2" name="line2" defaultValue={store.address.line2 ?? ""} />
        </Field>
        <Field id="city" label="City">
          <Input id="city" name="city" defaultValue={store.address.city ?? ""} />
        </Field>
        <Field id="province" label="State / province">
          <Input id="province" name="province" defaultValue={store.address.province ?? ""} />
        </Field>
        <Field id="postalCode" label="Postal code">
          <Input id="postalCode" name="postalCode" defaultValue={store.address.postalCode ?? ""} />
        </Field>
        <Field id="country" label="Country (ISO code)" required error={err("country")}>
          <Input id="country" name="country" maxLength={2} defaultValue={store.country ?? "IN"} required />
        </Field>
        <Field id="currency" label="Currency" required error={err("currency")}>
          <Select id="currency" name="currency" defaultValue={store.currency ?? "INR"}>
            {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
          </Select>
        </Field>
        <Field id="timezone" label="Time zone" required error={err("timezone")}>
          <Input id="timezone" name="timezone" defaultValue={store.timezone ?? tz} required />
        </Field>
        <Field id="locale" label="Locale" required error={err("locale")}>
          <Input id="locale" name="locale" defaultValue={store.locale ?? "en-IN"} required />
        </Field>
        <Field id="weightUnit" label="Weight unit" required>
          <Select id="weightUnit" name="weightUnit" defaultValue={store.weightUnit ?? "kg"}>
            {["kg", "g", "lb", "oz"].map((u) => <option key={u}>{u}</option>)}
          </Select>
        </Field>
        <Field id="primaryColor" label="Brand colour" error={err("brand.primaryColor")}>
          <Input id="primaryColor" name="primaryColor" type="color" defaultValue={store.brand.primaryColor ?? "#1f2937"} className="h-10 p-1" />
        </Field>
        <Field id="accentColor" label="Accent colour" error={err("brand.accentColor")}>
          <Input id="accentColor" name="accentColor" type="color" defaultValue={store.brand.accentColor ?? "#f59e0b"} className="h-10 p-1" />
        </Field>
        <Field id="publicUrl" label="Public URL" required error={err("publicUrl")} className="sm:col-span-2">
          <Input id="publicUrl" name="publicUrl" type="url" defaultValue={store.publicUrl ?? defaultPublicUrl} required />
        </Field>
      </div>
      {message ? <Alert variant={message.ok ? "success" : "error"}>{message.text}</Alert> : null}
      <div>
        <Button type="submit" loading={busy}>{submitLabel}</Button>
      </div>
    </form>
  );
}
