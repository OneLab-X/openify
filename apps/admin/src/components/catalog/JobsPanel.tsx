"use client";
import type { Schemas } from "@shopkit/sdk";
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@shopkit/ui";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage, uploadFile } from "@/lib/api-client";

type Job = Schemas["Job"];
const running = (j: Job) => j.status === "queued" || j.status === "running";

/** Polls running jobs once a second so progress shows without reloading. */
export function useJobs(initial: Job[]) {
  const [jobs, setJobs] = useState(initial);
  const ref = useRef(jobs);
  ref.current = jobs;
  useEffect(() => {
    const poll = async () => {
      const active = ref.current.filter(running);
      if (!active.length) return;
      const fresh = await Promise.all(active.map((j) => api.GET("/api/admin/jobs/{id}", { params: { path: { id: j.id } } })));
      setJobs((cur) => cur.map((j) => fresh.find((f) => f.data?.id === j.id)?.data ?? j));
    };
    const t = setInterval(() => void poll(), 1000);
    return () => clearInterval(t);
  }, []);
  return [jobs, setJobs] as const;
}

export function JobRow({ job }: { job: Job }) {
  const pct = job.total ? Math.round((job.processed / job.total) * 100) : job.status === "completed" ? 100 : 0;
  const result = job.result as Record<string, number | string | boolean>;
  const label = job.type === "product_import" ? "Import" : job.type === "product_export" ? "Export" : "Media migration";
  return (
    <li className="grid gap-2 border-t border-border py-3 first:border-t-0" data-testid={`job-${job.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          {label}
          {job.filename ? ` · ${job.filename}` : ""}
        </span>
        <Badge variant={job.status === "completed" ? "success" : job.status === "failed" ? "outline" : "secondary"}>{job.status}</Badge>
      </div>
      <div className="h-2 overflow-hidden rounded bg-muted" role="progressbar" aria-label={`${label} progress`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {job.processed}
        {job.total !== null ? ` of ${job.total}` : ""} processed
        {job.type === "product_import" && job.status === "completed" ? ` · ${String(result.created ?? 0)} created, ${String(result.updated ?? 0)} updated` : ""}
        {job.type === "media_migration" && job.status === "completed" ? ` · ${String(result.moved ?? 0)} moved${result.activated ? ", new provider active" : ""}` : ""}
        {job.errorCount ? ` · ${job.errorCount} error(s)` : ""}
      </p>
      <div className="flex gap-3 text-sm">
        {job.errorCount ? <a className="text-primary underline" href={`/api/admin/jobs/${job.id}/errors.csv`}>Download error report</a> : null}
        {job.type === "product_export" && job.status === "completed" ? <a className="text-primary underline" href={`/api/admin/jobs/${job.id}/download`}>Download CSV</a> : null}
      </div>
    </li>
  );
}

export function JobsPanel({ initial }: { initial: Job[] }) {
  const [jobs, setJobs] = useJobs(initial);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function startImport() {
    if (!file) return;
    setBusy(true);
    setMsg(null);
    const res = await uploadFile("/api/admin/products/import", file);
    setBusy(false);
    if (!res.data) return setMsg({ ok: false, text: errorMessage(res.error) });
    setJobs((cur) => [res.data as unknown as Job, ...cur]);
    setMsg({ ok: true, text: "Import started." });
  }

  async function startExport() {
    setBusy(true);
    const { data, error } = await api.POST("/api/admin/products/export", { body: { filter: {} } });
    setBusy(false);
    if (!data) return setMsg({ ok: false, text: errorMessage(error) });
    setJobs((cur) => [data, ...cur]);
  }

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Import products</CardTitle>
          <CardDescription>Shopify product CSV, up to 20 MB. Images are downloaded from their URLs.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <input type="file" accept=".csv,text/csv" aria-label="Product CSV file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <Button onClick={() => void startImport()} disabled={!file || busy} loading={busy} className="justify-self-start">Start import</Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Export products</CardTitle>
          <CardDescription>All products as a Shopify-compatible CSV.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => void startExport()} disabled={busy}>Export all products</Button>
        </CardContent>
      </Card>
      {msg ? <Alert variant={msg.ok ? "success" : "error"} className="md:col-span-2">{msg.text}</Alert> : null}
      <Card className="md:col-span-2">
        <CardHeader><CardTitle>Recent jobs</CardTitle></CardHeader>
        <CardContent>
          {jobs.length ? <ul aria-label="Jobs">{jobs.map((j) => <JobRow key={j.id} job={j} />)}</ul> : <p className="text-sm text-muted-foreground">No imports or exports yet.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
