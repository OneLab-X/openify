"use client";
import type { CredentialAdapter } from "@/components/ProviderSettings";
import { api } from "./api-client";

export const setupAdapter: CredentialAdapter = {
  test: (kind, provider, mode, body) =>
    api.POST("/api/setup/credentials/{kind}/test", {
      params: { path: { kind: kind as "storage" | "payment" | "email" | "analytics" } },
      body: { provider, mode, ...body },
    }),
  save: (kind, provider, mode, body) =>
    kind === "storage"
      ? api.PUT("/api/setup/storage", { body: { provider, mode, ...body } })
      : api.PUT("/api/setup/credentials/{kind}", {
          params: { path: { kind: kind as "payment" | "email" | "analytics" } },
          body: { provider, mode, ...body },
        }),
};

export const adminAdapter: CredentialAdapter = {
  test: (kind, provider, mode, body) =>
    api.POST("/api/admin/credentials/{kind}/{provider}/{mode}/test", { params: { path: { kind, provider, mode } }, body }),
  save: (kind, provider, mode, body) =>
    api.PUT("/api/admin/credentials/{kind}/{provider}/{mode}", { params: { path: { kind, provider, mode } }, body }),
  remove: (kind, provider, mode) =>
    api.DELETE("/api/admin/credentials/{kind}/{provider}/{mode}", { params: { path: { kind, provider, mode } } }),
};
