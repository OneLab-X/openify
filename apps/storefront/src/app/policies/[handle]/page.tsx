import type { Metadata } from "next";
import { notFoundOrRedirect } from "@/lib/not-found";
import { connection } from "next/server";
import { ThemeShell } from "@/components/ThemeShell";
import { getPage, getStore } from "@/lib";
import { pageMetadata } from "@/lib/seo";

type Props = { params: Promise<{ handle: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const [page, { store }] = await Promise.all([getPage((await params).handle, "policy"), getStore()]);
  return page ? pageMetadata(store, { title: page.seoTitle || page.title, description: page.description, path: page.url }) : {};
}

export default async function PolicyPage({ params }: Props) {
  await connection();
  const { handle } = await params;
  const page = await getPage(handle, "policy");
  if (!page) return notFoundOrRedirect(`/policies/${handle}`);
  return (
    <ThemeShell template="page">
      <article className="sk-container max-w-3xl py-10">
        <h1 className="mb-6 text-3xl font-semibold">{page.title}</h1>
        {/* Sanitised with DOMPurify on write and on output. */}
        <div className="sk-rte" dangerouslySetInnerHTML={{ __html: page.bodyHtml }} />
      </article>
    </ThemeShell>
  );
}
