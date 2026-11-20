import type { SectionSchema, SettingSchema, TemplateData, TemplateName, ThemeSchema } from "@shopkit/theme-sdk";

/**
 * Default theme schema: global settings, sections and the initial template JSON. Pure data, so
 * the API (validation) and the admin (editor forms) import it without React.
 */

const colorScheme = { id: "color_scheme", type: "select", label: "Colour scheme", options: [
  { value: "background", label: "Background" },
  { value: "muted", label: "Muted" },
  { value: "accent", label: "Accent" },
  { value: "inverse", label: "Inverse" },
], default: "background" } as const satisfies SettingSchema;

const padding = { id: "padding", type: "select", label: "Vertical spacing", options: [
  { value: "none", label: "None" },
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
], default: "medium" } as const satisfies SettingSchema;

const heading = (def: string) => ({ id: "heading", type: "text", label: "Heading", default: def, maxLength: 120 }) as const satisfies SettingSchema;
const button = [
  { id: "button_label", type: "text", label: "Button label", maxLength: 40 },
  { id: "button_link", type: "url", label: "Button link" },
] as const satisfies readonly SettingSchema[];

export const GLOBAL_SETTINGS = [
  {
    name: "Brand",
    settings: [
      { id: "logo", type: "image", label: "Logo", info: "Empty = the logo from Settings → Branding" },
      { id: "logo_width", type: "range", label: "Logo width", min: 60, max: 240, step: 10, unit: "px", default: 120 },
    ],
  },
  {
    name: "Colours",
    settings: [
      { id: "color_background", type: "color", label: "Background", default: "#ffffff" },
      { id: "color_text", type: "color", label: "Text", default: "#18181b" },
      { id: "color_accent", type: "color", label: "Accent (buttons, links)", default: "#4338ca", info: "Defaults to the brand primary colour" },
      { id: "color_muted", type: "color", label: "Muted background", default: "#f4f4f5" },
      { id: "color_sale", type: "color", label: "Sale price", default: "#b91c1c" },
    ],
  },
  {
    name: "Typography",
    settings: [
      { id: "font_heading", type: "font", label: "Headings", default: "system" },
      { id: "font_body", type: "font", label: "Body", default: "system" },
      { id: "font_scale", type: "range", label: "Text size", min: 90, max: 120, step: 5, unit: "%", default: 100 },
    ],
  },
  {
    name: "Layout",
    settings: [
      { id: "page_width", type: "select", label: "Page width", options: [
        { value: "narrow", label: "Narrow (1024px)" },
        { value: "normal", label: "Normal (1200px)" },
        { value: "wide", label: "Wide (1440px)" },
      ], default: "normal" },
      { id: "radius", type: "range", label: "Corner radius", min: 0, max: 24, step: 2, unit: "px", default: 8 },
      { id: "product_image_ratio", type: "select", label: "Product image shape", options: [
        { value: "square", label: "Square" },
        { value: "portrait", label: "Portrait (3:4)" },
        { value: "natural", label: "Natural" },
      ], default: "square" },
    ],
  },
  {
    name: "Social",
    settings: [
      { id: "social_instagram", type: "url", label: "Instagram" },
      { id: "social_facebook", type: "url", label: "Facebook" },
      { id: "social_youtube", type: "url", label: "YouTube" },
      { id: "social_whatsapp", type: "url", label: "WhatsApp link" },
    ],
  },
] as const;

const MAIN: { type: string; name: string; template: TemplateName }[] = [
  { type: "main-collection", name: "Collection products", template: "collection" },
  { type: "main-product", name: "Product information", template: "product" },
  { type: "main-cart", name: "Cart", template: "cart" },
  { type: "main-search", name: "Search results", template: "search" },
  { type: "main-page", name: "Page content", template: "page" },
  { type: "main-blog", name: "Blog posts", template: "blog" },
  { type: "main-article", name: "Blog post", template: "article" },
  { type: "main-account", name: "Customer account", template: "account" },
  { type: "main-404", name: "Page not found", template: "404" },
];

export const SECTIONS: SectionSchema[] = [
  {
    type: "announcement-bar",
    name: "Announcement bar",
    templates: ["layout"],
    settings: [colorScheme],
    blocks: [{ type: "announcement", name: "Announcement", settings: [
      { id: "text", type: "text", label: "Text", default: "Free shipping on orders over ₹999", maxLength: 160 },
      { id: "link", type: "url", label: "Link" },
    ] }],
    maxBlocks: 3,
    presetBlocks: [{ type: "announcement" }],
  },
  {
    type: "header",
    name: "Header",
    templates: ["layout"],
    settings: [
      { id: "menu", type: "menu", label: "Menu", default: "main-menu" },
      { id: "show_search", type: "boolean", label: "Show search", default: true },
      { id: "sticky", type: "boolean", label: "Stick to the top while scrolling", default: false },
      colorScheme,
    ],
  },
  {
    type: "footer",
    name: "Footer",
    templates: ["layout"],
    settings: [
      { id: "show_policies", type: "boolean", label: "Show policy links", default: true },
      { id: "show_social", type: "boolean", label: "Show social links", default: true },
      { id: "copyright", type: "text", label: "Copyright text", maxLength: 200 },
      { ...colorScheme, default: "muted" },
    ],
    blocks: [
      { type: "menu", name: "Menu", settings: [heading("Shop"), { id: "menu", type: "menu", label: "Menu", default: "footer" }] },
      { type: "text", name: "Text", settings: [heading("About us"), { id: "text", type: "richtext", label: "Text" }] },
    ],
    maxBlocks: 4,
    presetBlocks: [{ type: "menu" }],
  },
  {
    type: "slideshow",
    name: "Hero / slideshow",
    settings: [
      { id: "height", type: "select", label: "Height", options: [
        { value: "small", label: "Small" },
        { value: "medium", label: "Medium" },
        { value: "large", label: "Large" },
      ], default: "medium" },
      { id: "autoplay", type: "boolean", label: "Rotate slides automatically", default: false, info: "Never rotates for visitors who prefer reduced motion" },
      { id: "speed", type: "range", label: "Seconds per slide", min: 3, max: 12, step: 1, unit: "s", default: 6 },
      { id: "overlay", type: "range", label: "Image darkening", min: 0, max: 80, step: 10, unit: "%", default: 30 },
    ],
    blocks: [{ type: "slide", name: "Slide", settings: [
      { id: "image", type: "image", label: "Image" },
      heading("Welcome to our store"),
      { id: "text", type: "textarea", label: "Text", default: "Handmade with care.", maxLength: 300 },
      ...button,
      { id: "align", type: "select", label: "Text position", options: [
        { value: "left", label: "Left" },
        { value: "center", label: "Centre" },
      ], default: "center" },
    ] }],
    maxBlocks: 5,
    presetBlocks: [{ type: "slide", settings: { button_label: "Shop now", button_link: "/search" } }],
  },
  {
    type: "featured-collection",
    name: "Featured collection",
    settings: [
      heading("Featured products"),
      { id: "collection", type: "collection", label: "Collection", info: "Empty = newest products" },
      { id: "limit", type: "range", label: "Products to show", min: 2, max: 12, step: 1, default: 8 },
      { id: "columns", type: "range", label: "Columns on desktop", min: 2, max: 5, step: 1, default: 4 },
      { id: "show_view_all", type: "boolean", label: "Show “View all”", default: true },
      colorScheme,
      padding,
    ],
  },
  {
    type: "featured-product",
    name: "Featured product",
    settings: [
      { id: "product", type: "product", label: "Product" },
      { id: "show_description", type: "boolean", label: "Show description", default: true },
      colorScheme,
      padding,
    ],
  },
  {
    type: "image-with-text",
    name: "Image with text",
    settings: [
      { id: "image", type: "image", label: "Image" },
      { id: "image_position", type: "select", label: "Image position", options: [
        { value: "left", label: "Left" },
        { value: "right", label: "Right" },
      ], default: "left" },
      heading("Our story"),
      { id: "text", type: "richtext", label: "Text", default: "<p>Tell customers about your brand, your makers and what makes your products special.</p>" },
      ...button,
      colorScheme,
      padding,
    ],
  },
  {
    type: "rich-text",
    name: "Rich text",
    settings: [
      heading("Talk about your brand"),
      { id: "text", type: "richtext", label: "Text", default: "<p>Share information about your brand with your customers.</p>" },
      { id: "align", type: "select", label: "Alignment", options: [
        { value: "left", label: "Left" },
        { value: "center", label: "Centre" },
      ], default: "center" },
      ...button,
      colorScheme,
      padding,
    ],
  },
  {
    type: "testimonials",
    name: "Testimonials",
    settings: [heading("What our customers say"), colorScheme, padding],
    blocks: [{ type: "testimonial", name: "Testimonial", settings: [
      { id: "quote", type: "textarea", label: "Quote", default: "Beautiful quality and quick delivery. Will order again!", maxLength: 500 },
      { id: "author", type: "text", label: "Name", default: "A happy customer", maxLength: 80 },
      { id: "rating", type: "range", label: "Stars", min: 0, max: 5, step: 1, default: 5 },
    ] }],
    maxBlocks: 6,
    presetBlocks: [{ type: "testimonial" }, { type: "testimonial", settings: { author: "Another customer" } }, { type: "testimonial", settings: { author: "A regular" } }],
  },
  {
    type: "newsletter",
    name: "Newsletter",
    settings: [
      heading("Subscribe to our emails"),
      { id: "text", type: "textarea", label: "Text", default: "New arrivals and offers, no more than twice a month.", maxLength: 300 },
      { ...colorScheme, default: "muted" },
      padding,
    ],
  },
  ...MAIN.map(
    (m): SectionSchema => ({
      type: m.type,
      name: m.name,
      main: true,
      templates: [m.template],
      settings: [{ ...padding, default: "none" }, ...(m.template === "product" ? ([{ id: "show_vendor", type: "boolean", label: "Show vendor", default: false }] as const) : [])],
    }),
  ),
];

const t = (sections: Record<string, TemplateData["sections"][string]>): TemplateData => ({ sections, order: Object.keys(sections) });
const sec = (type: string, settings: Record<string, unknown> = {}, blocks: [string, string, Record<string, unknown>][] = []) => ({
  type,
  settings,
  blocks: Object.fromEntries(blocks.map(([id, bt, s]) => [id, { type: bt, settings: s }])),
  block_order: blocks.map(([id]) => id),
});
const main = (type: string) => t({ main: sec(type) });

export const TEMPLATES: Record<TemplateName, TemplateData> = {
  layout: t({
    announcement: sec("announcement-bar", { color_scheme: "accent" }, [["a1", "announcement", { text: "Free shipping on orders over ₹999" }]]),
    header: sec("header"),
    footer: sec("footer", {}, [["f1", "menu", { heading: "Shop", menu: "footer" }], ["f2", "text", { heading: "About us", text: "<p>Small-batch goods, made with care.</p>" }]]),
  }),
  index: t({
    hero: sec("slideshow", {}, [["s1", "slide", { heading: "Welcome to our store", text: "Handmade with care.", button_label: "Shop now", button_link: "/search" }]]),
    featured: sec("featured-collection", { heading: "New arrivals" }),
    story: sec("image-with-text"),
    testimonials: sec("testimonials", {}, [["t1", "testimonial", {}], ["t2", "testimonial", { author: "Another customer" }], ["t3", "testimonial", { author: "A regular" }]]),
    newsletter: sec("newsletter"),
  }),
  collection: main("main-collection"),
  product: t({ main: sec("main-product"), related: sec("featured-collection", { heading: "You may also like", limit: 4 }) }),
  cart: main("main-cart"),
  search: main("main-search"),
  page: main("main-page"),
  blog: main("main-blog"),
  article: main("main-article"),
  account: main("main-account"),
  "404": t({ main: sec("main-404"), featured: sec("featured-collection", { heading: "Popular right now", limit: 4 }) }),
};

/** Header- and footer-group section types (layout template). */
export const HEADER_GROUP = new Set(["announcement-bar", "header"]);

export const THEME: ThemeSchema = {
  handle: "default",
  name: "Default",
  version: "1.0.0",
  settings: GLOBAL_SETTINGS,
  sections: SECTIONS,
  templates: TEMPLATES,
};
