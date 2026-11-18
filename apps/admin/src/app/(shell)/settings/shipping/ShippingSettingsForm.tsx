"use client";
import type { Schemas } from "@shopkit/sdk";
import { ShippingTaxForm } from "@/components/ShippingTaxForm";
import { api } from "@/lib/api-client";

export function ShippingSettingsForm({ settings, currency }: { settings: Schemas["Settings"]; currency: string }) {
  return (
    <ShippingTaxForm
      settings={settings}
      shipFrom={null}
      showShipFrom={false}
      currency={currency}
      submitLabel="Save"
      onSubmit={async (body) => {
        const shipping = await api.PUT("/api/admin/settings/{key}", {
          params: { path: { key: "shipping.defaults" } },
          body: { value: { zoneName: body.zone.name, countries: body.zone.countries, rateName: body.rate.name, rateAmount: body.rate.amount, freeOver: body.rate.freeOver } },
        });
        if (shipping.error) return shipping;
        const tax =
          body.tax.mode === "india_gst"
            ? { mode: "india_gst", pricesIncludeTax: true, label: "GST", defaultRateBps: body.tax.defaultRateBps, ...(body.tax.gstin ? { gstin: body.tax.gstin } : {}), ...(body.tax.registeredState ? { registeredState: body.tax.registeredState } : {}) }
            : body.tax;
        return api.PUT("/api/admin/settings/{key}", { params: { path: { key: "tax.config" } }, body: { value: tax } });
      }}
    />
  );
}
