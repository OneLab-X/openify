import type { ReactNode } from "react";
import { Sidebar } from "@/components/Sidebar";
import { requireMe } from "@/lib/session";
import { TwoFactor } from "./settings/staff/TwoFactor";

export default async function ShellLayout({ children }: { children: ReactNode }) {
  const me = await requireMe();
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <Sidebar storeName={me.store.name} logoUrl={me.store.logoUrl} staffName={me.staff.name} />
      <main className="flex-1 px-4 py-6 md:px-8">
        {me.staff.twoFactorSetupRequired ? (
          <section aria-labelledby="tfa-required" className="mx-auto grid max-w-lg gap-4">
            <h1 id="tfa-required" className="text-2xl font-semibold">
              Set up two-factor authentication
            </h1>
            <p className="text-sm text-muted-foreground">{me.store.name} requires two-factor authentication for every staff account. Add this account to an authenticator app to continue.</p>
            <TwoFactor enabled={false} />
          </section>
        ) : (
          children
        )}
      </main>
    </div>
  );
}
