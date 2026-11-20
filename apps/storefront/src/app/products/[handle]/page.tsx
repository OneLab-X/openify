import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { notFoundOrRedirect } from "@/lib/not-found";
import { connection } from "next/server";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { JsonLd } from "@/components/JsonLd";
import { ThemeShell } from "@/components/ThemeShell";
import { getProduct, getStore } from "@/lib";
import { breadcrumbLd, graph, pageMetadata, productLd, textFromHtml } from "@/lib/seo";
import { ProductView } from "./ProductView";

type Props = { params: Promise<{ handle: string }>; searchParams: Promise<{ variant?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const [product, { store }] = await Promise.all([getProduct((await params).handle), getStore()]);
  if (!product) return {};
  const image = product.images[0];
  return pageMetadata(store, {
    title: product.seo.title,
    description: product.seo.description || textFromHtml(product.descriptionHtml),
    path: `/products/${product.handle}`,
    ...(image ? { image: { url: image.url, alt: image.alt ?? product.title, width: image.width, height: image.height } } : {}),
  });
}

export default async function ProductPage({ params, searchParams }: Props) {
  await connection();
  const [{ handle }, { variant }] = await Promise.all([params, searchParams]);
  const [product, { store }] = await Promise.all([getProduct(handle), getStore()]);
  if (!store) notFound();
  if (!product) return notFoundOrRedirect(`/products/${handle}`);
  const crumbs = [
    { name: "Home", path: "/" },
    { name: product.title, path: `/products/${product.handle}` },
  ];
  return (
    <ThemeShell template="product">
      <JsonLd data={graph(productLd(store, product), breadcrumbLd(store, crumbs))} />
      <div className="sk-container grid gap-4 py-6">
        <Breadcrumbs items={crumbs} />
        <ProductView product={product} locale={store.locale ?? "en"} initialVariantId={variant ?? null} />
      </div>
    </ThemeShell>
  );
}
