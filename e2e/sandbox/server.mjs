// Local payment sandbox for e2e (docker-compose.e2e.yml). It speaks the small part of the Razorpay
// and Stripe APIs that Shopkit's adapters use, serves stand-ins for their browser scripts, and
// sends signed webhooks to the API like the real providers. Test-mode credentials only: the API
// routes test-mode calls here when PAYMENT_SANDBOX_URL is set; live mode never does.
// No dependencies: node:http + node:crypto.
/* global fetch, setTimeout, URLSearchParams */
import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 4200);
const WEBHOOK_TARGET = process.env.WEBHOOK_TARGET ?? "http://api:4000";
const RZP_WEBHOOK_SECRET = process.env.SANDBOX_RAZORPAY_WEBHOOK_SECRET ?? "";
const STRIPE_WEBHOOK_SECRET = process.env.SANDBOX_STRIPE_WEBHOOK_SECRET ?? "";

const id = (prefix) => `${prefix}_${randomBytes(7).toString("hex")}`;
const hmac = (secret, ...parts) => parts.reduce((h, p) => h.update(p), createHmac("sha256", secret)).digest("hex");

const rzp = { orders: new Map(), payments: new Map(), secrets: new Map() };
const stripe = { intents: new Map(), idempotency: new Map(), refunds: [] };
/** Every webhook sent, so tests can replay them. */
const events = [];

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
function basicAuth(req) {
  const h = req.headers.authorization ?? "";
  if (!h.startsWith("Basic ")) return null;
  const [user, pass] = Buffer.from(h.slice(6), "base64").toString().split(":");
  return { user, pass };
}

async function deliver(provider, path, body, headers) {
  events.push({ provider, path, body, headers, at: new Date().toISOString() });
  try {
    const res = await fetch(`${WEBHOOK_TARGET}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
    events.at(-1).status = res.status;
  } catch (err) {
    events.at(-1).status = String(err);
  }
}

// ── Razorpay ──────────────────────────────────────────────────────────────────
function rzpPaymentEvent(event, payment) {
  const body = JSON.stringify({ entity: "event", event, contains: ["payment"], payload: { payment: { entity: payment } }, created_at: Math.floor(Date.now() / 1000) });
  const eventId = id("evt");
  return deliver("razorpay", "/api/webhooks/payments/razorpay", body, { "x-razorpay-signature": hmac(RZP_WEBHOOK_SECRET, body), "x-razorpay-event-id": eventId });
}

async function razorpay(req, res, url, body) {
  const p = url.pathname.replace(/^\/razorpay/, "");
  if (p === "/checkout.js") return send(res, 200, RZP_WIDGET, "application/javascript");
  if (p === "/_pay" && req.method === "POST") {
    const { order_id, outcome } = JSON.parse(body || "{}");
    const order = rzp.orders.get(order_id);
    if (!order) return send(res, 404, { error: { description: "order not found" } });
    const payment = {
      id: id("pay"),
      entity: "payment",
      order_id,
      amount: order.amount,
      amount_refunded: 0,
      currency: order.currency,
      status: outcome === "fail" ? "failed" : "captured",
      method: "card",
      notes: order.notes,
      error_description: outcome === "fail" ? "Payment declined by the sandbox bank" : null,
    };
    rzp.payments.set(payment.id, payment);
    setTimeout(() => void rzpPaymentEvent(outcome === "fail" ? "payment.failed" : "payment.captured", payment), 300);
    if (outcome === "fail") return send(res, 200, { error: { description: payment.error_description } });
    const secret = rzp.secrets.get(order.keyId) ?? "";
    return send(res, 200, { razorpay_order_id: order_id, razorpay_payment_id: payment.id, razorpay_signature: hmac(secret, `${order_id}|${payment.id}`) });
  }
  const auth = basicAuth(req);
  if (!auth?.user?.startsWith("rzp_test_")) return send(res, 401, { error: { description: "Authentication failed" } });
  if (p === "/v1/orders" && req.method === "GET") return send(res, 200, { entity: "collection", count: 0, items: [] });
  if (p === "/v1/orders" && req.method === "POST") {
    rzp.secrets.set(auth.user, auth.pass);
    const input = JSON.parse(body);
    const order = { id: id("order"), entity: "order", amount: input.amount, currency: input.currency, receipt: input.receipt, notes: input.notes ?? {}, status: "created", keyId: auth.user };
    rzp.orders.set(order.id, order);
    return send(res, 200, order);
  }
  let m = /^\/v1\/payments\/([^/]+)$/.exec(p);
  if (m && req.method === "GET") return rzp.payments.has(m[1]) ? send(res, 200, rzp.payments.get(m[1])) : send(res, 404, { error: { description: "not found" } });
  m = /^\/v1\/payments\/([^/]+)\/refund$/.exec(p);
  if (m && req.method === "POST") {
    const payment = rzp.payments.get(m[1]);
    if (!payment) return send(res, 404, { error: { description: "not found" } });
    const { amount } = JSON.parse(body);
    payment.amount_refunded += amount;
    return send(res, 200, { id: id("rfnd"), entity: "refund", payment_id: payment.id, amount, currency: payment.currency, status: "processed" });
  }
  return send(res, 404, { error: { description: `sandbox: no route ${req.method} ${p}` } });
}

// Stand-in for checkout.razorpay.com/v1/checkout.js: a modal with Pay / Fail buttons.
const RZP_WIDGET = `(() => {
  const base = document.currentScript ? document.currentScript.src.replace(/\\/razorpay\\/checkout\\.js.*$/, "") : "";
  class Razorpay {
    constructor(o) { this.o = o; this.failed = []; }
    on(ev, cb) { if (ev === "payment.failed") this.failed.push(cb); }
    open() {
      const o = this.o;
      const wrap = document.createElement("div");
      wrap.setAttribute("role", "dialog");
      wrap.setAttribute("aria-label", "Razorpay sandbox");
      wrap.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:9999";
      wrap.innerHTML = '<div style="background:#fff;padding:24px;border-radius:8px;min-width:280px;font-family:sans-serif">'
        + '<p style="font-weight:600;margin:0 0 8px">Razorpay sandbox</p>'
        + '<p data-testid="rzp-amount" style="margin:0 0 16px">' + o.currency + ' ' + (o.amount / 100).toFixed(2) + '</p>'
        + '<button type="button" data-act="pay" style="margin-right:8px">Pay now</button>'
        + '<button type="button" data-act="fail" style="margin-right:8px">Fail payment</button>'
        + '<button type="button" data-act="close">Close</button></div>';
      document.body.appendChild(wrap);
      const done = () => wrap.remove();
      wrap.addEventListener("click", async (e) => {
        const act = e.target && e.target.getAttribute && e.target.getAttribute("data-act");
        if (!act) return;
        if (act === "close") { done(); o.modal && o.modal.ondismiss && o.modal.ondismiss(); return; }
        const res = await fetch(base + "/razorpay/_pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ order_id: o.order_id, outcome: act === "fail" ? "fail" : "success" }) });
        const data = await res.json();
        done();
        if (data.error) this.failed.forEach((cb) => cb({ error: data.error }));
        else o.handler(data);
      });
    }
  }
  window.Razorpay = Razorpay;
})();`;

// ── Stripe ────────────────────────────────────────────────────────────────────
function parseForm(body) {
  const out = {};
  for (const [k, v] of new URLSearchParams(body)) {
    const path = k.replace(/\]/g, "").split("[");
    let cur = out;
    path.slice(0, -1).forEach((seg) => (cur = cur[seg] ??= {}));
    cur[path.at(-1)] = v;
  }
  return out;
}
function intentView(pi) {
  const { charge, ...rest } = pi;
  return { ...rest, latest_charge: charge ?? null };
}
function stripeEvent(type, object) {
  const body = JSON.stringify({ id: id("evt"), object: "event", type, created: Math.floor(Date.now() / 1000), livemode: false, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  return deliver("stripe", "/api/webhooks/payments/stripe", body, { "stripe-signature": `t=${t},v1=${hmac(STRIPE_WEBHOOK_SECRET, `${t}.`, body)}` });
}

async function stripeApi(req, res, url, body) {
  const p = url.pathname.replace(/^\/stripe/, "");
  if (p === "/v3.js") return send(res, 200, STRIPE_JS, "application/javascript");
  if (p === "/_confirm" && req.method === "POST") {
    const { client_secret, card } = JSON.parse(body || "{}");
    const pi = [...stripe.intents.values()].find((x) => x.client_secret === client_secret);
    if (!pi) return send(res, 404, { error: { message: "No such payment intent" } });
    const digits = String(card ?? "").replace(/\D/g, "");
    if (digits !== "4242424242424242") {
      pi.status = "requires_payment_method";
      pi.last_payment_error = { message: "Your card was declined." };
      setTimeout(() => void stripeEvent("payment_intent.payment_failed", intentView(pi)), 200);
      return send(res, 200, { error: { message: "Your card was declined." } });
    }
    pi.status = "succeeded";
    pi.amount_received = pi.amount;
    pi.last_payment_error = null;
    pi.charge = { id: id("ch"), object: "charge", amount: pi.amount, amount_refunded: 0, payment_method_details: { type: "card" } };
    setTimeout(() => void stripeEvent("payment_intent.succeeded", { ...intentView(pi), latest_charge: pi.charge.id }), 300);
    return send(res, 200, { status: "succeeded", id: pi.id });
  }
  if (!(req.headers.authorization ?? "").startsWith("Bearer sk_test_")) return send(res, 401, { error: { message: "Invalid API Key provided" } });
  if (p === "/v1/payment_intents" && req.method === "GET") return send(res, 200, { object: "list", data: [] });
  if (p === "/v1/payment_intents" && req.method === "POST") {
    const key = req.headers["idempotency-key"];
    if (key && stripe.idempotency.has(key)) return send(res, 200, intentView(stripe.intents.get(stripe.idempotency.get(key))));
    const f = parseForm(body);
    const piId = id("pi");
    const pi = {
      id: piId,
      object: "payment_intent",
      amount: Number(f.amount),
      amount_received: 0,
      currency: f.currency,
      status: "requires_payment_method",
      client_secret: `${piId}_secret_${randomBytes(8).toString("hex")}`,
      metadata: f.metadata ?? {},
      last_payment_error: null,
    };
    stripe.intents.set(piId, pi);
    if (key) stripe.idempotency.set(key, piId);
    return send(res, 200, intentView(pi));
  }
  const m = /^\/v1\/payment_intents\/([^/]+)$/.exec(p);
  if (m && req.method === "GET") return stripe.intents.has(m[1]) ? send(res, 200, intentView(stripe.intents.get(m[1]))) : send(res, 404, { error: { message: "No such payment_intent" } });
  if (p === "/v1/refunds" && req.method === "POST") {
    const f = parseForm(body);
    const pi = stripe.intents.get(f.payment_intent);
    if (!pi?.charge) return send(res, 400, { error: { message: "Nothing to refund" } });
    pi.charge.amount_refunded += Number(f.amount);
    const refund = { id: id("re"), object: "refund", amount: Number(f.amount), currency: pi.currency, payment_intent: pi.id, status: "succeeded" };
    stripe.refunds.push(refund);
    return send(res, 200, refund);
  }
  return send(res, 404, { error: { message: `sandbox: no route ${req.method} ${p}` } });
}

// Stand-in for js.stripe.com/v3: a card-number field and confirmPayment() that redirects back.
const STRIPE_JS = `(() => {
  const base = document.currentScript ? document.currentScript.src.replace(/\\/stripe\\/v3\\.js.*$/, "") : "";
  window.Stripe = function (pk) {
    let secret = null;
    let input = null;
    return {
      elements(opts) {
        secret = opts.clientSecret;
        return {
          create() {
            return {
              mount(el) {
                const node = typeof el === "string" ? document.querySelector(el) : el;
                node.innerHTML = '<label style="display:grid;gap:4px;font-size:14px">Card number<input data-testid="stripe-card" autocomplete="off" style="height:40px;border:1px solid #ccc;border-radius:6px;padding:0 8px" placeholder="4242 4242 4242 4242"></label>';
                input = node.querySelector("input");
              },
            };
          },
        };
      },
      async confirmPayment(opts) {
        const res = await fetch(base + "/stripe/_confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_secret: secret, card: input ? input.value : "" }) });
        const data = await res.json();
        if (data.error) return { error: data.error };
        const url = new URL(opts.confirmParams.return_url);
        url.searchParams.set("payment_intent", data.id);
        url.searchParams.set("payment_intent_client_secret", secret);
        url.searchParams.set("redirect_status", "succeeded");
        window.location.href = url.toString();
        return {};
      },
    };
  };
})();`;

createServer(async (req, res) => {
  const url = new URL(req.url, "http://sandbox");
  try {
    const body = req.method === "GET" ? "" : await readBody(req);
    if (url.pathname === "/health") return send(res, 200, { ok: true });
    if (url.pathname === "/_events") return send(res, 200, url.searchParams.get("provider") ? events.filter((e) => e.provider === url.searchParams.get("provider")) : events);
    if (url.pathname === "/_orders") return send(res, 200, { razorpay: [...rzp.orders.values()].map(({ keyId: _k, ...o }) => o), stripe: [...stripe.intents.values()].map(intentView) });
    if (url.pathname.startsWith("/razorpay/")) return await razorpay(req, res, url, body);
    if (url.pathname.startsWith("/stripe/")) return await stripeApi(req, res, url, body);
    return send(res, 404, { error: "not found" });
  } catch (err) {
    return send(res, 500, { error: { message: String(err) } });
  }
}).listen(PORT, () => console.warn(`payment sandbox on :${PORT}`));
