/** Phase-1 transactional emails. React Email templates arrive with order emails in Phase 3. */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function layout(storeName: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111827;max-width:560px;margin:0 auto;padding:24px">
<p style="font-weight:600;font-size:18px">${escapeHtml(storeName)}</p>${bodyHtml}
<p style="color:#6b7280;font-size:12px;margin-top:32px">Sent by Shopkit</p></body></html>`;
}

export const EMAIL_TEMPLATES = {
  test: (d: { storeName: string }): RenderedEmail => ({
    subject: `Test email from ${d.storeName}`,
    html: layout(d.storeName, "<p>Your email settings work. You can close this message.</p>"),
    text: `${d.storeName}\n\nYour email settings work. You can close this message.`,
  }),
  "store-launched": (d: { storeName: string; ownerName: string; adminUrl: string; shopUrl: string }): RenderedEmail => ({
    subject: `${d.storeName} is live`,
    html: layout(
      d.storeName,
      `<p>Hi ${escapeHtml(d.ownerName)},</p><p>Your store is live at <a href="${escapeHtml(d.shopUrl)}">${escapeHtml(d.shopUrl)}</a>.</p>` +
        `<p><a href="${escapeHtml(d.adminUrl)}">Open your admin</a> to add products.</p>`,
    ),
    text: `Hi ${d.ownerName},\n\nYour store is live at ${d.shopUrl}.\nOpen your admin to add products: ${d.adminUrl}`,
  }),
} as const;
export type EmailTemplate = keyof typeof EMAIL_TEMPLATES;

export function renderEmail<T extends EmailTemplate>(template: T, data: Parameters<(typeof EMAIL_TEMPLATES)[T]>[0]): RenderedEmail {
  return (EMAIL_TEMPLATES[template] as (d: typeof data) => RenderedEmail)(data);
}
