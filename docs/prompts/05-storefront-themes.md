# 05 — Storefront, themes, CMS, SEO, analytics

Prepend `00-master-context.md`, then:

```
Phase 5 — Storefront, themes, CMS, SEO, analytics. Read SPEC §11, §12, and
docs/PLS-REFERENCE.md (SEO and rich-text sections).

Build:
1. packages/theme-sdk: types for sections, blocks and settings (text, richtext, image,
   colour, font, range, select, product, collection, menu, url, boolean), template JSON
   schema, helpers to read settings with defaults.
2. packages/themes/default: home, collection, product, cart, search, page, blog, article,
   customer account, 404 templates; sections: header, announcement bar, hero/slideshow,
   featured collection, featured product, image with text, rich text, testimonials,
   newsletter, footer. Mobile-first, WCAG 2.2 AA, reduced-motion aware.
3. Admin theme editor: template picker, drag-and-drop section/block order, settings forms
   from schema, live preview iframe with draft settings, publish, version history, rollback.
   Branding (logo, colours, fonts) from setup feeds global theme settings.
4. CMS: pages, blogs + articles (TipTap, sanitised), navigation menus (nested), URL
   redirects (and auto-redirect when a handle changes), announcement bar, policy pages
   (privacy, terms, shipping, refund) with generator templates.
5. SEO: per-entity meta, canonical URLs, JSON-LD (Organization, WebSite+SearchAction,
   Product+Offer+AggregateRating-ready, BreadcrumbList, CollectionPage, Article), sitemap
   index split by type, robots.txt, Open Graph images.
6. Analytics: storefront renders clientSnippet per enabled provider; cookie consent banner
   gates snippets that require consent; standard ecommerce events (view_item, add_to_cart,
   begin_checkout, purchase) pushed client-side; worker sends server-side purchase/refund
   events. Add Umami, Matomo, PostHog, Meta Pixel adapters. First-party event collection
   feeding analytics_daily.

Done when:
- merchant rearranges home sections in the editor, previews, publishes, and the live
  storefront updates without a rebuild;
- Lighthouse mobile ≥ 90 (performance, accessibility, SEO) on home, collection, product;
- Google Rich Results Test passes for a product page (document how to check);
- with consent banner on, no third-party analytics request fires before acceptance
  (Playwright network assertion).
```
