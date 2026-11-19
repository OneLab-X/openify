"use client";
import type { Schemas } from "@shopkit/sdk";
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Select } from "@shopkit/ui";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api-client";
import { JobRow, useJobs } from "./catalog/JobsPanel";

/** Settings → Storage: copy every media file to another saved provider, then switch to it. */
export function MigrateMedia({ credentials, active, jobs: initial }: { credentials: Schemas["CredentialSummary"][]; active: { provider: string; mode: string }; jobs: Schemas["Job"][] }) {
  const targets = credentials.filter((c) => c.kind === "storage" && c.enabled && c.provider !== active.provider);
  const [target, setTarget] = useState(targets[0] ? `${targets[0].provider}:${targets[0].mode}` : "");
  const [jobs, setJobs] = useJobs(initial);
  const [msg, setMsg] = useState<string | null>(null);
  const running = jobs.some((j) => j.status === "queued" || j.status === "running");

  async function start() {
    const [provider, mode] = target.split(":");
    if (!provider || !window.confirm(`Copy all media to ${provider} and make it the active provider? Files stay on ${active.provider} until you remove them.`)) return;
    const { data, error } = await api.POST("/api/admin/storage/migrate", { body: { provider, mode: mode === "test" ? "test" : "live" } });
    if (!data) return setMsg(errorMessage(error));
    setMsg(null);
    setJobs((cur) => [data, ...cur]);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Migrate media to a new provider</CardTitle>
        <CardDescription>Copies product images, renditions and brand assets, then switches the active provider. Save the new provider above first.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {targets.length ? (
          <div className="flex items-end gap-2">
            <Field id="migrate-target" label="Copy media to" className="min-w-64">
              <Select id="migrate-target" value={target} onChange={(e) => setTarget(e.target.value)}>
                {targets.map((c) => <option key={c.id} value={`${c.provider}:${c.mode}`}>{c.provider} ({c.mode})</option>)}
              </Select>
            </Field>
            <Button onClick={() => void start()} disabled={running}>Start migration</Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Save and enable another storage provider to migrate media to it.</p>
        )}
        {msg ? <Alert variant="error">{msg}</Alert> : null}
        {jobs.length ? <ul aria-label="Migrations">{jobs.slice(0, 5).map((j) => <JobRow key={j.id} job={j} />)}</ul> : null}
      </CardContent>
    </Card>
  );
}
