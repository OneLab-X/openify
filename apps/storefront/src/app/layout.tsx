import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Header } from "@/components/Header";
import { getStore } from "@/lib";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const { store } = await getStore();
  return {
    title: store ? { default: store.name, template: `%s · ${store.name}` } : "Coming soon",
    ...(store?.faviconUrl ? { icons: { icon: store.faviconUrl } } : {}),
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { store } = await getStore();
  return (
    <html lang={store?.locale ?? "en"}>
      <body
        className="min-h-screen font-sans antialiased"
        style={store?.brand.primaryColor ? ({ "--color-primary": store.brand.primaryColor } as React.CSSProperties) : undefined}
      >
        {store ? <Header store={store} /> : null}
        {children}
      </body>
    </html>
  );
}
