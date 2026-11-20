import { normalizeTemplate, TEMPLATE_NAMES } from "@shopkit/theme-sdk";
import { describe, expect, it } from "vitest";
import { globalSettings, readableOn, SECTION_COMPONENTS, themeStyle, THEME } from "../src/index.js";

describe("default theme", () => {
  it("ships a valid template for every template name, each with exactly one main section", () => {
    for (const name of TEMPLATE_NAMES) {
      const { data, issues } = normalizeTemplate(THEME, name, THEME.templates[name]);
      expect(issues, name).toEqual([]);
      expect(data.order.length, name).toBeGreaterThan(0);
    }
  });

  it("has a component for every non-main section", () => {
    for (const s of THEME.sections) if (!s.main) expect(SECTION_COMPONENTS[s.type], s.type).toBeTruthy();
  });

  it("uses the brand colour as accent until overridden and keeps text readable on it", () => {
    expect(globalSettings({}, { primaryColor: "#facc15" }).color_accent).toBe("#facc15");
    expect(globalSettings({ color_accent: "#112233" }, { primaryColor: "#facc15" }).color_accent).toBe("#112233");
    expect(readableOn("#facc15")).toBe("#000000");
    expect(readableOn("#1e3a8a")).toBe("#ffffff");
    const style = themeStyle(globalSettings({ color_accent: "#fde68a" }, {})) as Record<string, string>;
    // A pale accent is unreadable as link text on white: links fall back to the text colour.
    expect(style["--sk-link"]).toBe("#18181b");
    expect(style["--sk-accent-fg"]).toBe("#000000");
  });
});
