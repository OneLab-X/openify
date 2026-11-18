# PLS reference code

PrettyLittleStore (PLS) is a working single-store shop (Next.js 16, Google Sheet catalog, MongoDB orders, Razorpay, Resend). Shopkit generalises its proven flows. Study these files before building the matching feature; port the behaviour, not the storage choices (Sheet/Mongo/Drive are replaced by Postgres + provider adapters).

PLS repo: `/Users/techadmin/Development/PLS` (paths below are relative to it). Its `README.md` documents each flow in detail.

## Payments (Phase 1 + 3)
| File | What to take from it |
|---|---|
| `src/lib/server/razorpay.ts` | Razorpay API client, order creation, signature verification |
| `src/app/api/payments/order/route.ts` | server-side pricing: browser never sends an amount; order saved before provider order is created (`receipt` = our order id) |
| `src/app/api/payments/verify/route.ts` | client-return verification as fast path |
| `src/app/api/razorpay/webhook/route.ts` | raw-body signature check, webhook as source of truth, dedupe by last event id, captured/failed/refunded handling |
| `src/app/api/admin/payments/[orderId]/route.ts`, `.../refund/route.ts` | live payment/refund lookup and partial refunds from admin |
| `src/lib/checkout.ts` | client side: loading the Razorpay widget and handling callbacks |

## Orders & emails (Phase 3)
| File | What to take from it |
|---|---|
| `src/lib/server/orders.ts` | order document shape, status transitions, indexes |
| `src/lib/order.ts` | order id format (`PLS-YYMMDD-XXXX`) and client order form data |
| `src/lib/server/order-email.ts` | confirmation + shop alert emails, idempotency key per order |
| `src/components/order/ThankYou.tsx`, `src/app/thank-you/page.tsx` | thank-you page that keeps order details out of the URL |
| `scripts/import-orders.mjs` | idempotent import with `--dry-run` (pattern for Phase 6 importers) |

## Admin UX (Phase 4)
| File | What to take from it |
|---|---|
| `src/components/admin/DeliveryDialog.tsx` | shipping methods: local driver (name, mobile, trip link), Delhivery AWB, other courier |
| `src/lib/delivery.ts` | tracking-link builders |
| `src/components/admin/printLabel.ts` | A6/A4 box label with From block |
| `src/components/admin/OrderActions.tsx` | "send delivery details on WhatsApp" |
| `src/components/admin/PaymentPanel.tsx` | payments + refund panel on order edit |
| `src/components/admin/Dashboard.tsx` | dashboard cards (orders today/7/30 days, by status, top products) |
| `src/lib/server/admin-auth.ts` | signed admin sessions, lockout after failed logins |

## Content, SEO, media (Phase 2 + 5)
| File | What to take from it |
|---|---|
| `src/components/RichText.tsx`, `src/lib/rich-text.ts` | DOMPurify allow-list for rich text, plain-text upgrade |
| `src/components/admin/RichTextEditor.tsx` | TipTap editor config |
| `src/lib/seo.ts`, `src/components/JsonLd.tsx` | metadata and JSON-LD builders |
| `src/app/sitemap.ts`, `src/app/robots.ts` | sitemap/robots generation |
| `src/lib/image-upload.ts` | browser-side resize before upload |
| `src/data/policies.ts`, `src/app/policies/*` | policy page content model |

## Known PLS limitations Shopkit must fix
- Catalog in a Google Sheet; new products need a rebuild for their own page → Shopkit uses Postgres + cache-tag revalidation.
- Secrets in env vars on Vercel → Shopkit stores provider secrets encrypted in the DB.
- No cart (one product per order) → full cart and checkout.
- Single hard-coded store config in `src/data/products.ts` → setup wizard + settings.
