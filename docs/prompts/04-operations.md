# 04 — Merchant operations

Prepend `00-master-context.md`, then:

```
Phase 4 — Merchant operations. Read SPEC §7 (ShippingProvider), §8 (Pricing, Commerce), and
docs/PLS-REFERENCE.md (admin UX section).

Build:
1. Fulfillment: partial and multi-location fulfillments, tracking number/URL, notify
   customer toggle. Manual shipping methods ported from PLS: local driver (name, mobile,
   trip link), courier with AWB (auto tracking link per known courier), other courier.
   "Send delivery details on WhatsApp" action and printable box label (A6 + A4) ported
   from PLS DeliveryDialog and printLabel.
2. Shipping: zones by country/state/PIN prefix, rates (flat, weight-based, price-based,
   free over X), local pickup, local delivery by PIN. Carrier adapters: Shiprocket,
   Delhivery, EasyPost (rates, create shipment, label, tracking webhooks).
3. Refunds: full/partial by line or amount, restock toggle, shipping refund, through
   PaymentProvider.refund; refund state driven by webhook. Returns: request (customer or
   staff), approve, receive, refund/exchange.
4. Discounts engine: codes and automatic; % off, fixed off, free shipping, buy X get Y;
   applies to all/collections/products; min spend/quantity; customer eligibility; usage
   limits total and per customer; start/end schedule; combination rules. Gift cards: issue,
   sell as product, redeem at checkout, balance ledger.
5. Tax: India GST (CGST+SGST intra-state, IGST inter-state, HSN on variant, tax-inclusive
   prices, GSTIN on store and optional on customer), generic VAT/sales tax rates by
   country/region, overrides per collection. GST-compliant invoice PDF per order.
6. Dashboard & reports: sales, orders, AOV, returning customers, top products, sales by
   channel/payment method, conversion funnel from analytics_daily; date range compare;
   CSV export. Port the PLS dashboard cards as the starting layout.
7. Staff: invite by email, granular permissions, enforce 2FA option, audit log viewer with
   filters.

Done when:
- integration tests cover: paid → partially fulfilled → fulfilled → partial refund with
  restock → return received, with correct financial/fulfillment statuses and inventory;
- discount engine has table-driven unit tests for every discount type and combination rule;
- GST invoice totals match line-level tax splits for intra- and inter-state orders.
```
