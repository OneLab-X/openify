import { ThemeShell } from "@/components/ThemeShell";

export default function NotFound() {
  return (
    <ThemeShell template="404">
      <div className="sk-container grid justify-items-center gap-4 py-16 text-center">
        <h1 className="text-3xl font-semibold">Page not found</h1>
        <p>The page you were looking for does not exist or has moved.</p>
        <form action="/search" role="search" className="flex w-full max-w-md gap-2">
          <label htmlFor="nf-q" className="sr-only">
            Search the shop
          </label>
          <input id="nf-q" name="q" type="search" className="sk-input flex-1" placeholder="Search" />
          <button type="submit" className="sk-button">
            Search
          </button>
        </form>
        <a href="/" className="sk-link">
          Back to the home page
        </a>
      </div>
    </ThemeShell>
  );
}
