"use client";
import { Alert, Field, Input } from "@shopkit/ui";
import { useState } from "react";
import { errorMessage, uploadFile } from "@/lib/api-client";

export function BrandUpload({ asset, url, current }: { asset: "logo" | "favicon"; url: string; current: string | null }) {
  const [preview, setPreview] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = `upload-${asset}`;
  return (
    <div className="flex items-center gap-4">
      <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
        {preview ? <img src={preview} alt={`Current ${asset}`} className="max-h-full max-w-full object-contain" /> : <span className="text-xs text-muted-foreground">None</span>}
      </div>
      <Field id={id} label={asset === "logo" ? "Logo" : "Favicon"} description="PNG, JPEG, WebP, GIF or ICO, up to 5 MB" error={error ?? undefined}>
        <Input
          id={id}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/x-icon"
          disabled={busy}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setBusy(true);
            setError(null);
            const { data, error: err } = await uploadFile(url, file);
            setBusy(false);
            if (data) setPreview(`${data.url}`);
            else setError(errorMessage(err));
          }}
        />
      </Field>
      {busy ? <Alert>Uploading…</Alert> : null}
    </div>
  );
}
