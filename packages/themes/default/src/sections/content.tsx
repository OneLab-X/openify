import { NewsletterForm, Slideshow } from "../client.js";
import type { SectionProps, ThemeProductCard } from "../types.js";
import { bool, ButtonLink, Container, img, Img, num, pad, Price, scheme, str } from "../util.js";

const HEIGHT: Record<string, string> = { small: "min-h-[320px] md:min-h-[400px]", medium: "min-h-[420px] md:min-h-[540px]", large: "min-h-[520px] md:min-h-[680px]" };

export function SlideshowSection({ id, settings, blocks, first }: SectionProps) {
  const slides = blocks.map((b, i) => {
    const image = img(b.settings.image);
    const center = str(b.settings.align) !== "left";
    return (
      <div key={b.id} className={`relative flex items-center overflow-hidden ${HEIGHT[str(settings.height)] ?? HEIGHT.medium} ${image ? "text-white" : "sk-scheme-muted"}`}>
        {image ? (
          <>
            <Img image={image} alt="" sizes="100vw" priority={first && i === 0} className="absolute inset-0 h-full w-full object-cover" />
            <div aria-hidden className="absolute inset-0 bg-black" style={{ opacity: num(settings.overlay, 30) / 100 }} />
          </>
        ) : null}
        <Container className={`relative grid gap-4 py-16 ${center ? "justify-items-center text-center" : ""}`}>
          {str(b.settings.heading) ? <h2 className="max-w-3xl text-3xl font-semibold md:text-5xl">{str(b.settings.heading)}</h2> : null}
          {str(b.settings.text) ? <p className="max-w-xl text-lg">{str(b.settings.text)}</p> : null}
          {str(b.settings.button_label) && str(b.settings.button_link) ? <ButtonLink href={str(b.settings.button_link)} label={str(b.settings.button_label)} /> : null}
        </Container>
      </div>
    );
  });
  if (slides.length === 0) return null;
  if (slides.length === 1) return <section aria-label="Featured">{slides[0]}</section>;
  return (
    <Slideshow count={slides.length} autoplay={bool(settings.autoplay)} seconds={num(settings.speed, 6)} label={`Slideshow ${id}`}>
      {slides}
    </Slideshow>
  );
}

const COLS: Record<number, string> = { 2: "lg:grid-cols-2", 3: "lg:grid-cols-3", 4: "lg:grid-cols-4", 5: "lg:grid-cols-5" };

export function ProductCardView({ p, locale, headingLevel = 3 }: { p: ThemeProductCard; locale: string; headingLevel?: 2 | 3 }) {
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <a href={`/products/${p.handle}`} className="group grid gap-2">
      <div className="sk-card-image">
        {p.image ? <Img image={p.image} alt={p.title} sizes="(min-width: 1024px) 25vw, 50vw" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" /> : null}
      </div>
      <H className="text-sm font-medium group-hover:underline">{p.title}</H>
      <div className="text-sm">
        <Price p={p} locale={locale} />
      </div>
      {!p.available ? <p className="text-xs opacity-75">Sold out</p> : null}
    </a>
  );
}

export async function FeaturedCollection({ id, settings, ctx }: SectionProps) {
  const { title, url, items } = await ctx.data.products({ collection: str(settings.collection) || null, limit: num(settings.limit, 8) });
  if (items.length === 0) return null;
  const heading = str(settings.heading) || title || "Products";
  return (
    <section aria-labelledby={`h-${id}`} className={`${scheme(settings.color_scheme)} ${pad(settings.padding)}`}>
      <Container className="grid gap-6">
        <div className="flex items-end justify-between gap-4">
          <h2 id={`h-${id}`} className="text-2xl font-semibold">
            {heading}
          </h2>
          {bool(settings.show_view_all) ? (
            <a href={url} className="sk-link text-sm">
              View all<span className="sr-only"> {heading}</span>
            </a>
          ) : null}
        </div>
        <ul className={`grid grid-cols-2 gap-x-4 gap-y-8 ${COLS[num(settings.columns, 4)] ?? COLS[4]}`}>
          {items.map((p) => (
            <li key={p.handle}>
              <ProductCardView p={p} locale={ctx.store.locale} />
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}

export async function FeaturedProduct({ id, settings, ctx }: SectionProps) {
  const p = str(settings.product) ? await ctx.data.product(str(settings.product)) : null;
  if (!p) return null;
  return (
    <section aria-labelledby={`h-${id}`} className={`${scheme(settings.color_scheme)} ${pad(settings.padding)}`}>
      <Container className="grid items-center gap-8 md:grid-cols-2">
        <div className="sk-card-image">{p.image ? <Img image={p.image} alt={p.title} sizes="(min-width: 768px) 50vw, 100vw" className="h-full w-full object-cover" /> : null}</div>
        <div className="grid content-center gap-4">
          {p.vendor ? <p className="text-sm uppercase tracking-wide opacity-75">{p.vendor}</p> : null}
          <h2 id={`h-${id}`} className="text-3xl font-semibold">
            {p.title}
          </h2>
          <div className="text-lg">
            <Price p={p} locale={ctx.store.locale} />
          </div>
          {bool(settings.show_description) && p.descriptionHtml ? <div className="sk-rte line-clamp-6" dangerouslySetInnerHTML={{ __html: p.descriptionHtml }} /> : null}
          <div>
            <ButtonLink href={`/products/${p.handle}`} label={p.available ? "View product" : "Sold out — view product"} />
          </div>
        </div>
      </Container>
    </section>
  );
}

export function ImageWithText({ id, settings, first }: SectionProps) {
  const image = img(settings.image);
  const right = str(settings.image_position) === "right";
  return (
    <section aria-labelledby={`h-${id}`} className={`${scheme(settings.color_scheme)} ${pad(settings.padding)}`}>
      <Container className="grid items-center gap-8 md:grid-cols-2">
        <div className={`sk-rounded aspect-[4/3] overflow-hidden bg-[var(--sk-muted)] ${right ? "md:order-2" : ""}`}>
          {image ? <Img image={image} alt="" sizes="(min-width: 768px) 50vw, 100vw" priority={first} className="h-full w-full object-cover" /> : null}
        </div>
        <div className="grid content-center gap-4">
          <h2 id={`h-${id}`} className="text-2xl font-semibold md:text-3xl">
            {str(settings.heading)}
          </h2>
          <div className="sk-rte" dangerouslySetInnerHTML={{ __html: str(settings.text) }} />
          {str(settings.button_label) && str(settings.button_link) ? (
            <div>
              <ButtonLink href={str(settings.button_link)} label={str(settings.button_label)} />
            </div>
          ) : null}
        </div>
      </Container>
    </section>
  );
}

export function RichText({ id, settings }: SectionProps) {
  const center = str(settings.align) === "center";
  return (
    <section aria-labelledby={str(settings.heading) ? `h-${id}` : undefined} className={`${scheme(settings.color_scheme)} ${pad(settings.padding)}`}>
      <Container className={`grid max-w-3xl gap-4 ${center ? "justify-items-center text-center" : ""}`}>
        {str(settings.heading) ? (
          <h2 id={`h-${id}`} className="text-2xl font-semibold md:text-3xl">
            {str(settings.heading)}
          </h2>
        ) : null}
        <div className="sk-rte" dangerouslySetInnerHTML={{ __html: str(settings.text) }} />
        {str(settings.button_label) && str(settings.button_link) ? <ButtonLink href={str(settings.button_link)} label={str(settings.button_label)} variant="outline" /> : null}
      </Container>
    </section>
  );
}

function Stars({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <p aria-label={`Rated ${n} out of 5`} className="tracking-widest">
      <span aria-hidden>{"★".repeat(n)}{"☆".repeat(5 - n)}</span>
    </p>
  );
}

export function Testimonials({ id, settings, blocks }: SectionProps) {
  if (blocks.length === 0) return null;
  return (
    <section aria-labelledby={`h-${id}`} className={`${scheme(settings.color_scheme)} ${pad(settings.padding)}`}>
      <Container className="grid gap-6">
        <h2 id={`h-${id}`} className="text-center text-2xl font-semibold">
          {str(settings.heading)}
        </h2>
        <ul className="grid gap-4 md:grid-cols-3">
          {blocks.map((b) => (
            <li key={b.id}>
              <figure className="sk-rounded grid h-full content-start gap-3 border border-current/15 p-5">
                <Stars n={num(b.settings.rating)} />
                <blockquote className="text-base">“{str(b.settings.quote)}”</blockquote>
                <figcaption className="text-sm font-semibold">— {str(b.settings.author)}</figcaption>
              </figure>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}

export function Newsletter({ id, settings }: SectionProps) {
  return (
    <section aria-labelledby={`h-${id}`} className={`${scheme(settings.color_scheme)} ${pad(settings.padding)}`}>
      <Container className="grid justify-items-center gap-3 text-center">
        <h2 id={`h-${id}`} className="text-2xl font-semibold">
          {str(settings.heading)}
        </h2>
        {str(settings.text) ? <p className="max-w-xl">{str(settings.text)}</p> : null}
        <NewsletterForm sectionId={id} />
      </Container>
    </section>
  );
}

/** The page's own content in the theme's container (every `main-*` section). */
export function MainContent({ settings, ctx }: SectionProps) {
  return <div className={pad(settings.padding)}>{ctx.main}</div>;
}
