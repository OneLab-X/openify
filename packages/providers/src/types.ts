import type { Readable } from "node:stream";
import type { z } from "zod";

export const PROVIDER_KINDS = ["payment", "storage", "email", "analytics", "shipping"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];
export const PROVIDER_MODES = ["test", "live"] as const;
export type ProviderMode = (typeof PROVIDER_MODES)[number];

export type TestResult = { ok: true; message?: string } | { ok: false; error: string };

/** Server-side runtime facts an adapter may need (never merchant secrets). */
export interface ProviderRuntime {
  /** Public base URL of the shop, e.g. https://shop.example.com */
  publicUrl: string;
  /** Root directory for the local storage provider. */
  dataDir: string;
  /** Secret for signing local media URLs. */
  signingSecret: string;
  /**
   * Local payment sandbox (e2e only). When set, payment adapters in *test* mode call it instead of
   * the provider's sandbox API; live mode never uses it. `publicUrl` is what the browser loads.
   */
  paymentSandbox?: { internalUrl: string; publicUrl: string };
}

export interface ProviderContext<Config, Secrets> {
  storeId: string;
  mode: ProviderMode;
  config: Config;
  secrets: Secrets;
  runtime: ProviderRuntime;
}

export interface ProviderBase {
  testCredentials(): Promise<TestResult>;
}

// ── Payments ────────────────────────────────────────────────────────────────
export interface PaymentSessionInput {
  order: { id: string; number?: string };
  /** Integer minor units, computed server-side. */
  amount: number;
  currency: string;
  customer: { name?: string; email?: string; phone?: string };
  returnUrl: string;
}

export interface PaymentSession {
  providerOrderId: string | null;
  /** What the browser needs to open the provider's widget (never secrets). */
  clientPayload: Record<string, unknown>;
  redirectUrl?: string;
}

export type PaymentStatus =
  | "pending"
  | "authorized"
  | "captured"
  | "failed"
  | "partially_refunded"
  | "refunded";

export interface PaymentResult {
  status: PaymentStatus;
  providerPaymentId: string | null;
  providerOrderId: string | null;
  amount: number;
  amountRefunded: number;
  currency: string;
  method?: string | null;
  errorDescription?: string | null;
  /** Our order id when the provider echoes it back (notes / receipt). */
  orderReference?: string | null;
}

export type NormalizedWebhookType =
  | "payment.authorized"
  | "payment.captured"
  | "payment.failed"
  | "refund.processed"
  | "refund.failed"
  | "unknown";

export interface PaymentWebhookEvent {
  /** Provider's unique event id, used for dedupe. */
  id: string;
  providerType: string;
  type: NormalizedWebhookType;
  payment: PaymentResult | null;
  refund?: { id: string; amount: number; status: string } | null;
  raw: unknown;
}

export interface PaymentTransaction {
  id: string;
  kind: "capture" | "refund";
  status: "pending" | "success" | "failure";
  amount: number;
  currency: string;
}

export class WebhookSignatureError extends Error {
  override name = "WebhookSignatureError";
}

export class ProviderError extends Error {
  override name = "ProviderError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface PaymentProvider extends ProviderBase {
  createSession(input: PaymentSessionInput): Promise<PaymentSession>;
  verifyReturn(payload: Record<string, unknown>): Promise<PaymentResult>;
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<PaymentWebhookEvent>;
  capture?(paymentId: string, amount: number, currency: string): Promise<PaymentTransaction>;
  /** `idempotencyKey` (our refund id) makes a retried refund safe at providers that support it. */
  refund(paymentId: string, amount: number, reason?: string, idempotencyKey?: string): Promise<PaymentTransaction>;
  getPayment(paymentId: string): Promise<PaymentResult>;
}

// ── Storage ─────────────────────────────────────────────────────────────────
export interface PutOptions {
  contentType: string;
  cacheControl?: string;
}

export interface StoredObject {
  body: Readable;
  contentType?: string;
  contentLength?: number;
}

export interface UploadTarget {
  url: string;
  method: "PUT";
  /** Headers the browser must send with the PUT (they are part of the signature). */
  headers: Record<string, string>;
}

export interface StorageProvider extends ProviderBase {
  put(key: string, body: Buffer | Readable, opts: PutOptions): Promise<void>;
  getSignedUrl(key: string, opts: { expiresIn: number }): Promise<string>;
  /** Direct public URL, or null when the object must be served through the /media proxy. */
  publicUrl(key: string): string | null;
  /** Streams an object (used by the /media proxy). Addition to SPEC §7; see DECISIONS.md. */
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): AsyncIterable<string>;
  /**
   * Presigned direct-to-storage upload, when the backend supports it (addition to SPEC §7; see
   * DECISIONS.md). Without it, uploads go through the API.
   */
  createUploadUrl?(key: string, opts: { contentType: string; cacheControl?: string; expiresIn: number }): Promise<UploadTarget>;
}

// ── Email ───────────────────────────────────────────────────────────────────
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  idempotencyKey: string;
}

export interface EmailProvider extends ProviderBase {
  send(msg: EmailMessage): Promise<{ id: string }>;
}

// ── Analytics ───────────────────────────────────────────────────────────────
export interface ClientSnippet {
  head?: string;
  body?: string;
  requiresConsent: boolean;
}

export type ServerEventName = "purchase" | "refund" | "signup";
export interface ServerEventPayload {
  clientId?: string;
  url?: string;
  orderId?: string;
  value?: number;
  currency?: string;
  userAgent?: string;
  ip?: string;
}

export interface AnalyticsProvider extends ProviderBase {
  clientSnippet(): ClientSnippet;
  serverEvent?(event: ServerEventName, payload: ServerEventPayload): Promise<void>;
}

// ── Shipping ────────────────────────────────────────────────────────────────
export interface ShipmentParty {
  name: string;
  company?: string | null;
  phone?: string | null;
  email?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  province?: string | null;
  postalCode: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
}

export interface ShipmentParcel {
  weightGrams: number;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
}

export interface RateRequest {
  from: ShipmentParty;
  to: ShipmentParty;
  parcel: ShipmentParcel;
  /** Declared value in minor units of `currency`. */
  declaredValue: number;
  currency: string;
  /** Cash on delivery amount to collect (minor units), if any. */
  codAmount?: number | null;
}

export interface ShippingRate {
  id: string;
  name: string;
  /** Minor units of `currency`. */
  amount: number;
  currency: string;
  carrier?: string;
  etaDays?: number;
}

export interface CreateShipmentInput extends RateRequest {
  /** Our fulfillment id (idempotency/reference at the carrier). */
  reference: string;
  orderName: string;
  orderDate: string;
  /** A rate id from `rates()`; adapters pick the cheapest when omitted. */
  rateId?: string | null;
  items: { name: string; sku?: string | null; quantity: number; unitPrice: number; hsnCode?: string | null }[];
}

export interface ShipmentResult {
  shipmentId: string;
  awb: string;
  carrier?: string;
  labelUrl?: string | null;
  trackingUrl?: string | null;
}

export type TrackingState = "pending" | "in_transit" | "out_for_delivery" | "delivered" | "failed" | "returned" | "cancelled";

export interface TrackingStatus {
  state: TrackingState;
  description: string;
  events: { at: string; description: string; location?: string | null }[];
}

/** A normalised tracking push from a carrier. `id` dedupes repeats. */
export interface TrackingWebhookEvent {
  id: string;
  awb: string;
  state: TrackingState;
  description: string;
  at: string;
}

export interface ShippingProvider extends ProviderBase {
  rates(request: RateRequest): Promise<ShippingRate[]>;
  createShipment(input: CreateShipmentInput): Promise<ShipmentResult>;
  /** Label PDF URL for a shipment (may be generated on demand). */
  label(shipment: { shipmentId: string; awb: string }): Promise<string | null>;
  track(awb: string): Promise<TrackingStatus>;
  /** Verifies the push (shared token or HMAC on the raw body) and normalises it. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<TrackingWebhookEvent[]>;
  trackingUrl(awb: string): string;
}

export interface ProviderInstances {
  payment: PaymentProvider;
  storage: StorageProvider;
  email: EmailProvider;
  analytics: AnalyticsProvider;
  shipping: ShippingProvider;
}

/** An implemented adapter (SPEC §7). Settings forms are rendered from the two zod schemas. */
// `any` defaults let the registry hold definitions with different config/secret shapes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ProviderDefinition<K extends ProviderKind = ProviderKind, Config = any, Secrets = any> {
  id: string;
  kind: K;
  displayName: string;
  description?: string;
  docsUrl?: string;
  /** Modes the provider supports. Providers without a sandbox only have "live". */
  modes: readonly ProviderMode[];
  configSchema: z.ZodType<Config>;
  secretsSchema: z.ZodType<Secrets>;
  /** Secret field whose last four characters may be shown in the UI. */
  last4Field?: string;
  /** Events to enable in the provider dashboard (payments). */
  webhookEvents?: readonly string[];
  /**
   * Payments: how the shopper pays. `widget` opens the provider's script on our page, `redirect`
   * sends them to the provider and back, `offline` (COD, bank transfer) places the order unpaid.
   */
  paymentFlow?: "widget" | "redirect" | "offline";
  create(ctx: ProviderContext<Config, Secrets>): ProviderInstances[K];
}

export interface ComingSoonProvider {
  id: string;
  kind: ProviderKind;
  displayName: string;
}
