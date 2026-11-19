"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { sf, type Checkout, type VerifyResult } from "@/lib/shop-client";

/**
 * Fast path (SPEC §7 step 3): sends the provider's return parameters to the API for verification.
 * If the provider has not confirmed yet, polls the checkout until the webhook places the order.
 */
export function ReturnVerifier({ params }: { params: Record<string, string> }) {
  const router = useRouter();
  const [message, setMessage] = useState("Confirming your payment…");
  const [failed, setFailed] = useState(false);
  const checkoutId = params.checkout;

  useEffect(() => {
    if (!checkoutId) {
      setMessage("This payment link is incomplete.");
      setFailed(true);
      return;
    }
    if (params.cancelled) {
      router.replace(`/checkout?id=${checkoutId}&error=${encodeURIComponent("Payment was cancelled")}`);
      return;
    }
    let stop = false;
    void (async () => {
      try {
        const { checkout: _c, provider: _p, ...payload } = params;
        const r = await sf<VerifyResult>("POST", `/checkouts/${checkoutId}/verify`, { payload });
        if (r.status === "paid" && r.orderStatusToken) return router.replace(`/orders/${r.orderStatusToken}?new=1`);
        if (r.status === "failed") {
          router.replace(`/checkout?id=${checkoutId}&error=${encodeURIComponent(r.message ?? "Payment failed")}`);
          return;
        }
      } catch (e) {
        setMessage(e instanceof Error ? e.message : "We couldn't confirm the payment yet.");
      }
      for (let i = 0; i < 20 && !stop; i++) {
        await new Promise((res) => setTimeout(res, 2000));
        const v = await sf<Checkout>("GET", `/checkouts/${checkoutId}`).catch(() => null);
        if (v?.orderStatusToken) return router.replace(`/orders/${v.orderStatusToken}?new=1`);
      }
      if (!stop) {
        setMessage("We haven't received confirmation from the payment provider yet. If you were charged, your order will appear in your email shortly.");
        setFailed(true);
      }
    })();
    return () => {
      stop = true;
    };
  }, [checkoutId, params, router]);

  return (
    <div className="grid gap-4" role="status">
      <h1 className="text-2xl font-semibold">{failed ? "Payment not confirmed" : "One moment"}</h1>
      <p className="text-muted-foreground">{message}</p>
      {failed ? (
        <Link href={checkoutId ? `/checkout?id=${checkoutId}` : "/cart"} className="underline">
          Back to checkout
        </Link>
      ) : null}
    </div>
  );
}
