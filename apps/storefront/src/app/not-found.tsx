import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-3xl font-semibold">Page not found</h1>
      <Link href="/" className="underline">Back to the shop</Link>
    </main>
  );
}
