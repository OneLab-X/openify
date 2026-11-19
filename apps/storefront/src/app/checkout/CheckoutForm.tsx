"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { formatMoney } from "@/lib";
import { sf, type Checkout, type MailingAddress, type PaymentSession, type VerifyResult } from "@/lib/shop-client";
import { mountStripe, openCashfree, openRazorpay } from "./widgets";

type Address = { firstName: string; lastName: string; line1: string; line2: string; city: string; province: string; postalCode: string; country: string; phone: string };
const EMPTY: Address = { firstName: "", lastName: "", line1: "", line2: "", city: "", province: "", postalCode: "", country: "IN", phone: "" };
const fromView = (a: MailingAddress | null | undefined): Address => ({
  firstName: a?.firstName ?? "",
  lastName: a?.lastName ?? "",
  line1: a?.line1 ?? "",
  line2: a?.line2 ?? "",
  city: a?.city ?? "",
  province: a?.province ?? "",
  postalCode: a?.postalCode ?? "",
  country: a?.country ?? "IN",
  phone: a?.phone ?? "",
});
const complete = (a: Address) => !!(a.line1.trim() && a.city.trim() && a.country.trim().length === 2);

/**
 * One-page checkout (Phase 3 item 2): contact → shipping address → shipping rate → payment. Every
 * change is saved and re-priced by the server; the page only ever displays the server's totals.
 */
export function CheckoutForm({ checkoutId, shopName, locale, initialError }: { checkoutId: string | null; shopName: string; locale: string; initialError: string | null }) {
  const router = useRouter();
  const [id, setId] = useState(checkoutId);
  const [view, setView] = useState<Checkout | null>(null);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [address, setAddress] = useState<Address>(EMPTY);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);
  const [stripeConfirm, setStripeConfirm] = useState<(() => Promise<string | null>) | null>(null);
  const stripeRef = useRef<HTMLDivElement>(null);

  function absorb(v: Checkout) {
    setView(v);
    if (v.status === "completed" && v.orderStatusToken) router.replace(`/orders/${v.orderStatusToken}?new=1`);
  }

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        let cid = id;
        if (!cid) {
          cid = (await sf<{ checkoutId: string }>("POST", "/checkout")).checkoutId;
          if (!alive) return;
          setId(cid);
          router.replace(`/checkout?id=${cid}`);
        }
        const v = await sf<Checkout>("GET", `/checkouts/${cid}`);
        if (!alive) return;
        absorb(v);
        setEmail(v.email ?? "");
        setPhone(v.phone ?? "");
        setConsent(v.marketingConsent);
        setAddress(fromView(v.shippingAddress));
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "Could not load checkout");
      }
    })();
    return () => {
      alive = false;
    };
    // Load once; later changes go through save().
  }, []);

  async function save(patch: Record<string, unknown>) {
    if (!id) return null;
    setError(null);
    try {
      const v = await sf<Checkout>("PATCH", `/checkouts/${id}`, patch);
      absorb(v);
      return v;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
      return null;
    }
  }

  const contactPatch = () => ({ email: email.trim() || null, phone: phone.trim() || null, marketingConsent: consent });
  const addressPatch = () => (complete(address) ? { shippingAddress: { ...address, country: address.country.toUpperCase() } } : {});

  async function verify(payload: Record<string, unknown>) {
    const r = await sf<VerifyResult>("POST", `/checkouts/${id}/verify`, { payload });
    if (r.status === "paid" && r.orderStatusToken) router.push(`/orders/${r.orderStatusToken}?new=1`);
    else setError(r.message ?? "We're still waiting for the payment to be confirmed.");
  }

  async function pay() {
    if (!id) return;
    setBusy(true);
    setError(null);
    setStripeConfirm(null);
    try {
      const v = await save({ ...contactPatch(), ...addressPatch(), ...(view?.paymentProvider ? { paymentProvider: view.paymentProvider } : {}), ...(view?.shippingRateId ? { shippingRateId: view.shippingRateId } : {}) });
      if (!v) return;
      if (v.missing.length) {
        setError(
          {
            email: "Enter your email",
            phone: "Enter your phone number",
            shipping_address: "Enter your shipping address",
            shipping_rate: "Choose a shipping method",
            payment_method: "Choose a payment method",
          }[v.missing[0]!] ?? "Complete the form",
        );
        return;
      }
      const session = await sf<PaymentSession>("POST", `/checkouts/${id}/payment-session`);
      const p = session.clientPayload;
      if (session.flow === "offline" && session.orderStatusToken) {
        router.push(`/orders/${session.orderStatusToken}?new=1`);
        return;
      }
      if (session.flow === "redirect" && session.redirectUrl) {
        window.location.href = session.redirectUrl;
        return;
      }
      if (p.provider === "razorpay") {
        const outcome = await openRazorpay(p, shopName);
        if (outcome.kind === "return") await verify(outcome.payload);
        else if (outcome.error) setError(outcome.error);
      } else if (p.provider === "stripe") {
        if (!stripeRef.current) return;
        const confirm = await mountStripe(p, stripeRef.current);
        setStripeConfirm(() => confirm);
      } else if (p.provider === "cashfree") {
        await openCashfree(p);
      } else {
        setError("This payment method can't be opened here");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Payment could not start");
    } finally {
      setBusy(false);
    }
  }

  async function confirmStripe() {
    if (!stripeConfirm) return;
    setBusy(true);
    const message = await stripeConfirm();
    if (message) setError(message);
    setBusy(false);
  }

  if (!view) {
    return (
      <p className="text-muted-foreground" role={error ? "alert" : undefined}>
        {error ?? "Loading…"}
        {error ? (
          <>
            {" "}
            <Link href="/cart" className="underline">
              Back to cart
            </Link>
          </>
        ) : null}
      </p>
    );
  }
  const money = (n: number) => formatMoney(n, view.currency, locale);
  const field = (key: keyof Address, label: string, opts: { autoComplete?: string; required?: boolean; half?: boolean } = {}) => (
    <label className={`grid gap-1 text-sm ${opts.half ? "" : "sm:col-span-2"}`}>
      {label}
      <input
        value={address[key]}
        required={opts.required}
        autoComplete={opts.autoComplete}
        onChange={(e) => setAddress({ ...address, [key]: e.target.value })}
        onBlur={() => complete(address) && void save(addressPatch())}
        className="h-10 rounded-md border border-input bg-background px-3"
      />
    </label>
  );

  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_22rem]">
      <form
        className="grid content-start gap-8"
        onSubmit={(e) => {
          e.preventDefault();
          void pay();
        }}
      >
        <section className="grid gap-3" aria-labelledby="contact-h">
          <h2 id="contact-h" className="text-lg font-semibold">
            Contact
          </h2>
          <label className="grid gap-1 text-sm">
            Email
            <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} onBlur={() => void save(contactPatch())} className="h-10 rounded-md border border-input bg-background px-3" />
          </label>
          <label className="grid gap-1 text-sm">
            Phone{view.requirePhone ? "" : " (optional)"}
            <input type="tel" autoComplete="tel" required={view.requirePhone} value={phone} onChange={(e) => setPhone(e.target.value)} onBlur={() => void save(contactPatch())} className="h-10 rounded-md border border-input bg-background px-3" />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => {
                setConsent(e.target.checked);
                void save({ marketingConsent: e.target.checked });
              }}
            />
            Email me with news and offers
          </label>
        </section>

        {view.shippingRequired ? (
          <section className="grid gap-3" aria-labelledby="ship-h">
            <h2 id="ship-h" className="text-lg font-semibold">
              Shipping address
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {field("firstName", "First name", { autoComplete: "given-name", half: true })}
              {field("lastName", "Last name", { autoComplete: "family-name", half: true })}
              {field("line1", "Address", { autoComplete: "address-line1", required: true })}
              {field("line2", "Apartment, suite (optional)", { autoComplete: "address-line2" })}
              {field("city", "City", { autoComplete: "address-level2", required: true, half: true })}
              {field("province", "State / province", { autoComplete: "address-level1", half: true })}
              {field("postalCode", "Postal code", { autoComplete: "postal-code", half: true })}
              {field("country", "Country code", { autoComplete: "country", required: true, half: true })}
            </div>
          </section>
        ) : null}

        {view.shippingRequired ? (
          <section className="grid gap-2" aria-labelledby="rate-h">
            <h2 id="rate-h" className="text-lg font-semibold">
              Shipping method
            </h2>
            {view.shippingRates.length === 0 ? (
              <p className="text-sm text-muted-foreground">{view.shippingAddress ? "No shipping methods for this address." : "Enter your address to see shipping methods."}</p>
            ) : (
              view.shippingRates.map((r) => (
                <label key={r.id} className="flex items-center justify-between rounded-md border border-input px-3 py-2 text-sm">
                  <span className="flex items-center gap-2">
                    <input type="radio" name="rate" checked={view.shippingRateId === r.id} onChange={() => {
                      setView({ ...view, shippingRateId: r.id });
                      void save({ shippingRateId: r.id });
                    }} />
                    {r.title}
                  </span>
                  <span>{r.amount === 0 ? "Free" : money(r.amount)}</span>
                </label>
              ))
            )}
          </section>
        ) : null}

        <section className="grid gap-2" aria-labelledby="pay-h">
          <h2 id="pay-h" className="text-lg font-semibold">
            Payment
          </h2>
          {view.paymentMethods.length === 0 ? <p className="text-sm text-red-700">This shop has no payment methods set up yet.</p> : null}
          {view.paymentMethods.map((m) => (
            <label key={m.id} className="flex items-center gap-2 rounded-md border border-input px-3 py-2 text-sm">
              <input type="radio" name="payment" value={m.id} checked={view.paymentProvider === m.id} onChange={() => {
                  setView({ ...view, paymentProvider: m.id });
                  void save({ paymentProvider: m.id });
                }} />
              {m.displayName}
            </label>
          ))}
          <div ref={stripeRef} data-testid="stripe-element" className={stripeConfirm ? "rounded-md border border-input p-3" : ""} />
        </section>

        {error ? (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        ) : null}
        {view.blockers.length ? (
          <ul className="list-disc pl-5 text-sm text-red-700">
            {view.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        ) : null}
        {stripeConfirm ? (
          <button type="button" onClick={() => void confirmStripe()} disabled={busy} className="h-12 rounded-md bg-primary font-medium text-primary-foreground disabled:opacity-50">
            {busy ? "Processing…" : `Pay ${money(view.total)}`}
          </button>
        ) : (
          <button type="submit" disabled={busy || view.paymentMethods.length === 0} className="h-12 rounded-md bg-primary font-medium text-primary-foreground disabled:opacity-50">
            {busy ? "Processing…" : view.paymentMethods.find((m) => m.id === view.paymentProvider)?.flow === "offline" ? "Place order" : `Pay now · ${money(view.total)}`}
          </button>
        )}
      </form>

      <aside className="grid content-start gap-4 rounded-lg bg-muted/40 p-4" aria-label="Order summary">
        <ul className="grid gap-3">
          {view.lines.map((l) => (
            <li key={l.id} className="flex justify-between gap-3 text-sm">
              <span>
                {l.title}
                {l.variantTitle ? <span className="text-muted-foreground"> · {l.variantTitle}</span> : null} × {l.quantity}
                {l.stockIssue ? <span className="block text-red-700">{l.stockIssue}</span> : null}
              </span>
              <span>{money(l.subtotal)}</span>
            </li>
          ))}
        </ul>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save({ discountCode: code });
          }}
        >
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Discount code" aria-label="Discount code" className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm" />
          <button type="submit" disabled={!code.trim()} className="h-9 rounded-md border border-input px-3 text-sm">
            Apply
          </button>
        </form>
        {view.discount.code ? (
          <p className={`text-sm ${view.discount.applied ? "text-green-700" : "text-red-700"}`}>{view.discount.applied ? `${view.discount.code.toUpperCase()} applied` : view.discount.error}</p>
        ) : null}
        <dl className="grid gap-1 text-sm" data-testid="checkout-totals">
          <div className="flex justify-between">
            <dt>Subtotal</dt>
            <dd>{money(view.subtotal)}</dd>
          </div>
          {view.discountTotal ? (
            <div className="flex justify-between text-green-700">
              <dt>Discount</dt>
              <dd>−{money(view.discountTotal)}</dd>
            </div>
          ) : null}
          {view.shippingRequired ? (
            <div className="flex justify-between">
              <dt>Shipping</dt>
              <dd>{view.shippingLine ? (view.shippingTotal === 0 ? "Free" : money(view.shippingTotal)) : "—"}</dd>
            </div>
          ) : null}
          {view.taxLines.map((t) => (
            <div key={`${t.title}-${t.rateBps}`} className="flex justify-between">
              <dt>
                {t.title} {t.rateBps / 100}%{view.taxesIncluded ? " (included)" : ""}
              </dt>
              <dd>{money(t.amount)}</dd>
            </div>
          ))}
          <div className="mt-2 flex justify-between border-t border-border pt-2 text-base font-semibold">
            <dt>Total</dt>
            <dd data-testid="checkout-total">{money(view.total)}</dd>
          </div>
        </dl>
      </aside>
    </div>
  );
}
