/** Attribute/JS-string escaping for analytics snippets (config values are also regex-validated). */
export const attr = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const js = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
export const trimSlash = (u: string) => u.replace(/\/+$/, "");
