import type { CSSProperties, ReactNode } from "react";

/**
 * Minimal email building blocks rendered with @react-email/render. Table layout and inline styles
 * only, which every mail client understands (React Email's component package is deprecated; these
 * are the few pieces the order emails need).
 */
const font = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
export const colors = { text: "#111827", muted: "#6b7280", border: "#e5e7eb", bg: "#f9fafb" };

export function Layout({ shopName, logoUrl, preview, accent, children }: { shopName: string; logoUrl?: string | null; preview: string; accent?: string | null; children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{shopName}</title>
      </head>
      <body style={{ margin: 0, padding: 0, background: colors.bg, fontFamily: font, color: colors.text }}>
        <div style={{ display: "none", maxHeight: 0, overflow: "hidden" }}>{preview}</div>
        <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} style={{ background: colors.bg }}>
          <tbody>
            <tr>
              <td align="center" style={{ padding: "24px 12px" }}>
                <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} style={{ maxWidth: 560, background: "#ffffff", border: `1px solid ${colors.border}`, borderRadius: 8 }}>
                  <tbody>
                    <tr>
                      <td style={{ padding: "24px 24px 8px", borderTop: accent ? `4px solid ${accent}` : undefined, borderRadius: 8 }}>
                        {logoUrl ? <img src={logoUrl} alt={shopName} height={40} style={{ display: "block", height: 40 }} /> : <p style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{shopName}</p>}
                      </td>
                    </tr>
                    <tr>
                      <td style={{ padding: "8px 24px 24px", fontSize: 15, lineHeight: "22px" }}>{children}</td>
                    </tr>
                  </tbody>
                </table>
                <p style={{ color: colors.muted, fontSize: 12, marginTop: 16 }}>{shopName}</p>
              </td>
            </tr>
          </tbody>
        </table>
      </body>
    </html>
  );
}

export const H1 = ({ children }: { children: ReactNode }) => <h1 style={{ fontSize: 22, lineHeight: "28px", margin: "8px 0 12px" }}>{children}</h1>;
export const P = ({ children, muted, style }: { children: ReactNode; muted?: boolean; style?: CSSProperties }) => (
  <p style={{ margin: "0 0 12px", color: muted ? colors.muted : colors.text, whiteSpace: "pre-line", ...style }}>{children}</p>
);

export function Button({ href, children, color }: { href: string; children: ReactNode; color?: string | null }) {
  return (
    <table role="presentation" cellPadding={0} cellSpacing={0} style={{ margin: "16px 0" }}>
      <tbody>
        <tr>
          <td style={{ background: color || "#111827", borderRadius: 6 }}>
            <a href={href} style={{ display: "inline-block", padding: "12px 20px", color: "#ffffff", textDecoration: "none", fontWeight: 600 }}>
              {children}
            </a>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

export interface EmailLine {
  title: string;
  variantTitle: string | null;
  quantity: number;
  total: string;
}

export function Lines({ lines }: { lines: EmailLine[] }) {
  return (
    <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} style={{ borderTop: `1px solid ${colors.border}`, margin: "12px 0" }}>
      <tbody>
        {lines.map((l, i) => (
          <tr key={i}>
            <td style={{ padding: "8px 0", borderBottom: `1px solid ${colors.border}` }}>
              {l.title}
              {l.variantTitle ? <span style={{ color: colors.muted }}> · {l.variantTitle}</span> : null} × {l.quantity}
            </td>
            <td align="right" style={{ padding: "8px 0", borderBottom: `1px solid ${colors.border}`, whiteSpace: "nowrap" }}>
              {l.total}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Totals({ rows }: { rows: { label: string; value: string; strong?: boolean }[] }) {
  return (
    <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} style={{ margin: "4px 0 16px" }}>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td style={{ padding: "2px 0", color: r.strong ? colors.text : colors.muted, fontWeight: r.strong ? 600 : 400 }}>{r.label}</td>
            <td align="right" style={{ padding: "2px 0", fontWeight: r.strong ? 600 : 400 }}>
              {r.value}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export const Address = ({ title, lines }: { title: string; lines: string[] }) =>
  lines.length ? (
    <div style={{ margin: "12px 0" }}>
      <p style={{ margin: "0 0 4px", fontWeight: 600 }}>{title}</p>
      <p style={{ margin: 0, color: colors.muted, whiteSpace: "pre-line" }}>{lines.join("\n")}</p>
    </div>
  ) : null;
