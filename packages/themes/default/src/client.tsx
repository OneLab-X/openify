"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * Slideshow controls: previous/next/dots, optional rotation that pauses on hover/focus and never
 * runs for visitors who prefer reduced motion (WCAG 2.2.2 pause, stop, hide).
 */
export function Slideshow({ count, autoplay, seconds, label, children }: { count: number; autoplay: boolean; seconds: number; label: string; children: ReactNode[] }) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const paused = useRef(false);
  const id = useId();
  useEffect(() => {
    if (!autoplay || count < 2) return;
    setPlaying(!window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, [autoplay, count]);
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      if (!paused.current) setIndex((i) => (i + 1) % count);
    }, seconds * 1000);
    return () => clearInterval(t);
  }, [playing, seconds, count]);
  const go = (i: number) => setIndex((i + count) % count);
  return (
    <section
      aria-roledescription="carousel"
      aria-label={label}
      className="relative"
      onMouseEnter={() => (paused.current = true)}
      onMouseLeave={() => (paused.current = false)}
      onFocusCapture={() => (paused.current = true)}
      onBlurCapture={() => (paused.current = false)}
    >
      <div className="sk-slides" aria-live={playing ? "off" : "polite"} id={id}>
        {children.map((child, i) => (
          <div key={i} className="sk-slide" role="group" aria-roledescription="slide" aria-label={`${i + 1} of ${count}`} aria-hidden={i !== index} inert={i !== index}>
            {child}
          </div>
        ))}
      </div>
      {count > 1 ? (
        <div className="absolute inset-x-0 bottom-3 flex items-center justify-center gap-2">
          {autoplay ? (
            <button type="button" onClick={() => setPlaying(!playing)} className="sk-button min-h-11 px-3 text-sm" aria-label={playing ? "Pause slideshow" : "Play slideshow"}>
              {playing ? "❚❚" : "▶"}
            </button>
          ) : null}
          <button type="button" onClick={() => go(index - 1)} className="sk-button min-h-11 px-3" aria-controls={id} aria-label="Previous slide">
            ‹
          </button>
          {children.map((_, i) => (
            <button key={i} type="button" onClick={() => go(i)} aria-label={`Show slide ${i + 1}`} aria-current={i === index} className="flex h-11 w-6 items-center justify-center">
              <span className={`block h-2.5 w-2.5 rounded-full border border-white ${i === index ? "bg-white" : "bg-white/30"}`} />
            </button>
          ))}
          <button type="button" onClick={() => go(index + 1)} className="sk-button min-h-11 px-3" aria-controls={id} aria-label="Next slide">
            ›
          </button>
        </div>
      ) : null}
    </section>
  );
}

/** Email signup: subscribes the address with marketing consent (POST /api/storefront/newsletter). */
export function NewsletterForm({ sectionId }: { sectionId: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const inputId = `nl-${sectionId}`;
  return (
    <form
      className="flex w-full max-w-md flex-col gap-2 sm:flex-row"
      onSubmit={async (e) => {
        e.preventDefault();
        const v = new FormData(e.currentTarget).get("email");
        const email = typeof v === "string" ? v : "";
        setState("busy");
        try {
          const res = await fetch("/api/storefront/newsletter", { method: "POST", headers: { "content-type": "application/json", "x-shopkit-client": "storefront" }, body: JSON.stringify({ email }) });
          if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? "Please try again");
          setState("done");
          setMessage("Thanks for subscribing!");
        } catch (err) {
          setState("error");
          setMessage(err instanceof Error ? err.message : "Please try again");
        }
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        Email address
      </label>
      <input id={inputId} name="email" type="email" required autoComplete="email" placeholder="Email address" className="sk-input flex-1" disabled={state === "done"} />
      <button type="submit" className="sk-button" disabled={state === "busy" || state === "done"}>
        Subscribe
      </button>
      <p role={state === "error" ? "alert" : "status"} className="basis-full text-sm">
        {message}
      </p>
    </form>
  );
}
