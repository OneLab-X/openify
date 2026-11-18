import type { ReactNode } from "react";
import { Sidebar } from "@/components/Sidebar";
import { requireMe } from "@/lib/session";

export default async function ShellLayout({ children }: { children: ReactNode }) {
  const me = await requireMe();
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <Sidebar storeName={me.store.name} logoUrl={me.store.logoUrl} staffName={me.staff.name} />
      <main className="flex-1 px-4 py-6 md:px-8">{children}</main>
    </div>
  );
}
