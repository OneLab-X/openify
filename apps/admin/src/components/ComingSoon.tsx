import { Card, CardDescription, CardHeader, CardTitle } from "@shopkit/ui";

export function ComingSoon({ title, phase }: { title: string; phase: number }) {
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <Card>
        <CardHeader>
          <CardTitle>Coming soon</CardTitle>
          <CardDescription>{title} arrive in phase {phase} of the roadmap.</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
