import { allGlobalSettings, fontStack, readSettings, resolveTemplate, type TemplateData } from "@shopkit/theme-sdk";
import type { ComponentType, CSSProperties, ReactNode } from "react";
import { HEADER_GROUP, THEME } from "./schema.js";
import { FeaturedCollection, FeaturedProduct, ImageWithText, MainContent, Newsletter, RichText, SlideshowSection, Testimonials } from "./sections/content.js";
import { AnnouncementBar, Footer, Header } from "./sections/layout.js";
import type { SectionProps, ThemeContext } from "./types.js";
import { num, str } from "./util.js";

export { THEME } from "./schema.js";
export type * from "./types.js";
export { ProductCardView } from "./sections/content.js";
export { formatMoney, Img, Price } from "./util.js";

type Section = ComponentType<SectionProps> | ((p: SectionProps) => Promise<ReactNode>);

export const SECTION_COMPONENTS: Record<string, Section> = {
  "announcement-bar": AnnouncementBar,
  header: Header,
  footer: Footer,
  slideshow: SlideshowSection,
  "featured-collection": FeaturedCollection,
  "featured-product": FeaturedProduct,
  "image-with-text": ImageWithText,
  "rich-text": RichText,
  testimonials: Testimonials,
  newsletter: Newsletter,
};

function render(sections: ReturnType<typeof resolveTemplate>, ctx: ThemeContext, firstOnPage: boolean) {
  return sections.map((s, i) => {
    const C = (SECTION_COMPONENTS[s.type] ?? (s.type.startsWith("main-") ? MainContent : null)) as ComponentType<SectionProps> | null;
    if (!C) return null;
    // data-section-id lets the theme editor's preview scroll to and outline a section.
    return (
      <div key={s.id} data-section-id={s.id} data-section-type={s.type} className="contents">
        <C id={s.id} settings={s.settings} blocks={s.blocks} ctx={ctx} first={firstOnPage && i === 0} />
      </div>
    );
  });
}

/** Header group, then the template's sections inside <main>, then the footer group. */
export function ThemePage({ ctx, layout, template }: { ctx: ThemeContext; layout: TemplateData; template: TemplateData }) {
  const shell = resolveTemplate(THEME, layout);
  const head = shell.filter((s) => HEADER_GROUP.has(s.type));
  const foot = shell.filter((s) => !HEADER_GROUP.has(s.type));
  return (
    <>
      <a href="#main" className="sk-skip">
        Skip to content
      </a>
      <div data-section-group="header">{render(head, ctx, false)}</div>
      <main id="main" tabIndex={-1} className="flex-1 focus:outline-none">
        {render(resolveTemplate(THEME, template), ctx, true)}
      </main>
      <div data-section-group="footer">{render(foot, ctx, false)}</div>
    </>
  );
}

/** Global settings with brand fallbacks (setup colours feed the theme until the merchant overrides them). */
export function globalSettings(values: unknown, brand: { primaryColor?: string | null; accentColor?: string | null }) {
  const raw = (values && typeof values === "object" ? values : {}) as Record<string, unknown>;
  const withBrand = { ...raw, ...(raw.color_accent === undefined && brand.primaryColor ? { color_accent: brand.primaryColor } : {}) };
  return readSettings(allGlobalSettings(THEME), withBrand) as Record<string, unknown>;
}

function luminance(hex: string) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m) as [number, number];
  return (x + 0.05) / (y + 0.05);
};
/** Black or white, whichever reads better on `bg` (keeps buttons AA whatever the brand colour). */
export const readableOn = (bg: string) => (contrast(bg, "#000000") >= contrast(bg, "#ffffff") ? "#000000" : "#ffffff");

const WIDTH: Record<string, string> = { narrow: "1024px", normal: "1200px", wide: "1440px" };
const RATIO: Record<string, string> = { square: "1", portrait: "3 / 4", natural: "auto" };

/** CSS variables for <body> from resolved global settings. */
export function themeStyle(s: Record<string, unknown>): CSSProperties {
  const bg = str(s.color_background) || "#ffffff";
  const fg = str(s.color_text) || "#18181b";
  const accent = str(s.color_accent) || "#4338ca";
  // Links use the accent only when it is readable on the background (WCAG AA 4.5:1).
  const link = contrast(accent, bg) >= 4.5 ? accent : fg;
  const sale = str(s.color_sale) || "#b91c1c";
  return {
    "--sk-bg": bg,
    "--sk-fg": fg,
    "--sk-accent": accent,
    "--sk-accent-fg": readableOn(accent),
    "--sk-muted": str(s.color_muted) || "#f4f4f5",
    "--sk-link": link,
    "--sk-sale": contrast(sale, bg) >= 4.5 ? sale : fg,
    "--sk-font-heading": fontStack(str(s.font_heading)),
    "--sk-font-body": fontStack(str(s.font_body)),
    "--sk-font-scale": String(num(s.font_scale, 100) / 100),
    "--sk-radius": `${num(s.radius, 8)}px`,
    "--sk-page-width": WIDTH[str(s.page_width)] ?? WIDTH.normal,
    "--sk-product-ratio": RATIO[str(s.product_image_ratio)] ?? "1",
  } as CSSProperties;
}
