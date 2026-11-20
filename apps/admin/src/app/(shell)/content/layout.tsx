import type { ReactNode } from "react";
import { ContentNav } from "./ContentNav";

export default function ContentLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid gap-4">
      <ContentNav />
      {children}
    </div>
  );
}
