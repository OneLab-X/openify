"use client";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { track } from "@/lib/track";

type Provider = { id: string; head: string; body: string; requiresConsent: boolean };
type Consent = "granted" | "denied" | null;
const KEY = "sk_consent";

const readConsent = (): Consent => {
  try {
    const v = localStorage.getItem(KEY);
    return v === "granted" || v === "denied" ? v : null;
  } catch {
    return null;
  }
};

/** Adds a provider's snippet HTML; <script> elements are re-created so the browser runs them. */
function inject(html: string, target: HTMLElement, id: string) {
  if (!html || document.querySelector(`[data-sk-analytics="${id}"]`)) return;
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  for (const node of Array.from(tpl.content.childNodes)) {
    if (node instanceof HTMLScriptElement) {
      const s = document.createElement("script");
      for (const a of Array.from(node.attributes)) s.setAttribute(a.name, a.value);
      s.text = node.text;
      s.dataset.skAnalytics = id;
      target.appendChild(s);
    } else if (node instanceof HTMLElement) {
      node.dataset.skAnalytics = id;
      target.appendChild(node);
    }
  }
}

/**
 * Analytics loader (SPEC §12): snippets that need consent load only after "Accept"; nothing
 * third-party is requested before. The banner reappears via "Cookie settings" in the footer area.
 */
export function Analytics({ providers, banner }: { providers: Provider[]; banner: boolean }) {
  const pathname = usePathname();
  const [consent, setConsent] = useState<Consent>(null);
  const [ready, setReady] = useState(false);
  const needsConsent = banner && providers.some((p) => p.requiresConsent);
  const first = useRef(true);

  useEffect(() => {
    setConsent(readConsent());
    setReady(true);
    const reopen = () => setConsent(null);
    window.addEventListener("sk:consent-settings", reopen);
    return () => window.removeEventListener("sk:consent-settings", reopen);
  }, []);

  useEffect(() => {
    if (!ready) return;
    for (const p of providers) {
      if (p.requiresConsent && consent !== "granted") continue;
      inject(p.head, document.head, `${p.id}-head`);
      inject(p.body, document.body, `${p.id}-body`);
    }
  }, [ready, consent, providers]);

  useEffect(() => {
    // First paint is counted by the trackers' own snippets; first-party gets every page.
    track("page_view");
    if (first.current) {
      first.current = false;
      return;
    }
    // GA4, Plausible, Umami and PostHog follow client-side navigation themselves.
    const w = window as Window & { _paq?: unknown[][]; fbq?: (...a: unknown[]) => void };
    try {
      w._paq?.push(["setCustomUrl", location.href], ["trackPageView"]);
      w.fbq?.("track", "PageView");
    } catch {
      /* ignore */
    }
  }, [pathname]);

  if (!ready || !needsConsent || consent !== null) return null;
  const decide = (v: "granted" | "denied") => {
    try {
      localStorage.setItem(KEY, v);
    } catch {
      /* private mode: decision lasts for this page */
    }
    setConsent(v);
  };
  return (
    <section role="dialog" aria-modal="false" aria-labelledby="sk-consent-title" aria-describedby="sk-consent-text" className="fixed inset-x-0 bottom-0 z-50 border-t border-[var(--sk-fg)]/15 bg-[var(--sk-bg)] p-4 text-[var(--sk-fg)] shadow-lg" data-testid="consent-banner">
      <div className="sk-container flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 id="sk-consent-title" className="font-semibold">
            Cookies and analytics
          </h2>
          <p id="sk-consent-text" className="text-sm">
            We use analytics cookies to understand how the shop is used and improve it. They load only if you accept.
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" className="sk-button sk-button-outline" onClick={() => decide("denied")}>
            Decline
          </button>
          <button type="button" className="sk-button" onClick={() => decide("granted")}>
            Accept
          </button>
        </div>
      </div>
    </section>
  );
}

/** Footer link that reopens the banner. */
export function ConsentSettingsLink() {
  return (
    <button type="button" className="sk-container block min-h-8 py-2 text-left text-xs underline" onClick={() => window.dispatchEvent(new Event("sk:consent-settings"))}>
      Cookie settings
    </button>
  );
}
