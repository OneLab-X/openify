import { connection } from "next/server";
import { getStore } from "@/lib";

export default async function Home() {
  await connection();
  const { setupRequired, store } = await getStore();

  if (setupRequired || !store) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 px-4 text-center">
        <h1 className="text-3xl font-semibold">Coming soon</h1>
        <p className="text-muted-foreground">This shop is being set up. Please check back shortly.</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 text-center">
      {store.logoUrl ? <img src={store.logoUrl} alt={`${store.name} logo`} className="h-24 w-auto max-w-xs object-contain" /> : null}
      <h1 className="text-4xl font-semibold" style={{ color: store.brand.primaryColor }}>{store.name}</h1>
      <p className="text-muted-foreground">Our products are on their way. Check back soon.</p>
    </main>
  );
}
