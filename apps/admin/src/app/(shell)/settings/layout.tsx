import type { ReactNode } from "react";
import { SettingsNav } from "./SettingsNav";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <div className="grid gap-6 lg:grid-cols-[200px_1fr]">
        <SettingsNav />
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
