"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { Schemas } from "@shopkit/sdk";
import { formatMoney } from "@/lib";
import { ShopError, sf, type Customer } from "@/lib/shop-client";

type Orders = Schemas["AccountOrders"];

/** Customer accounts: email code (default) or password sign-in, orders, addresses, consent. */
export function AccountPage({ locale }: { locale: string }) {
  const [customer, setCustomer] = useState<Customer | null | undefined>(undefined);
  const [orders, setOrders] = useState<Orders["items"]>([]);

  async function load() {
    try {
      const c = await sf<Customer>("GET", "/account");
      setCustomer(c);
      setOrders((await sf<Orders>("GET", "/account/orders")).items);
    } catch (e) {
      if (e instanceof ShopError && e.status === 401) setCustomer(null);
      else throw e;
    }
  }
  useEffect(() => {
    void load();
  }, []);

  if (customer === undefined) return <p className="text-muted-foreground">Loading…</p>;
  if (customer === null) return <SignIn onSignedIn={() => void load()} />;
  return <Dashboard customer={customer} orders={orders} locale={locale} onChange={setCustomer} onSignOut={() => setCustomer(null)} />;
}

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<"otp" | "password">("otp");
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [register, setRegister] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [passwordAllowed, setPasswordAllowed] = useState(false);

  useEffect(() => {
    sf<{ customerAuth: "otp" | "password" }>("GET", "/account/config")
      .then((c) => {
        setPasswordAllowed(c.customerAuth === "password");
        if (c.customerAuth === "password") setMode("password");
      })
      .catch(() => undefined);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "otp" && step === "email") {
        await sf("POST", "/account/otp", { email });
        setStep("code");
      } else if (mode === "otp") {
        await sf("POST", "/account/otp/verify", { email, code });
        onSignedIn();
      } else {
        await sf("POST", register ? "/account/register" : "/account/login", { email, password });
        onSignedIn();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mx-auto grid max-w-sm gap-4">
      <h1 className="text-2xl font-semibold">{register ? "Create an account" : "Sign in"}</h1>
      <label className="grid gap-1 text-sm">
        Email
        <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={step === "code"} className="h-10 rounded-md border border-input bg-background px-3" />
      </label>
      {mode === "otp" && step === "code" ? (
        <label className="grid gap-1 text-sm">
          6-digit code
          <input inputMode="numeric" pattern="\d{6}" required autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} className="h-10 rounded-md border border-input bg-background px-3 tracking-widest" />
          <span className="text-muted-foreground">We emailed a code to {email}.</span>
        </label>
      ) : null}
      {mode === "password" ? (
        <label className="grid gap-1 text-sm">
          Password
          <input type="password" required autoComplete={register ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} className="h-10 rounded-md border border-input bg-background px-3" />
        </label>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
      <button type="submit" disabled={busy} className="h-11 rounded-md bg-primary font-medium text-primary-foreground disabled:opacity-50">
        {mode === "otp" ? (step === "email" ? "Email me a code" : "Sign in") : register ? "Create account" : "Sign in"}
      </button>
      {passwordAllowed ? (
        <div className="flex justify-between text-sm">
          <button type="button" className="underline" onClick={() => (setMode(mode === "otp" ? "password" : "otp"), setStep("email"))}>
            {mode === "otp" ? "Use a password" : "Email me a code instead"}
          </button>
          {mode === "password" ? (
            <button type="button" className="underline" onClick={() => setRegister(!register)}>
              {register ? "I have an account" : "Create an account"}
            </button>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

function Dashboard({
  customer,
  orders,
  locale,
  onChange,
  onSignOut,
}: {
  customer: Customer;
  orders: Orders["items"];
  locale: string;
  onChange: (c: Customer) => void;
  onSignOut: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = (s: string) => s.replace(/_/g, " ");

  async function act(fn: () => Promise<Customer>) {
    setError(null);
    try {
      onChange(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    }
  }

  return (
    <div className="grid gap-10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Your account</h1>
          <p className="text-muted-foreground">{customer.email}</p>
        </div>
        <button type="button" className="text-sm underline" onClick={() => void sf("POST", "/account/logout").then(onSignOut)}>
          Sign out
        </button>
      </div>

      <section className="grid gap-3" aria-labelledby="orders-h">
        <h2 id="orders-h" className="text-lg font-semibold">
          Orders
        </h2>
        {orders.length === 0 ? (
          <p className="text-sm text-muted-foreground">No orders yet.</p>
        ) : (
          <ul className="divide-y divide-border border-y border-border">
            {orders.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <Link href={`/account/orders/${o.id}`} className="font-medium underline">
                  {o.name}
                </Link>
                <span className="text-muted-foreground">{new Date(o.placedAt).toLocaleDateString(locale)}</span>
                <span className="capitalize">{label(o.financialStatus)}</span>
                <span>{formatMoney(o.total, o.currency, locale)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="grid gap-3" aria-labelledby="addr-h">
        <h2 id="addr-h" className="text-lg font-semibold">
          Addresses
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          {customer.addresses.map((a) => (
            <li key={a.id} className="rounded-md border border-input p-3 text-sm">
              <p className="whitespace-pre-line">
                {[[a.firstName, a.lastName].filter(Boolean).join(" "), a.line1, a.line2, [a.city, a.province, a.postalCode].filter(Boolean).join(", "), a.country].filter(Boolean).join("\n")}
              </p>
              <div className="mt-2 flex gap-3">
                {a.isDefault ? <span className="text-muted-foreground">Default</span> : null}
                <button type="button" className="underline" onClick={() => void act(() => sf<Customer>("DELETE", `/account/addresses/${a.id}`))}>
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
        {adding ? (
          <form
            className="grid gap-2 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const v = (k: string) => {
                const x = f.get(k);
                return typeof x === "string" ? x : "";
              };
              void act(() =>
                sf<Customer>("POST", "/account/addresses", {
                  firstName: v("firstName"),
                  lastName: v("lastName"),
                  line1: v("line1"),
                  line2: v("line2"),
                  city: v("city"),
                  province: v("province"),
                  postalCode: v("postalCode"),
                  country: v("country"),
                  phone: v("phone"),
                }),
              ).then(() => setAdding(false));
            }}
          >
            {[
              ["firstName", "First name"],
              ["lastName", "Last name"],
              ["line1", "Address"],
              ["line2", "Apartment (optional)"],
              ["city", "City"],
              ["province", "State"],
              ["postalCode", "Postal code"],
              ["country", "Country code"],
              ["phone", "Phone"],
            ].map(([name, text]) => (
              <label key={name} className="grid gap-1 text-sm">
                {text}
                <input name={name} defaultValue={name === "country" ? "IN" : ""} required={name === "line1" || name === "city" || name === "country"} className="h-9 rounded-md border border-input bg-background px-3" />
              </label>
            ))}
            <div className="flex gap-2 sm:col-span-2">
              <button type="submit" className="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground">
                Save address
              </button>
              <button type="button" className="h-9 px-3 text-sm underline" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button type="button" className="justify-self-start text-sm underline" onClick={() => setAdding(true)}>
            Add an address
          </button>
        )}
      </section>

      <section className="grid gap-2" aria-labelledby="prefs-h">
        <h2 id="prefs-h" className="text-lg font-semibold">
          Preferences
        </h2>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={customer.marketingConsent} onChange={(e) => void act(() => sf<Customer>("PATCH", "/account", { marketingConsent: e.target.checked }))} />
          Email me with news and offers
        </label>
      </section>
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
