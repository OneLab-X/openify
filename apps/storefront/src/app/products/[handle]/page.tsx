import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { getProduct, getStore } from "@/lib";
import { ProductView } from "./ProductView";

type Props = { params: Promise<{ handle: string }>; searchParams: Promise<{ variant?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const product = await getProduct((await params).handle);
  if (!product) return {};
  return {
    title: product.seo.title,
    ...(product.seo.description ? { description: product.seo.description } : {}),
    alternates: { canonical: `/products/${product.handle}` },
  };
}

export default async function ProductPage({ params, searchParams }: Props) {
  await connection();
  const [{ handle }, { variant }] = await Promise.all([params, searchParams]);
  const [product, { store }] = await Promise.all([getProduct(handle), getStore()]);
  if (!product || !store) notFound();
  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <ProductView product={product} locale={store.locale ?? "en"} initialVariantId={variant ?? null} />
    </main>
  );
}
