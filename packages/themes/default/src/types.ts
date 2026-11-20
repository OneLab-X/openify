import type { TemplateName } from "@shopkit/theme-sdk";
import type { ReactNode } from "react";

/** Data shapes the storefront hands to the theme (the theme never calls the API itself). */
export interface ThemeImage {
  url: string;
  alt?: string | null;
  width?: number | null;
  height?: number | null;
  sources?: { url: string; width: number; format: "webp" | "avif" }[];
}

export interface ThemeProductCard {
  handle: string;
  title: string;
  priceMin: number;
  priceMax: number;
  compareAtPriceMax: number | null;
  currency: string;
  available: boolean;
  image: ThemeImage | null;
}

export interface ThemeProduct extends ThemeProductCard {
  vendor: string | null;
  descriptionHtml: string;
}

export interface ThemeMenuItem {
  title: string;
  url: string;
  items: ThemeMenuItem[];
}

export interface ThemeData {
  /** Products of a collection (or the newest when `collection` is null). */
  products(opts: { collection: string | null; limit: number }): Promise<{ title: string | null; url: string; items: ThemeProductCard[] }>;
  product(handle: string): Promise<ThemeProduct | null>;
  menu(handle: string): Promise<ThemeMenuItem[]>;
  policies(): Promise<{ title: string; url: string }[]>;
}

export interface ThemeContext {
  store: { name: string; logo: ThemeImage | null; locale: string; currency: string };
  /** Global settings, resolved with defaults. */
  settings: Record<string, unknown>;
  data: ThemeData;
  template: TemplateName;
  /** The page's own content (product form, cart, account…) rendered by the main section. */
  main?: ReactNode;
  /** Storefront widgets the header shows (cart count, account link). */
  slots: { cart?: ReactNode; account?: ReactNode };
}

export interface SectionProps {
  id: string;
  settings: Record<string, unknown>;
  blocks: { id: string; type: string; settings: Record<string, unknown> }[];
  ctx: ThemeContext;
  /** First section on the page: its image is the likely LCP element. */
  first: boolean;
}
