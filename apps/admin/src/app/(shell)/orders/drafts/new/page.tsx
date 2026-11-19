import type { Metadata } from "next";
import { DraftEditor } from "@/components/commerce/DraftEditor";

export const metadata: Metadata = { title: "Create order" };

export default function NewDraftPage() {
  return <DraftEditor initial={null} />;
}
