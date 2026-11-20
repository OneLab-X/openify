"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Theme editor preview (Draft Mode only): the editor posts `sk:refresh` after saving a draft and
 * `sk:select` to highlight a section. Messages are accepted from this origin only (the admin is
 * served from the same host under /admin).
 */
export function PreviewBridge() {
  const router = useRouter();
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin || typeof e.data !== "object" || e.data === null) return;
      const msg = e.data as { type?: string; id?: string };
      if (msg.type === "sk:refresh") router.refresh();
      if (msg.type === "sk:select" && msg.id) {
        document.querySelectorAll("[data-sk-selected]").forEach((el) => el.removeAttribute("data-sk-selected"));
        const el = document.querySelector<HTMLElement>(`[data-section-id="${CSS.escape(msg.id)}"] > *`);
        if (el) {
          el.setAttribute("data-sk-selected", "");
          el.scrollIntoView({ block: "center", behavior: "smooth" });
        }
      }
    };
    window.addEventListener("message", onMessage);
    window.parent?.postMessage({ type: "sk:ready", path: location.pathname }, location.origin);
    return () => window.removeEventListener("message", onMessage);
  }, [router]);
  return (
    <>
      <style>{`[data-sk-selected]{outline:3px solid #2563eb;outline-offset:-3px}`}</style>
      <p className="fixed left-2 top-2 z-[60] rounded bg-black/80 px-2 py-1 text-xs text-white" role="status">
        Preview — draft theme
      </p>
    </>
  );
}
