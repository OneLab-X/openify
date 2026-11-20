/** Visible breadcrumb trail (the same items go into BreadcrumbList JSON-LD). */
export function Breadcrumbs({ items }: { items: { name: string; path: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="text-sm">
      <ol className="flex flex-wrap gap-1">
        {items.map((it, i) => (
          <li key={it.path} className="flex items-center gap-1">
            {i < items.length - 1 ? (
              <>
                <a href={it.path} className="hover:underline">
                  {it.name}
                </a>
                <span aria-hidden>/</span>
              </>
            ) : (
              <span aria-current="page">{it.name}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
