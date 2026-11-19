import type { Metadata } from "next";
import { CustomerDetail } from "@/components/commerce/CustomerDetail";

export const metadata: Metadata = { title: "Add customer" };

export default function NewCustomerPage() {
  return <CustomerDetail initial={null} />;
}
