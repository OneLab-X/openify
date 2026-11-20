import { ImageResponse } from "next/og";
import { getStore } from "@/lib";

/** Built from live data on each request (cached by the CDN headers), never at build time. */
export const dynamic = "force-dynamic";

export const alt = "Shop";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** Default share image: the shop name on its brand colour (product/article pages use their own image). */
export default async function Image() {
  const { store } = await getStore();
  const bg = store?.brand.primaryColor && /^#[0-9a-f]{6}$/i.test(store.brand.primaryColor) ? store.brand.primaryColor : "#18181b";
  const lum = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i]!, 0);
  const fg = lum(bg) > 0.55 ? "#000000" : "#ffffff";
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: bg, color: fg, fontSize: 84, fontWeight: 700, padding: 80, textAlign: "center" }}>
        <div>{store?.name ?? "Shop"}</div>
        {store?.publicUrl ? <div style={{ fontSize: 32, marginTop: 24, opacity: 0.8 }}>{store.publicUrl.replace(/^https?:\/\//, "")}</div> : null}
      </div>
    ),
    size,
  );
}
