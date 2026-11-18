import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@shopkit/ui";
import Link from "next/link";
import { requireMe } from "@/lib/session";

export default async function HomePage() {
  const me = await requireMe();
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Welcome, {me.staff.name.split(" ")[0]}</h1>
        <p className="text-sm text-muted-foreground">
          {me.store.name} is live at{" "}
          <a className="text-primary underline" href={me.store.publicUrl ?? "/"}>{me.store.publicUrl}</a>
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          ["Orders today", "0"],
          ["Revenue (7 days)", "—"],
          ["Products", "0"],
        ].map(([label, value]) => (
          <Card key={label}>
            <CardHeader>
              <CardDescription>{label}</CardDescription>
              <CardTitle className="text-3xl">{value}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Next steps</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          <Link className="text-primary underline" href="/settings/payments">Review payment providers</Link>
          <Link className="text-primary underline" href="/settings/staff">Turn on two-factor authentication</Link>
          <p className="text-muted-foreground">Products, orders and customers arrive in the next releases.</p>
        </CardContent>
      </Card>
    </div>
  );
}
