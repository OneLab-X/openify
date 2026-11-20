"use client";
import type { Schemas } from "@shopkit/sdk";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Checkbox, Input, Label, Select, Textarea } from "@shopkit/ui";
import { useState } from "react";
import { RichTextEditor } from "@/components/catalog/RichTextEditor";
import { api, errorMessage } from "@/lib/api-client";
import { uploadImage } from "@/lib/media-upload";
import { SeoFields } from "./SeoFields";

type Blog = Schemas["Blog"];
type Article = Schemas["Article"];

/** Blogs and their posts (TipTap content, cover image, tags, publish date, SEO). */
export function BlogsManager({ initialBlogs, initialArticles }: { initialBlogs: Blog[]; initialArticles: Article[] }) {
  const [blogs, setBlogs] = useState(initialBlogs);
  const [articles, setArticles] = useState(initialArticles);
  const [editing, setEditing] = useState<Article | "new" | null>(null);
  const [newBlog, setNewBlog] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function addBlog() {
    const { data, error } = await api.POST("/api/admin/blogs", { body: { title: newBlog } });
    if (!data) return setMsg({ ok: false, text: errorMessage(error) });
    setBlogs([...blogs, data]);
    setNewBlog("");
  }

  return (
    <div className="grid gap-6">
      {msg ? <Alert variant={msg.ok ? "success" : "error"}>{msg.text}</Alert> : null}
      {editing ? (
        <ArticleEditor
          key={editing === "new" ? "new" : editing.id}
          article={editing === "new" ? null : editing}
          blogs={blogs}
          onCancel={() => setEditing(null)}
          onSaved={(a) => {
            setArticles((all) => [a, ...all.filter((x) => x.id !== a.id)]);
            setEditing(null);
            setMsg({ ok: true, text: `${a.title} saved` });
          }}
          onDeleted={(id) => {
            setArticles((all) => all.filter((x) => x.id !== id));
            setEditing(null);
          }}
        />
      ) : null}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Blog posts</CardTitle>
          <Button size="sm" disabled={blogs.length === 0} onClick={() => setEditing("new")}>
            Write post
          </Button>
        </CardHeader>
        <CardContent>
          {articles.length === 0 ? <p className="text-sm text-muted-foreground">No posts yet.</p> : null}
          <ul className="divide-y divide-border text-sm">
            {articles.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <button type="button" className="text-left font-medium hover:underline" onClick={() => setEditing(a)}>
                  {a.title}
                </button>
                <span className="flex items-center gap-2 text-muted-foreground">
                  {a.blogTitle} {a.published ? <Badge variant="success">published</Badge> : <Badge variant="outline">draft</Badge>}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Blogs</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <ul className="divide-y divide-border text-sm">
            {blogs.map((b) => (
              <li key={b.id} className="flex items-center justify-between py-2">
                <span className="font-medium">{b.title}</span>
                <span className="text-muted-foreground">
                  {b.url} · {b.articlesCount} posts
                </span>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Label htmlFor="new-blog" className="sr-only">
              New blog name
            </Label>
            <Input id="new-blog" value={newBlog} placeholder="News, Journal…" onChange={(e) => setNewBlog(e.target.value)} />
            <Button variant="outline" disabled={!newBlog.trim()} onClick={() => void addBlog()}>
              Add blog
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ArticleEditor({ article, blogs, onCancel, onSaved, onDeleted }: { article: Article | null; blogs: Blog[]; onCancel: () => void; onSaved: (a: Article) => void; onDeleted: (id: string) => void }) {
  const [f, setF] = useState({
    blogId: article?.blogId ?? blogs[0]?.id ?? "",
    title: article?.title ?? "",
    handle: article?.handle ?? "",
    author: article?.author ?? "",
    bodyHtml: article?.bodyHtml ?? "",
    excerpt: article?.excerpt ?? "",
    tags: (article?.tags ?? []).join(", "),
    published: article?.published ?? false,
    image: article?.image ?? null,
    seoTitle: article?.seoTitle ?? "",
    seoDescription: article?.seoDescription ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  async function save() {
    const body = {
      blogId: f.blogId,
      title: f.title,
      ...(f.handle ? { handle: f.handle } : {}),
      author: f.author || null,
      bodyHtml: f.bodyHtml,
      excerpt: f.excerpt || null,
      imageMediaId: f.image?.id ?? null,
      tags: f.tags.split(",").map((t) => t.trim()).filter(Boolean),
      published: f.published,
      seoTitle: f.seoTitle || null,
      seoDescription: f.seoDescription || null,
    };
    const res = article ? await api.PUT("/api/admin/articles/{id}", { params: { path: { id: article.id } }, body }) : await api.POST("/api/admin/articles", { body });
    if (res.data) onSaved(res.data);
    else setError(errorMessage(res.error));
  }
  const blog = blogs.find((b) => b.id === f.blogId);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{article ? `Edit ${article.title}` : "New post"}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1">
            <Label htmlFor="ar-title">Title</Label>
            <Input id="ar-title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="ar-blog">Blog</Label>
            <Select id="ar-blog" value={f.blogId} onChange={(e) => setF({ ...f, blogId: e.target.value })}>
              {blogs.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.title}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="ar-handle">URL handle</Label>
            <Input id="ar-handle" value={f.handle} placeholder="made from the title" onChange={(e) => setF({ ...f, handle: e.target.value.toLowerCase() })} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="ar-author">Author</Label>
            <Input id="ar-author" value={f.author} onChange={(e) => setF({ ...f, author: e.target.value })} />
          </div>
        </div>
        <div className="grid gap-1">
          <span id="ar-body-label" className="text-sm font-medium">
            Content
          </span>
          <RichTextEditor id="ar-body" labelledBy="ar-body-label" value={f.bodyHtml} onChange={(bodyHtml) => setF((x) => ({ ...x, bodyHtml }))} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="ar-excerpt">Excerpt (shown in the post list)</Label>
          <Textarea id="ar-excerpt" rows={2} value={f.excerpt} onChange={(e) => setF({ ...f, excerpt: e.target.value })} />
        </div>
        <div className="grid gap-1">
          <span className="text-sm font-medium">Cover image</span>
          {f.image ? <img src={f.image.url} alt="" className="max-h-40 w-auto rounded border border-border" /> : null}
          <div className="flex gap-2">
            <label className="inline-flex h-9 cursor-pointer items-center rounded-md border border-input px-3 text-sm hover:bg-muted">
              {uploading ? "Uploading…" : f.image ? "Replace" : "Upload"}
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                aria-label="Cover image"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setUploading(true);
                  try {
                    const m = await uploadImage(file);
                    setF((x) => ({ ...x, image: m }));
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Upload failed");
                  } finally {
                    setUploading(false);
                  }
                }}
              />
            </label>
            {f.image ? (
              <Button size="sm" variant="ghost" onClick={() => setF({ ...f, image: null })}>
                Remove
              </Button>
            ) : null}
          </div>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="ar-tags">Tags</Label>
          <Input id="ar-tags" value={f.tags} placeholder="launch, how-to" onChange={(e) => setF({ ...f, tags: e.target.value })} />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={f.published} onChange={(e) => setF({ ...f, published: e.target.checked })} /> Published
        </label>
        <SeoFields title={f.seoTitle} description={f.seoDescription} fallbackTitle={f.title} path={`/blogs/${blog?.handle ?? "…"}/${f.handle || "…"}`} onChange={(v) => setF({ ...f, ...v })} />
        {error ? <Alert variant="error">{error}</Alert> : null}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void save()} disabled={!f.title.trim() || !f.blogId}>
            Save
          </Button>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          {article ? (
            <Button
              variant="ghost"
              className="ml-auto"
              onClick={async () => {
                if (!window.confirm(`Delete ${article.title}?`)) return;
                const { error: err } = await api.DELETE("/api/admin/articles/{id}", { params: { path: { id: article.id } } });
                if (err) setError(errorMessage(err));
                else onDeleted(article.id);
              }}
            >
              Delete
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
