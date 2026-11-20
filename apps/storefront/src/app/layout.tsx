import { globalSettings, themeStyle } from "@shopkit/theme-default";
import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { Analytics, ConsentSettingsLink } from "@/components/Analytics";
import { PreviewBridge } from "@/components/PreviewBridge";
import { getAnalyticsConfig, getStore } from "@/lib";
import { siteUrl } from "@/lib/seo";
import { getTheme, previewToken } from "@/lib/theme";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const { store } = await getStore();
  return {
    metadataBase: new URL(`${siteUrl(store)}/`),
    title: store ? { default: store.name, template: `%s · ${store.name}` } : "Coming soon",
    ...(store?.faviconUrl ? { icons: { icon: store.faviconUrl } } : {}),
    ...(store ? { openGraph: { siteName: store.name, type: "website" } } : {}),
  };
}

export async function generateViewport(): Promise<Viewport> {
  const theme = await getTheme("layout");
  const { store } = await getStore();
  const s = globalSettings(theme?.settings, store?.brand ?? {});
  return { themeColor: typeof s.color_accent === "string" ? s.color_accent : undefined };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Every page reads the live theme and store at request time (cached by tag, never baked into the build).
  await connection();
  const [{ store }, theme, analytics, preview] = await Promise.all([getStore(), getTheme("layout"), getAnalyticsConfig(), previewToken()]);
  const settings = globalSettings(theme?.settings, store?.brand ?? {});
  const needsConsent = analytics.consentBanner && analytics.providers.some((p) => p.requiresConsent);
  return (
    <html lang={store?.locale ?? "en"}>
      <body className="sk-theme flex min-h-screen flex-col antialiased" style={themeStyle(settings)}>
        {children}
        {needsConsent ? <ConsentSettingsLink /> : null}
        {store ? <Analytics providers={analytics.providers} banner={analytics.consentBanner} /> : null}
        {preview ? <PreviewBridge /> : null}
      </body>
    </html>
  );
}
