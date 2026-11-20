import type { ReactNode } from "react";
import { CheckoutHeader } from "@/components/CheckoutHeader";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <CheckoutHeader />
      <div id="main" className="flex-1">
        {children}
      </div>
    </>
  );
}
