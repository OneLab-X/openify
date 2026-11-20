"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  ["/content/theme", "Theme"],
  ["/content/pages", "Pages & policies"],
  ["/content/blogs", "Blog posts"],
  ["/content/menus", "Navigation"],
  ["/content/redirects", "URL redirects"],
] as const;

export function ContentNav() {
  const path = usePathname();
  return (
    <nav aria-label="Content" className="flex gap-1 overflow-x-auto border-b border-border pb-2">
      {ITEMS.map(([href, label]) => (
        <Link key={href} href={href} aria-current={path.startsWith(href) ? "page" : undefined} className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm ${path.startsWith(href) ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted"}`}>
          {label}
        </Link>
      ))}
    </nav>
  );
}
