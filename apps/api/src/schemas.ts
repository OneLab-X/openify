import { PERMISSIONS, SETUP_STEPS } from "@shopkit/core";
import { PROVIDER_KINDS } from "@shopkit/providers";
import { z } from "zod";

export const errorBody = z
  .object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) })
  .meta({ id: "Error" });
export const okBody = z.object({ ok: z.literal(true) });

export const providerKind = z.enum(PROVIDER_KINDS);
export const providerMode = z.enum(["test", "live"]);

export const testResult = z
  .object({ ok: z.boolean(), message: z.string().optional(), error: z.string().optional() })
  .meta({ id: "TestResult" });

export const credentialSummary = z
  .object({
    id: z.uuid(),
    kind: providerKind,
    provider: z.string(),
    mode: providerMode,
    enabled: z.boolean(),
    config: z.record(z.string(), z.unknown()),
    configured: z.literal(true),
    last4: z.string().nullable(),
    secretFields: z.array(z.string()),
    updatedAt: z.string(),
  })
  .meta({ id: "CredentialSummary" });

export const providerDescriptor = z
  .object({
    id: z.string(),
    kind: providerKind,
    displayName: z.string(),
    description: z.string().optional(),
    docsUrl: z.string().optional(),
    status: z.enum(["available", "coming_soon"]),
    modes: z.array(providerMode).readonly(),
    configSchema: z.record(z.string(), z.unknown()).nullable(),
    secretsSchema: z.record(z.string(), z.unknown()).nullable(),
    webhookEvents: z.array(z.string()).readonly(),
  })
  .meta({ id: "ProviderDescriptor" });

const address = z.object({
  line1: z.string().optional(),
  line2: z.string().optional(),
  city: z.string().optional(),
  province: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
});

export const storeView = z
  .object({
    id: z.uuid(),
    status: z.enum(["setup", "active"]),
    name: z.string(),
    legalName: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    address,
    country: z.string().nullable(),
    currency: z.string().nullable(),
    timezone: z.string().nullable(),
    locale: z.string().nullable(),
    weightUnit: z.enum(["kg", "g", "lb", "oz"]).nullable(),
    brand: z.object({ primaryColor: z.string().optional(), accentColor: z.string().optional() }),
    publicUrl: z.string().nullable(),
    logoUrl: z.string().nullable(),
    faviconUrl: z.string().nullable(),
    launchedAt: z.string().nullable(),
  })
  .meta({ id: "Store" });

export const staffView = z
  .object({
    id: z.uuid(),
    name: z.string(),
    email: z.string(),
    role: z.string(),
    roleName: z.string(),
    permissions: z.array(z.string()),
    totpEnabled: z.boolean(),
    lastLoginAt: z.string().nullable(),
  })
  .meta({ id: "Staff" });

export const setupStep = z.enum(SETUP_STEPS);
export const setupStatus = z.object({ required: z.boolean(), step: z.union([z.literal("token"), setupStep]) }).meta({ id: "SetupStatus" });

const storageActive = z.object({ provider: z.string(), mode: providerMode });
export const settingsView = z
  .object({
    storage: storageActive,
    email: storageActive.nullable(),
    paymentsMode: providerMode,
    consentBanner: z.boolean(),
    shipping: z.object({
      zoneName: z.string(),
      countries: z.array(z.string()),
      rateName: z.string(),
      rateAmount: z.number().int(),
      freeOver: z.number().int().nullable(),
    }),
    tax: z.object({
      mode: z.enum(["india_gst", "generic"]),
      pricesIncludeTax: z.boolean(),
      defaultRateBps: z.number().int(),
      gstin: z.string().optional(),
      registeredState: z.string().optional(),
      label: z.string().optional(),
    }),
  })
  .meta({ id: "Settings" });

export const wizardState = z
  .object({
    storeId: z.uuid(),
    currentStep: setupStep,
    completedSteps: z.array(setupStep),
    owner: z.object({ id: z.uuid(), name: z.string(), email: z.string(), totpEnabled: z.boolean() }).nullable(),
    store: storeView,
    credentials: z.array(credentialSummary),
    settings: settingsView,
    shipFrom: z.object({ name: z.string(), address }).nullable(),
    providers: z.array(providerDescriptor),
  })
  .meta({ id: "WizardState" });

export const loginResponse = z
  .discriminatedUnion("status", [
    z.object({ status: z.literal("ok"), staff: staffView, csrf: z.string() }),
    z.object({ status: z.literal("totp_required"), challenge: z.string() }),
  ])
  .meta({ id: "LoginResponse" });

export const totpEnrollment = z.object({ secret: z.string(), otpauthUrl: z.string() }).meta({ id: "TotpEnrollment" });

export const auditEntry = z
  .object({
    id: z.uuid(),
    actorType: z.string(),
    actorId: z.uuid().nullable(),
    action: z.string(),
    resourceType: z.string().nullable(),
    resourceId: z.string().nullable(),
    ip: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()),
    createdAt: z.string(),
  })
  .meta({ id: "AuditEntry" });

export const meResponse = z
  .object({ staff: staffView, store: storeView, csrf: z.string(), permissions: z.array(z.enum([...PERMISSIONS, "*"])) })
  .meta({ id: "Me" });

export const credentialBody = z.object({
  config: z.record(z.string(), z.unknown()).default({}),
  secrets: z.record(z.string(), z.unknown()).default({}).describe("Write-only. Empty fields keep the saved value."),
  enabled: z.boolean().default(true),
});

export const storefrontStore = z
  .object({
    setupRequired: z.boolean(),
    store: z
      .object({
        name: z.string(),
        logoUrl: z.string().nullable(),
        faviconUrl: z.string().nullable(),
        brand: z.object({ primaryColor: z.string().optional(), accentColor: z.string().optional() }),
        currency: z.string().nullable(),
        locale: z.string().nullable(),
      })
      .nullable(),
  })
  .meta({ id: "StorefrontStore" });

export const errorResponses = {
  400: errorBody,
  401: errorBody,
  403: errorBody,
  404: errorBody,
  409: errorBody,
  410: errorBody,
  422: errorBody,
  423: errorBody,
  429: errorBody,
  502: errorBody,
};
