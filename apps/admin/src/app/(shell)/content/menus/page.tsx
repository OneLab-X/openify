import type { Metadata } from "next";
import { MenusManager } from "@/components/content/MenusManager";
import { serverApi } from "@/lib/api-server";

export const metadata: Metadata = { title: "Navigation" };

export default async function MenusPage() {
  const api = await serverApi();
  const [menus, collections, products, pages, blogs, articles] = await Promise.all([
    api.GET("/api/admin/menus"),
    api.GET("/api/admin/collections", { params: { query: { limit: 200 } } }),
    api.GET("/api/admin/products", { params: { query: { status: "active", limit: 100, sort: "title_asc" } } }),
    api.GET("/api/admin/pages"),
    api.GET("/api/admin/blogs"),
    api.GET("/api/admin/articles"),
  ]);
  if (!menus.data) return <p>You do not have access to content.</p>;
  const allPages = pages.data?.items ?? [];
  return (
    <MenusManager
      initial={menus.data.items}
      resources={{
        collection: (collections.data ?? []).map((c) => ({ id: c.id, title: c.title })),
        product: (products.data?.items ?? []).map((p) => ({ id: p.id, title: p.title })),
        page: allPages.filter((p) => p.kind === "page").map((p) => ({ id: p.id, title: p.title })),
        policy: allPages.filter((p) => p.kind === "policy").map((p) => ({ id: p.id, title: p.title })),
        blog: (blogs.data?.items ?? []).map((b) => ({ id: b.id, title: b.title })),
        article: (articles.data?.items ?? []).map((a) => ({ id: a.id, title: a.title })),
      }}
    />
  );
}
