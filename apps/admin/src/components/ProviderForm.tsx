"use client";
import { Checkbox, Field, Input, Select, Textarea } from "@shopkit/ui";

/** JSON Schema (as produced by zod's toJSONSchema) for one provider's config or secrets. */
interface JsonSchemaProp {
  type?: string | string[];
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  widget?: string;
}
export interface ObjectSchema {
  properties?: Record<string, JsonSchemaProp>;
  required?: string[];
}

export type Values = Record<string, unknown>;

function humanize(key: string) {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

/** Primitive → display string; objects (never expected in provider schemas) render empty. */
function str(v: unknown): string {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : "";
}

function typeOf(p: JsonSchemaProp): string {
  return Array.isArray(p.type) ? (p.type.find((t) => t !== "null") ?? "string") : (p.type ?? "string");
}

/**
 * Renders a settings form from a provider's zod-derived JSON Schema (SPEC §7). Secret fields are
 * write-only: they are never prefilled, and an empty field keeps the saved value.
 */
export function SchemaFields({
  idPrefix,
  schema,
  values,
  onChange,
  secret = false,
  savedSecretFields = [],
  last4,
  errors = {},
  errorPrefix,
}: {
  idPrefix: string;
  schema: ObjectSchema | null;
  values: Values;
  onChange: (next: Values) => void;
  secret?: boolean;
  savedSecretFields?: string[];
  last4?: string | null;
  errors?: Record<string, string>;
  errorPrefix: "config" | "secrets";
}) {
  const props = Object.entries(schema?.properties ?? {});
  if (props.length === 0) return null;
  const required = new Set(schema?.required ?? []);

  return (
    <div className="grid gap-4">
      {props.map(([key, p]) => {
        const id = `${idPrefix}-${key}`;
        const label = p.title ?? humanize(key);
        const error = errors[`${errorPrefix}.${key}`];
        const t = typeOf(p);
        const value = values[key];
        const set = (v: unknown) => onChange({ ...values, [key]: v });
        const saved = secret && savedSecretFields.includes(key);
        const common = {
          id,
          name: key,
          "aria-invalid": error ? true : undefined,
          "aria-describedby": error ? `${id}-error` : p.description ? `${id}-desc` : undefined,
        };

        if (t === "boolean") {
          return (
            <div key={key} className="flex items-start gap-2">
              <Checkbox {...common} checked={Boolean(value ?? p.default ?? false)} onChange={(e) => set(e.target.checked)} />
              <div className="grid gap-1">
                <label htmlFor={id} className="text-sm font-medium leading-none">{label}</label>
                {p.description ? <p id={`${id}-desc`} className="text-xs text-muted-foreground">{p.description}</p> : null}
              </div>
            </div>
          );
        }

        let control;
        if (p.enum) {
          control = (
            <Select {...common} value={typeof value === "string" ? value : typeof p.default === "string" ? p.default : ""} onChange={(e) => set(e.target.value)}>
              {p.enum.map((opt) => (
                <option key={String(opt)} value={String(opt)}>{String(opt)}</option>
              ))}
            </Select>
          );
        } else if (t === "integer" || t === "number") {
          control = (
            <Input
              {...common}
              type="number"
              inputMode="numeric"
              placeholder={str(p.default) || undefined}
              value={str(value)}
              onChange={(e) => set(e.target.value === "" ? undefined : Number(e.target.value))}
            />
          );
        } else if (p.widget === "textarea") {
          control = (
            <Textarea
              {...common}
              placeholder={saved ? "Saved — leave blank to keep" : undefined}
              spellCheck={false}
              value={str(value)}
              onChange={(e) => set(e.target.value || undefined)}
            />
          );
        } else {
          control = (
            <Input
              {...common}
              type={secret ? "password" : p.format === "email" ? "email" : p.format === "uri" ? "url" : "text"}
              autoComplete={secret ? "new-password" : "off"}
              placeholder={
                saved ? `Saved${last4 ? ` ••••${last4}` : ""} — leave blank to keep`   : str(p.default) || undefined
              }
              value={str(value)}
              onChange={(e) => set(e.target.value === "" ? undefined : e.target.value)}
            />
          );
        }
        return (
          <Field key={key} id={id} label={label} description={p.description} error={error} required={required.has(key) && !saved && p.default === undefined}>
            {control}
          </Field>
        );
      })}
    </div>
  );
}
