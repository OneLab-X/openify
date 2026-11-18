"use client";
import type { Schemas } from "@shopkit/sdk";
import { StoreDetailsForm } from "@/components/StoreDetailsForm";
import { api } from "@/lib/api-client";

export function GeneralForm({ store }: { store: Schemas["Store"] }) {
  return (
    <StoreDetailsForm
      store={store}
      defaultPublicUrl={store.publicUrl ?? ""}
      submitLabel="Save"
      onSubmit={(body) => api.PUT("/api/admin/store", { body })}
    />
  );
}
