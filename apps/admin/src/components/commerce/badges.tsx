import { Badge } from "@shopkit/ui";

const human = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export function FinancialBadge({ status }: { status: string }) {
  const variant = status === "paid" ? "success" : status === "pending" || status === "authorized" || status === "partially_paid" ? "warning" : "outline";
  return <Badge variant={variant}>{human(status)}</Badge>;
}

export function FulfillmentBadge({ status }: { status: string }) {
  return <Badge variant={status === "fulfilled" ? "success" : status === "unfulfilled" ? "warning" : "secondary"}>{human(status)}</Badge>;
}

export function OrderStatusBadge({ status }: { status: string }) {
  return status === "cancelled" ? <Badge variant="outline">Cancelled</Badge> : status === "closed" ? <Badge variant="secondary">Archived</Badge> : null;
}

export { human };
