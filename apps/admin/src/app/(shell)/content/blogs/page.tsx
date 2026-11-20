import type { Metadata } from "next";
import { BlogsManager } from "@/components/content/BlogsManager";
import { serverApi } from "@/lib/api-server";

export const metadata: Metadata = { title: "Blog posts" };

export default async function BlogsPage() {
  const api = await serverApi();
  const [blogs, articles] = await Promise.all([api.GET("/api/admin/blogs"), api.GET("/api/admin/articles")]);
  if (!blogs.data || !articles.data) return <p>You do not have access to content.</p>;
  return <BlogsManager initialBlogs={blogs.data.items} initialArticles={articles.data.items} />;
}
