import type { TemplateName } from "@shopkit/theme-sdk";
import type { Metadata } from "next";
import { ThemeEditor } from "@/components/theme/ThemeEditor";
import { serverApi } from "@/lib/api-server";

export const metadata: Metadata = { title: "Theme editor" };

export default async function ThemePage() {
  const api = await serverApi();
  const [state, products, collections, menus, pages, blogs, articles] = await Promise.all([
    api.GET("/api/admin/theme"),
    api.GET("/api/admin/products", { params: { query: { status: "active", limit: 100, sort: "title_asc" } } }),
    api.GET("/api/admin/collections", { params: { query: { limit: 200 } } }),
    api.GET("/api/admin/menus"),
    api.GET("/api/admin/pages", { params: { query: { kind: "page" } } }),
    api.GET("/api/admin/blogs"),
    api.GET("/api/admin/articles"),
  ]);
  if (!state.data) return <p>You do not have access to the theme editor.</p>;
  const product = products.data?.items[0];
  const collection = collections.data?.[0];
  const page = pages.data?.items[0];
  const blog = blogs.data?.items[0];
  const article = articles.data?.items.find((a) => a.published);
  const previewPaths: Partial<Record<TemplateName, string>> = {
    index: "/",
    layout: "/",
    product: product ? `/products/${product.handle}` : "/",
    collection: collection ? `/collections/${collection.handle}` : "/collections",
    cart: "/cart",
    search: "/search?q=a",
    page: page ? page.url : "/policies/privacy-policy",
    blog: blog ? blog.url : "/",
    article: article ? article.url : "/",
    account: "/account",
    "404": "/this-page-does-not-exist",
  };
  return (
    <ThemeEditor
      initial={state.data}
      previewPaths={previewPaths}
      pickers={{
        products: (products.data?.items ?? []).map((p) => ({ handle: p.handle, title: p.title })),
        collections: (collections.data ?? []).map((c) => ({ handle: c.handle, title: c.title })),
        menus: (menus.data?.items ?? []).map((m) => ({ handle: m.handle, title: m.title })),
      }}
    />
  );
}
