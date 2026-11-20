import { Img } from "@shopkit/theme-default";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { notFoundOrRedirect } from "@/lib/not-found";
import { connection } from "next/server";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { JsonLd } from "@/components/JsonLd";
import { ThemeShell } from "@/components/ThemeShell";
import { getArticle, getStore } from "@/lib";
import { articleLd, breadcrumbLd, graph, pageMetadata } from "@/lib/seo";

type Props = { params: Promise<{ blog: string; article: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const p = await params;
  const [a, { store }] = await Promise.all([getArticle(p.blog, p.article), getStore()]);
  if (!a) return {};
  return pageMetadata(store, {
    title: a.seoTitle || a.title,
    description: a.description,
    path: a.url,
    type: "article",
    ...(a.image ? { image: { url: a.image.url, alt: a.image.alt ?? a.title, width: a.image.width, height: a.image.height } } : {}),
  });
}

export default async function ArticlePage({ params }: Props) {
  await connection();
  const p = await params;
  const [a, { store }] = await Promise.all([getArticle(p.blog, p.article), getStore()]);
  if (!store) notFound();
  if (!a) return notFoundOrRedirect(`/blogs/${p.blog}/${p.article}`);
  const crumbs = [
    { name: "Home", path: "/" },
    { name: a.blogTitle, path: `/blogs/${a.blogHandle}` },
    { name: a.title, path: a.url },
  ];
  const locale = store.locale ?? "en";
  return (
    <ThemeShell template="article">
      <JsonLd data={graph(articleLd(store, a), breadcrumbLd(store, crumbs))} />
      <article className="sk-container grid max-w-3xl gap-6 py-10">
        <Breadcrumbs items={crumbs} />
        <header className="grid gap-2">
          <h1 className="text-3xl font-semibold md:text-4xl">{a.title}</h1>
          <p className="text-sm opacity-75">
            {a.publishedAt ? <time dateTime={a.publishedAt}>{new Date(a.publishedAt).toLocaleDateString(locale, { dateStyle: "long" })}</time> : null}
            {a.author ? ` · ${a.author}` : ""}
          </p>
        </header>
        {a.image ? (
          <div className="sk-rounded overflow-hidden">
            <Img image={a.image} alt={a.image.alt ?? ""} sizes="(min-width: 768px) 768px, 100vw" priority className="h-auto w-full" />
          </div>
        ) : null}
        <div className="sk-rte" dangerouslySetInnerHTML={{ __html: a.bodyHtml }} />
        {a.tags.length ? (
          <ul className="flex flex-wrap gap-2 text-sm" aria-label="Tags">
            {a.tags.map((t) => (
              <li key={t}>
                <a href={`/blogs/${a.blogHandle}?tag=${encodeURIComponent(t)}`} className="sk-link">
                  #{t}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </article>
    </ThemeShell>
  );
}
