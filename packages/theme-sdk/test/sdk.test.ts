import { describe, expect, it } from "vitest";
import { mapRichtext, newSection, normalizeTemplate, readSettings, resolveTemplate, ThemeValidationError, type SectionSchema, type SettingSchema } from "../src/index.js";

const settings = [
  { id: "title", type: "text", label: "Title", default: "Hello", maxLength: 10 },
  { id: "body", type: "richtext", label: "Body" },
  { id: "color", type: "color", label: "Colour", default: "#112233" },
  { id: "font", type: "font", label: "Font", default: "system" },
  { id: "gap", type: "range", label: "Gap", min: 0, max: 40, step: 4, default: 16 },
  { id: "align", type: "select", label: "Align", options: [{ value: "left", label: "Left" }, { value: "center", label: "Center" }], default: "left" },
  { id: "image", type: "image", label: "Image" },
  { id: "collection", type: "collection", label: "Collection" },
  { id: "menu", type: "menu", label: "Menu", default: "main-menu" },
  { id: "link", type: "url", label: "Link" },
  { id: "show", type: "boolean", label: "Show", default: true },
] as const satisfies readonly SettingSchema[];

const sections: SectionSchema[] = [
  { type: "main-product", name: "Product information", settings: [], main: true, templates: ["product"] },
  {
    type: "slideshow",
    name: "Slideshow",
    settings,
    blocks: [{ type: "slide", name: "Slide", settings: [{ id: "heading", type: "text", label: "Heading", default: "Slide" }, { id: "text", type: "richtext", label: "Text" }] }],
    maxBlocks: 2,
    presetBlocks: [{ type: "slide" }, { type: "slide", settings: { heading: "Second" } }],
  },
  { type: "header", name: "Header", settings: [], templates: ["layout"] },
];

describe("readSettings", () => {
  it("applies defaults and coerces every setting type", () => {
    expect(readSettings(settings, {})).toEqual({
      title: "Hello", body: null, color: "#112233", font: "system", gap: 16, align: "left", image: null, collection: null, menu: "main-menu", link: null, show: true,
    });
    const v = readSettings(settings, {
      title: "A very long title", body: "<p>x</p>", color: "#ABCDEF", font: "serif", gap: "37", align: "center",
      image: { mediaId: "m1", url: "/media/m1/w800.webp", alt: "Alt", width: 800 }, collection: "Summer-Sale", menu: "footer", link: "javascript:alert(1)", show: false, extra: 1,
    });
    expect(v).toEqual({
      title: "A very lon", body: "<p>x</p>", color: "#abcdef", font: "serif", gap: 36, align: "center",
      image: { mediaId: "m1", url: "/media/m1/w800.webp", alt: "Alt", width: 800, height: null }, collection: "summer-sale", menu: "footer", link: null, show: false,
    });
    expect(readSettings(settings, { color: "red", font: "comic", gap: 999, align: "right", image: { mediaId: "m", url: "javascript:x" }, link: "/pages/about" })).toMatchObject({
      color: "#112233", font: "system", gap: 40, align: "left", image: null, link: "/pages/about",
    });
  });
});

describe("templates", () => {
  it("normalises: drops unknown sections and blocks, enforces limits and the main section", () => {
    const { data, issues } = normalizeTemplate({ sections }, "product", {
      sections: {
        main: { type: "main-product", settings: {} },
        hero: {
          type: "slideshow",
          settings: { gap: 5 },
          blocks: { a: { type: "slide", settings: {} }, b: { type: "slide", settings: { heading: "B" } }, c: { type: "slide", settings: {} }, d: { type: "nope", settings: {} } },
          block_order: ["a", "d", "b", "c"],
        },
        head: { type: "header", settings: {} },
      },
      order: ["main", "hero", "head", "ghost", "main"],
    });
    expect(data.order).toEqual(["main", "hero"]);
    expect(data.sections.hero!.block_order).toEqual(["a", "b"]);
    expect(data.sections.hero!.settings.gap).toBe(4);
    expect(issues.map((i) => i.path)).toEqual(["sections.hero.blocks.d", "sections.hero.blocks.c", "sections.head", "order.ghost", "order.main"]);
    expect(() => normalizeTemplate({ sections }, "product", { sections: {}, order: [] })).toThrow(ThemeValidationError);
    expect(() => normalizeTemplate({ sections }, "product", { sections: { x: { type: 1 } }, order: [] })).toThrow(ThemeValidationError);
  });

  it("resolves visible sections in order and maps richtext for sanitising", () => {
    const hero = newSection(sections[1]!, (() => {
      let n = 0;
      return () => `b${++n}`;
    })());
    expect(hero.block_order).toEqual(["b1", "b2"]);
    hero.blocks.b1!.settings.text = "<script>x</script><p>ok</p>";
    const data = { sections: { hero, off: { ...hero, disabled: true } }, order: ["hero", "off"] };
    const clean = mapRichtext({ sections }, data, (h) => h.replace(/<script>.*<\/script>/, ""));
    expect(clean.sections.hero!.blocks.b1!.settings.text).toBe("<p>ok</p>");
    const resolved = resolveTemplate({ sections }, clean);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.blocks.map((b) => b.settings.heading)).toEqual(["Slide", "Second"]);
  });
});
