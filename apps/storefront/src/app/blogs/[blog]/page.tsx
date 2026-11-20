import type { Metadata } from "next";
import { notFoundOrRedirect } from "@/lib/not-found";
import { connection } from "next/server";
import { ThemeShell } from "@/components/ThemeShell";
import { getBlog, getStore, one } from "@/lib";
import { pageMetadata } from "@/lib/seo";
import { Img } from "@shopkit/theme-default";

type Props = { params: Promise<{ blog: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [b, { store }, sp] = await Promise.all([getBlog((await params).blog), getStore(), searchParams]);
  if (!b) return {};
  return pageMetadata(store, { title: b.blog.seoTitle || b.blog.title, description: b.blog.seoDescription, path: b.blog.url, noindex: Object.keys(sp).length > 0 });
}

export default async function BlogPage({ params, searchParams }: Props) {
  await connection();
  const [{ blog }, sp] = await Promise.all([params, searchParams]);
  const page = Math.max(1, Number(one(sp.page)) || 1);
  const tag = one(sp.tag);
  const [data, { store }] = await Promise.all([getBlog(blog, page, tag), getStore()]);
  if (!data) return notFoundOrRedirect(`/blogs/${blog}`);
  const locale = store?.locale ?? "en";
  return (
    <ThemeShell template="blog">
      <div className="sk-container grid gap-8 py-10">
        <h1 className="text-3xl font-semibold">{data.blog.title}{tag ? ` · ${tag}` : ""}</h1>
        {data.items.length === 0 ? <p>No posts yet.</p> : null}
        <ul className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {data.items.map((a) => (
            <li key={a.id}>
              <article className="grid gap-3">
                {a.image ? (
                  <div className="sk-rounded aspect-[3/2] overflow-hidden bg-[var(--sk-muted)]">
                    <Img image={a.image} alt="" sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw" className="h-full w-full object-cover" />
                  </div>
                ) : null}
                <h2 className="text-xl font-semibold">
                  <a href={a.url} className="hover:underline">
                    {a.title}
                  </a>
                </h2>
                {a.publishedAt ? <p className="text-sm opacity-75"><time dateTime={a.publishedAt}>{new Date(a.publishedAt).toLocaleDateString(locale, { dateStyle: "long" })}</time></p> : null}
                {a.excerpt ? <p>{a.excerpt}</p> : null}
              </article>
            </li>
          ))}
        </ul>
        {data.pages > 1 ? (
          <nav aria-label="Pagination" className="flex justify-center gap-4">
            {page > 1 ? <a className="sk-link" href={`${data.blog.url}?page=${page - 1}${tag ? `&tag=${encodeURIComponent(tag)}` : ""}`}>Newer posts</a> : null}
            {page < data.pages ? <a className="sk-link" href={`${data.blog.url}?page=${page + 1}${tag ? `&tag=${encodeURIComponent(tag)}` : ""}`}>Older posts</a> : null}
          </nav>
        ) : null}
      </div>
    </ThemeShell>
  );
}
