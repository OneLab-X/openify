"use client";
import { loadScript } from "@/lib/shop-client";

/** Thin typings for the provider scripts the checkout loads at runtime (no npm SDKs). */
interface RazorpayInstance {
  open(): void;
  on(event: "payment.failed", cb: (r: { error?: { description?: string } }) => void): void;
}
interface StripeElements {
  create(type: "payment"): { mount(el: string | HTMLElement): void };
}
interface StripeInstance {
  elements(opts: { clientSecret: string }): StripeElements;
  confirmPayment(opts: { elements: StripeElements; confirmParams: { return_url: string } }): Promise<{ error?: { message?: string } }>;
}
declare global {
  interface Window {
    Razorpay?: new (opts: Record<string, unknown>) => RazorpayInstance;
    Stripe?: (key: string) => StripeInstance;
    Cashfree?: (opts: { mode: string }) => { checkout(opts: { paymentSessionId: string; redirectTarget: string }): Promise<unknown> };
  }
}

export type WidgetOutcome = { kind: "return"; payload: Record<string, unknown> } | { kind: "dismissed"; error?: string };

/** Razorpay Standard Checkout: resolves with the signed return payload or a dismissal. */
export async function openRazorpay(p: Record<string, unknown>, shopName: string): Promise<WidgetOutcome> {
  await loadScript(String(p.scriptUrl));
  if (!window.Razorpay) throw new Error("Razorpay did not load");
  return new Promise((resolve) => {
    const rzp = new window.Razorpay!({
      key: p.keyId,
      order_id: p.orderId,
      amount: p.amount,
      currency: p.currency,
      name: shopName,
      prefill: p.prefill,
      notes: p.notes,
      handler: (resp: Record<string, unknown>) => resolve({ kind: "return", payload: resp }),
      modal: { ondismiss: () => resolve({ kind: "dismissed" }) },
    });
    rzp.on("payment.failed", (r) => resolve({ kind: "dismissed", error: r.error?.description ?? "Payment failed" }));
    rzp.open();
  });
}

/** Stripe Payment Element: mounts into `el`; `confirm` redirects to the return URL on success. */
export async function mountStripe(p: Record<string, unknown>, el: HTMLElement) {
  await loadScript(String(p.scriptUrl));
  if (!window.Stripe) throw new Error("Stripe did not load");
  const stripe = window.Stripe(String(p.publishableKey));
  const elements = stripe.elements({ clientSecret: String(p.clientSecret) });
  elements.create("payment").mount(el);
  return async () => {
    const result = await stripe.confirmPayment({ elements, confirmParams: { return_url: String(p.returnUrl) } });
    return result.error?.message ?? null;
  };
}

/** Cashfree JS checkout (redirects back to our return URL). */
export async function openCashfree(p: Record<string, unknown>) {
  await loadScript(String(p.scriptUrl));
  if (!window.Cashfree) throw new Error("Cashfree did not load");
  await window.Cashfree({ mode: String(p.mode) }).checkout({ paymentSessionId: String(p.paymentSessionId), redirectTarget: "_self" });
}
