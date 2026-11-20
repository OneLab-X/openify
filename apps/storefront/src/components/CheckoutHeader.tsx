import { getStore } from "@/lib";

/** Checkout and order pages: a calm header with only the shop name (no navigation away from paying). */
export async function CheckoutHeader() {
  const { store } = await getStore();
  return (
    <header className="border-b border-[var(--sk-fg)]/10">
      <div className="sk-container flex items-center justify-between py-4">
        <a href="/" className="flex items-center gap-2 text-lg font-semibold">
          {store?.logoUrl ? <img src={store.logoUrl} alt={`${store.name}`} className="h-8 w-auto" /> : store?.name}
        </a>
        <a href="/cart" className="text-sm underline">
          Back to cart
        </a>
      </div>
    </header>
  );
}
