import { createHash } from "node:crypto";
import type { DOMPurify as Purifier } from "dompurify";

/**
 * Rich-text allow-list (SPEC §10, ported from PLS src/lib/rich-text.ts): what the TipTap editor can
 * produce plus what Shopify product CSVs commonly contain. No scripts, styles, iframes or event handlers.
 */
const ALLOWED_TAGS = [
  "p", "br", "hr", "strong", "b", "em", "i", "u", "s", "strike", "sub", "sup", "code", "pre", "blockquote",
  "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "a", "span", "div",
  "table", "thead", "tbody", "tr", "th", "td", "img",
];
const ALLOWED_ATTR = ["href", "title", "target", "rel", "src", "alt", "width", "height", "colspan", "rowspan"];

let purifier: Purifier | null = null;

async function getPurifier(): Promise<Purifier> {
  if (purifier) return purifier;
  // jsdom is heavy: load it on first use only (API + worker).
  const [{ JSDOM }, { default: DOMPurify }] = await Promise.all([import("jsdom"), import("dompurify")]);
  const { window } = new JSDOM("");
  const p = DOMPurify(window);
  p.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      const href = node.getAttribute("href") ?? "";
      if (!/^(https?:|mailto:|tel:|\/|#)/i.test(href)) node.removeAttribute("href");
      if (node.getAttribute("target") === "_blank") node.setAttribute("rel", "noopener noreferrer nofollow");
      else node.removeAttribute("target");
    }
    if (node.tagName === "IMG") {
      const src = node.getAttribute("src") ?? "";
      if (!/^(https:|\/)/i.test(src)) node.remove();
    }
  });
  purifier = p;
  return p;
}

const cache = new Map<string, string>();
const CACHE_MAX = 2000;

/** Sanitises merchant HTML. Applied on write and again on output (defence in depth). */
export async function sanitizeHtml(html: string | null | undefined): Promise<string> {
  if (!html) return "";
  const key = createHash("sha1").update(html).digest("base64");
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const p = await getPurifier();
  const clean = p.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOW_DATA_ATTR: false });
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, clean);
  return clean;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };

/** Plain text for search indexes and meta descriptions. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ENTITIES[e] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
}
