import { ThemePage } from "@shopkit/theme-default";
import type { TemplateName } from "@shopkit/theme-sdk";
import type { ReactNode } from "react";
import { themeContext } from "@/lib/theme";
import { CartLink } from "./CartLink";

function AccountLink() {
  return (
    <a href="/account" aria-label="Account" className="flex h-11 w-11 items-center justify-center">
      <svg aria-hidden width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
      </svg>
    </a>
  );
}

/** Wraps a page in the theme: header group, the template's sections (with `children` as the main section), footer. */
export async function ThemeShell({ template, children }: { template: TemplateName; children?: ReactNode }) {
  const t = await themeContext(template, { cart: <CartLink />, account: <AccountLink /> }, children);
  if (!t) return <main id="main">{children}</main>;
  return <ThemePage ctx={t.ctx} layout={t.theme.layout} template={t.theme.template} />;
}
