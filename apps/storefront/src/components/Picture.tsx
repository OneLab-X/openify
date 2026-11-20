import type { Media } from "@/lib";

/** AVIF/WebP renditions from the images queue, falling back to the original while they are made. */
export function Picture({ media, alt, sizes, className, priority = false }: { media: Media; alt: string; sizes: string; className?: string; priority?: boolean }) {
  const set = (format: "avif" | "webp") =>
    media.sources
      .filter((s) => s.format === format)
      .map((s) => `${s.url} ${s.width}w`)
      .join(", ");
  const avif = set("avif");
  const webp = set("webp");
  return (
    <picture>
      {avif ? <source type="image/avif" srcSet={avif} sizes={sizes} /> : null}
      {webp ? <source type="image/webp" srcSet={webp} sizes={sizes} /> : null}
      <img
        src={media.url}
        alt={media.alt ?? alt}
        width={media.width ?? undefined}
        height={media.height ?? undefined}
        loading={priority ? "eager" : "lazy"}
        fetchPriority={priority ? "high" : undefined}
        decoding="async"
        className={className}
      />
    </picture>
  );
}
