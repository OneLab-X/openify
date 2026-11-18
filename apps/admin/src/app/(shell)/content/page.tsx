import type { Metadata } from "next";
import { ComingSoon } from "@/components/ComingSoon";

export const metadata: Metadata = { title: "Content" };

export default function Page() {
  return <ComingSoon title="Content" phase={5} />;
}
