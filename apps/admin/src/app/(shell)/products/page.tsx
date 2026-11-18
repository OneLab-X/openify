import type { Metadata } from "next";
import { ComingSoon } from "@/components/ComingSoon";

export const metadata: Metadata = { title: "Products" };

export default function Page() {
  return <ComingSoon title="Products" phase={2} />;
}
