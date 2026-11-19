import { and, eq, locations, setupState, sql, staffUsers, stores, roles, type Executor } from "@shopkit/db";
import type { ProviderKind } from "@shopkit/providers";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { ensureSystemRoles, upsertOwner, type ownerInput } from "../auth/staff.js";
import { listCredentials, testCredential, upsertCredential } from "../credentials.js";
import type { Actor, CoreDeps } from "../deps.js";
import { now } from "../deps.js";
import { AppError } from "../errors.js";
import { enqueueEvent } from "../outbox.js";
import { getSetting, setSetting } from "../settings.js";
import { addressSchema, getInstallStore, storeDetailsSchema, storeView, updateStoreDetails } from "../stores.js";
import { clearSetupTokens } from "./token.js";

export const SETUP_STEPS = ["owner", "storage", "store", "payments", "email", "analytics", "shipping_tax", "review"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export const REQUIRED_STEPS: SetupStep[] = ["owner", "storage", "store"];

export interface SetupStatus {
  required: boolean;
  step: "token" | SetupStep;
}

export async function getSetupStatus(deps: CoreDeps): Promise<SetupStatus> {
  const store = await getInstallStore(deps.db);
  if (!store) return { required: true, step: "token" };
  if (store.status === "active") return { required: false, step: "review" };
  const [state] = await deps.db.select().from(setupState).where(eq(setupState.storeId, store.id));
  return { required: true, step: (state?.currentStep as SetupStep | undefined) ?? "owner" };
}

/** Creates the store (status `setup`) and wizard state the first time a valid token is presented. */
export async function beginSetup(deps: CoreDeps): Promise<string> {
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(727275)`);
    const existing = await getInstallStore(tx);
    if (existing) {
      if (existing.status === "active") throw new AppError("setup_complete", "Setup is already complete");
      return existing.id;
    }
    const [store] = await tx.insert(stores).values({ status: "setup" }).returning();
    await tx.insert(setupState).values({ storeId: store!.id, currentStep: "owner" });
    await ensureSystemRoles(tx, store!.id);
    await writeAudit(tx, { type: "setup" }, { storeId: store!.id, action: "setup.started" });
    return store!.id;
  });
}

/** The store being set up; throws once setup is complete so setup endpoints stop working. */
export async function requireSetupStore(deps: CoreDeps): Promise<string> {
  const store = await getInstallStore(deps.db);
  if (!store) throw new AppError("setup_required", "Enter the setup token first");
  if (store.status === "active") throw new AppError("setup_complete", "Setup is already complete");
  return store.id;
}

async function completeStep(tx: Executor, storeId: string, step: SetupStep, data?: unknown) {
  const [state] = await tx.select().from(setupState).where(eq(setupState.storeId, storeId));
  const completed = new Set(state?.completedSteps ?? []);
  completed.add(step);
  const next = SETUP_STEPS.find((s) => !completed.has(s)) ?? "review";
  await tx
    .update(setupState)
    .set({
      completedSteps: SETUP_STEPS.filter((s) => completed.has(s)),
      currentStep: next,
      data: { ...(state?.data ?? {}), ...(data !== undefined ? { [step]: data } : {}) },
    })
    .where(eq(setupState.storeId, storeId));
}

async function ownerOf(db: Executor, storeId: string) {
  const [row] = await db
    .select({ staff: staffUsers })
    .from(staffUsers)
    .innerJoin(roles, eq(roles.id, staffUsers.roleId))
    .where(and(eq(staffUsers.storeId, storeId), eq(roles.key, "owner")));
  return row?.staff ?? null;
}

export async function getWizardState(deps: CoreDeps) {
  const storeId = await requireSetupStore(deps);
  const [state] = await deps.db.select().from(setupState).where(eq(setupState.storeId, storeId));
  const store = await storeView(deps, (await getInstallStore(deps.db))!);
  const owner = await ownerOf(deps.db, storeId);
  const credentials = await listCredentials(deps, storeId);
  const [shipFrom] = await deps.db.select().from(locations).where(and(eq(locations.storeId, storeId), eq(locations.isDefault, true)));
  return {
    storeId,
    currentStep: (state?.currentStep ?? "owner") as SetupStep,
    completedSteps: (state?.completedSteps ?? []) as SetupStep[],
    owner: owner ? { id: owner.id, name: owner.name, email: owner.email, totpEnabled: owner.totpEnabled } : null,
    store,
    credentials,
    settings: {
      storage: await getSetting(deps.db, storeId, "storage.active"),
      email: await getSetting(deps.db, storeId, "email.active"),
      paymentsMode: await getSetting(deps.db, storeId, "payments.mode"),
      consentBanner: await getSetting(deps.db, storeId, "analytics.consentBanner"),
      shipping: await getSetting(deps.db, storeId, "shipping.defaults"),
      tax: await getSetting(deps.db, storeId, "tax.config"),
    },
    shipFrom: shipFrom ? { name: shipFrom.name, address: shipFrom.address } : null,
    providers: deps.registry.describe(),
  };
}
export type WizardState = Awaited<ReturnType<typeof getWizardState>>;

const SETUP_ACTOR = (actor: Actor): Actor => ({ ...actor, type: "setup" });

export async function saveOwnerStep(deps: CoreDeps, actor: Actor, input: z.input<typeof ownerInput>) {
  const storeId = await requireSetupStore(deps);
  return deps.db.transaction(async (tx) => {
    const staffId = await upsertOwner(deps, SETUP_ACTOR(actor), storeId, input, tx);
    await completeStep(tx, storeId, "owner");
    return { staffId };
  });
}

export async function ownerStaffId(deps: CoreDeps): Promise<string> {
  const storeId = await requireSetupStore(deps);
  const owner = await ownerOf(deps.db, storeId);
  if (!owner) throw new AppError("bad_request", "Create the owner account first");
  return owner.id;
}

export const credentialStepInput = z.object({
  provider: z.string().min(1),
  mode: z.enum(["test", "live"]),
  config: z.record(z.string(), z.unknown()).default({}),
  secrets: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
});

/** Storage must pass "Test connection" before it is saved: the logo upload depends on it. */
export async function saveStorageStep(deps: CoreDeps, actor: Actor, input: z.input<typeof credentialStepInput>) {
  const storeId = await requireSetupStore(deps);
  const body = credentialStepInput.parse(input);
  const target = { storeId, kind: "storage" as const, provider: body.provider, mode: body.mode };
  const result = await testCredential(deps, target, body);
  if (!result.ok) throw new AppError("provider_error", result.error);
  return deps.db.transaction(async (tx) => {
    const summary = await upsertCredential(deps, SETUP_ACTOR(actor), target, { ...body, enabled: true }, tx);
    await setSetting(tx, storeId, "storage.active", { provider: body.provider, mode: body.mode });
    await completeStep(tx, storeId, "storage");
    return summary;
  });
}

export async function saveSetupCredential(
  deps: CoreDeps,
  actor: Actor,
  kind: Exclude<ProviderKind, "storage" | "shipping">,
  input: z.input<typeof credentialStepInput>,
) {
  const storeId = await requireSetupStore(deps);
  const { provider, mode, ...rest } = credentialStepInput.parse(input);
  return upsertCredential(deps, SETUP_ACTOR(actor), { storeId, kind, provider, mode }, rest);
}

export async function testSetupCredential(deps: CoreDeps, kind: ProviderKind, input: z.input<typeof credentialStepInput>) {
  const storeId = await requireSetupStore(deps);
  const { provider, mode, ...rest } = credentialStepInput.parse(input);
  return testCredential(deps, { storeId, kind, provider, mode }, rest);
}

export async function saveStoreStep(deps: CoreDeps, actor: Actor, input: z.input<typeof storeDetailsSchema>) {
  const storeId = await requireSetupStore(deps);
  const details = storeDetailsSchema.parse(input);
  await deps.db.transaction(async (tx) => {
    await updateStoreDetails(tx, storeId, details);
    await writeAudit(tx, SETUP_ACTOR(actor), { storeId, action: "store.details_updated", resourceType: "store", resourceId: storeId });
    await completeStep(tx, storeId, "store");
  });
}

export const paymentsStepInput = z.object({ mode: z.enum(["test", "live"]) });
export const emailStepInput = z.object({ provider: z.string().nullable(), mode: z.enum(["test", "live"]).default("live") });
export const analyticsStepInput = z.object({ consentBanner: z.boolean() });

export async function completeOptionalStep(
  deps: CoreDeps,
  step: "payments" | "email" | "analytics",
  input: unknown,
  skip: boolean,
) {
  const storeId = await requireSetupStore(deps);
  await deps.db.transaction(async (tx) => {
    if (!skip) {
      if (step === "payments") await setSetting(tx, storeId, "payments.mode", paymentsStepInput.parse(input).mode);
      if (step === "email") {
        const { provider, mode } = emailStepInput.parse(input);
        if (provider) {
          const configured = (await listCredentials(deps, storeId, "email")).some((c) => c.provider === provider && c.mode === mode);
          if (!configured) throw new AppError("validation_failed", "Save the email provider before selecting it");
        }
        await setSetting(tx, storeId, "email.active", provider ? { provider, mode: mode } : null);
      }
      if (step === "analytics") await setSetting(tx, storeId, "analytics.consentBanner", analyticsStepInput.parse(input).consentBanner);
    }
    await completeStep(tx, storeId, step, { skipped: skip });
  });
}

export const shippingTaxInput = z.object({
  shipFrom: z.object({ name: z.string().trim().min(1).max(120), address: addressSchema }),
  zone: z.object({ name: z.string().trim().min(1).max(80), countries: z.array(z.string().length(2).toUpperCase()).min(1) }),
  rate: z.object({
    name: z.string().trim().min(1).max(80),
    amount: z.number().int().min(0),
    freeOver: z.number().int().min(0).nullable().default(null),
  }),
  tax: z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("india_gst"),
      defaultRateBps: z.number().int().min(0).max(10_000).default(1800),
      gstin: z.string().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "GSTIN must be 15 characters").optional(),
      registeredState: z.string().max(60).optional(),
    }),
    z.object({
      mode: z.literal("generic"),
      pricesIncludeTax: z.boolean(),
      defaultRateBps: z.number().int().min(0).max(10_000),
      label: z.string().max(30).default("Tax"),
    }),
  ]),
});

export async function saveShippingTaxStep(deps: CoreDeps, actor: Actor, input: z.input<typeof shippingTaxInput>, skip = false) {
  const storeId = await requireSetupStore(deps);
  await deps.db.transaction(async (tx) => {
    if (!skip) {
      const body = shippingTaxInput.parse(input);
      // Update in place: inventory levels reference the location (deleting it would drop stock).
      const [current] = await tx.select({ id: locations.id }).from(locations).where(and(eq(locations.storeId, storeId), eq(locations.isDefault, true)));
      if (current) await tx.update(locations).set({ name: body.shipFrom.name, address: body.shipFrom.address }).where(eq(locations.id, current.id));
      else await tx.insert(locations).values({ storeId, name: body.shipFrom.name, address: body.shipFrom.address, isDefault: true });
      await setSetting(tx, storeId, "shipping.defaults", {
        zoneName: body.zone.name,
        countries: body.zone.countries,
        rateName: body.rate.name,
        rateAmount: body.rate.amount,
        freeOver: body.rate.freeOver,
      });
      await setSetting(
        tx,
        storeId,
        "tax.config",
        body.tax.mode === "india_gst"
          ? { mode: "india_gst", pricesIncludeTax: true, defaultRateBps: body.tax.defaultRateBps, label: "GST",
              ...(body.tax.gstin ? { gstin: body.tax.gstin } : {}),
              ...(body.tax.registeredState ? { registeredState: body.tax.registeredState } : {}) }
          : body.tax,
      );
      await writeAudit(tx, SETUP_ACTOR(actor), { storeId, action: "settings.shipping_tax_updated" });
    }
    await completeStep(tx, storeId, "shipping_tax", { skipped: skip });
  });
}

/** Step 8: activates the store, deletes setup tokens and returns the owner to sign in. */
export async function launchStore(deps: CoreDeps, actor: Actor): Promise<{ storeId: string; ownerId: string }> {
  const storeId = await requireSetupStore(deps);
  const result = await deps.db.transaction(async (tx) => {
    const [state] = await tx.select().from(setupState).where(eq(setupState.storeId, storeId)).for("update");
    const missing = REQUIRED_STEPS.filter((s) => !state?.completedSteps.includes(s));
    if (missing.length) throw new AppError("validation_failed", `Finish these steps first: ${missing.join(", ")}`, { missing });
    const owner = await ownerOf(tx, storeId);
    if (!owner) throw new AppError("validation_failed", "Create the owner account first");
    const at = now(deps);
    await tx.update(stores).set({ status: "active", launchedAt: at }).where(eq(stores.id, storeId));
    await tx.update(setupState).set({ completedAt: at, currentStep: "review", completedSteps: [...SETUP_STEPS] }).where(eq(setupState.storeId, storeId));
    await enqueueEvent(tx, { storeId, type: "store.launched", payload: { ownerId: owner.id } });
    await writeAudit(tx, SETUP_ACTOR(actor), { storeId, action: "store.launched", resourceType: "store", resourceId: storeId });
    return { storeId, ownerId: owner.id };
  });
  await clearSetupTokens(deps.redis);
  return result;
}

