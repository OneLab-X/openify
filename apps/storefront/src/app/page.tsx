import type { Metadata } from "next";
import { connection } from "next/server";
import { JsonLd } from "@/components/JsonLd";
import { ThemeShell } from "@/components/ThemeShell";
import { getStore } from "@/lib";
import { graph, organizationLd, pageMetadata, websiteLd } from "@/lib/seo";

export async function generateMetadata(): Promise<Metadata> {
  const { store } = await getStore();
  if (!store) return {};
  return { ...pageMetadata(store, { title: store.name, path: "/", image: { url: "/opengraph-image", width: 1200, height: 630, alt: store.name } }), title: { absolute: store.name } };
}

/** Home page: the theme's `index` template (sections arranged in the theme editor). */
export default async function Home() {
  await connection();
  const { setupRequired, store } = await getStore();
  if (setupRequired || !store) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 px-4 text-center">
        <h1 className="text-3xl font-semibold">Coming soon</h1>
        <p>This shop is being set up. Please check back shortly.</p>
      </main>
    );
  }
  return (
    <>
      <JsonLd data={graph(organizationLd(store), websiteLd(store))} />
      <ThemeShell template="index" />
    </>
  );
}
