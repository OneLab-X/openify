import type { SectionProps, ThemeMenuItem } from "../types.js";
import { bool, Container, img, num, scheme, str } from "../util.js";

export function AnnouncementBar({ settings, blocks }: SectionProps) {
  const items = blocks.filter((b) => str(b.settings.text));
  if (items.length === 0) return null;
  return (
    <aside aria-label="Announcements" className={`${scheme(settings.color_scheme)} text-sm`}>
      <Container className="flex flex-wrap items-center justify-center gap-x-6 gap-y-1 py-2 text-center">
        {items.map((b) =>
          str(b.settings.link) ? (
            <a key={b.id} href={str(b.settings.link)} className="underline underline-offset-2">
              {str(b.settings.text)}
            </a>
          ) : (
            <p key={b.id}>{str(b.settings.text)}</p>
          ),
        )}
      </Container>
    </aside>
  );
}

function MenuList({ items, depth = 0 }: { items: ThemeMenuItem[]; depth?: number }) {
  return (
    <ul className={depth === 0 ? "flex flex-col gap-1 md:flex-row md:items-center md:gap-4" : "grid gap-1 py-1 pl-3 md:absolute md:z-30 md:min-w-48 md:rounded-[var(--sk-radius)] md:bg-[var(--sk-bg)] md:p-3 md:pl-3 md:shadow-lg"}>
      {items.map((item) => (
        <li key={`${item.title}${item.url}`} className="relative">
          {item.items.length ? (
            <details>
              <summary className="flex min-h-11 items-center gap-1 py-2">
                {item.title}
                <span aria-hidden>▾</span>
              </summary>
              <MenuList items={[{ title: `All ${item.title}`, url: item.url, items: [] }, ...item.items]} depth={depth + 1} />
            </details>
          ) : (
            <a href={item.url} className="flex min-h-11 items-center py-2 hover:underline">
              {item.title}
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

export async function Header({ settings, ctx }: SectionProps) {
  const menu = str(settings.menu) ? await ctx.data.menu(str(settings.menu)) : [];
  const logo = img(ctx.settings.logo) ?? ctx.store.logo;
  const width = num(ctx.settings.logo_width, 120);
  return (
    <header className={`${scheme(settings.color_scheme)} border-b border-current/10 ${bool(settings.sticky) ? "sk-sticky" : ""}`}>
      <Container className="sk-menu flex items-center justify-between gap-4 py-3">
        <div className="flex items-center gap-3">
          {menu.length ? (
            <details className="md:hidden">
              <summary aria-label="Menu" className="flex h-11 w-11 items-center justify-center">
                <svg aria-hidden width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 6h18M3 12h18M3 18h18" />
                </svg>
              </summary>
              <nav aria-label="Main" className="absolute left-0 right-0 z-40 border-b border-current/10 bg-[var(--sk-bg)] px-4 pb-4 text-[var(--sk-fg)]">
                <MenuList items={menu} />
              </nav>
            </details>
          ) : null}
          <a href="/" className="flex items-center gap-2 text-lg font-semibold">
            {logo ? (
              <img src={logo.url} alt={ctx.store.name} width={width} height={logo.width && logo.height ? Math.round((width * logo.height) / logo.width) : undefined} style={{ width, height: "auto" }} />
            ) : (
              ctx.store.name
            )}
          </a>
        </div>
        {menu.length ? (
          <nav aria-label="Main" className="hidden md:block">
            <MenuList items={menu} />
          </nav>
        ) : null}
        <div className="flex items-center gap-1">
          {bool(settings.show_search) ? (
            <form action="/search" role="search" className="hidden sm:flex">
              <label htmlFor="sk-search" className="sr-only">
                Search products
              </label>
              <input id="sk-search" name="q" type="search" placeholder="Search" className="sk-input h-11 w-40 lg:w-56" />
            </form>
          ) : null}
          {bool(settings.show_search) ? (
            <a href="/search" aria-label="Search" className="flex h-11 w-11 items-center justify-center sm:hidden">
              <svg aria-hidden width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
            </a>
          ) : null}
          {ctx.slots.account}
          {ctx.slots.cart}
        </div>
      </Container>
    </header>
  );
}

const SOCIAL: [string, string][] = [
  ["social_instagram", "Instagram"],
  ["social_facebook", "Facebook"],
  ["social_youtube", "YouTube"],
  ["social_whatsapp", "WhatsApp"],
];

export async function Footer({ settings, blocks, ctx }: SectionProps) {
  const menus = await Promise.all(blocks.map(async (b) => (b.type === "menu" && str(b.settings.menu) ? ctx.data.menu(str(b.settings.menu)) : [])));
  const policies = bool(settings.show_policies) ? await ctx.data.policies() : [];
  const social = bool(settings.show_social) ? SOCIAL.filter(([k]) => str(ctx.settings[k])) : [];
  const year = new Date().getFullYear();
  return (
    <footer className={`${scheme(settings.color_scheme)} mt-auto text-sm`}>
      <Container className="grid gap-8 py-10 sm:grid-cols-2 lg:grid-cols-4">
        {blocks.map((b, i) => (
          <section key={b.id} aria-labelledby={`f-${b.id}`} className="grid content-start gap-2">
            <h2 id={`f-${b.id}`} className="text-base font-semibold">
              {str(b.settings.heading)}
            </h2>
            {b.type === "menu" ? (
              <ul className="grid gap-1">
                {menus[i]!.map((m) => (
                  <li key={m.url + m.title}>
                    <a href={m.url} className="inline-flex min-h-8 items-center hover:underline">
                      {m.title}
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="sk-rte" dangerouslySetInnerHTML={{ __html: str(b.settings.text) }} />
            )}
          </section>
        ))}
        {social.length ? (
          <section aria-labelledby="f-social" className="grid content-start gap-2">
            <h2 id="f-social" className="text-base font-semibold">
              Follow us
            </h2>
            <ul className="grid gap-1">
              {social.map(([k, label]) => (
                <li key={k}>
                  <a href={str(ctx.settings[k])} rel="noopener noreferrer me" className="inline-flex min-h-8 items-center hover:underline">
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </Container>
      <Container className="flex flex-col gap-3 border-t border-current/15 py-5 sm:flex-row sm:items-center sm:justify-between">
        <p>{str(settings.copyright) || `© ${year} ${ctx.store.name}`}</p>
        {policies.length ? (
          <ul className="flex flex-wrap gap-x-4 gap-y-1" aria-label="Policies">
            {policies.map((p) => (
              <li key={p.url}>
                <a href={p.url} className="inline-flex min-h-8 items-center hover:underline">
                  {p.title}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </Container>
    </footer>
  );
}

