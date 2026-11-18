import type { Metadata } from "next";
import { ComingSoon } from "@/components/ComingSoon";

export const metadata: Metadata = { title: "Orders" };

export default function Page() {
  return <ComingSoon title="Orders" phase={3} />;
}
