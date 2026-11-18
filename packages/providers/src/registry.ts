import { z } from "zod";
import type { ComingSoonProvider, ProviderDefinition, ProviderKind, ProviderMode } from "./types.js";

export interface ProviderDescriptor {
  id: string;
  kind: ProviderKind;
  displayName: string;
  description?: string;
  docsUrl?: string;
  status: "available" | "coming_soon";
  modes: readonly ProviderMode[];
  configSchema: Record<string, unknown> | null;
  secretsSchema: Record<string, unknown> | null;
  webhookEvents: readonly string[];
}

export class UnknownProviderError extends Error {
  override name = "UnknownProviderError";
  constructor(kind: string, id: string) {
    super(`Unknown ${kind} provider "${id}"`);
  }
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
}

/** Registry of provider adapters keyed by kind + id. Community packages call `register`. */
export class ProviderRegistry {
  readonly #defs = new Map<string, ProviderDefinition>();
  readonly #soon = new Map<string, ComingSoonProvider>();

  register(def: ProviderDefinition): this {
    const key = `${def.kind}:${def.id}`;
    if (this.#defs.has(key)) throw new Error(`Provider ${key} is already registered`);
    if (def.modes.length === 0) throw new Error(`Provider ${key} must support at least one mode`);
    this.#defs.set(key, def);
    this.#soon.delete(key);
    return this;
  }

  registerComingSoon(entry: ComingSoonProvider): this {
    const key = `${entry.kind}:${entry.id}`;
    if (!this.#defs.has(key)) this.#soon.set(key, entry);
    return this;
  }

  get<K extends ProviderKind>(kind: K, id: string): ProviderDefinition<K> | undefined {
    return this.#defs.get(`${kind}:${id}`) as ProviderDefinition<K> | undefined;
  }

  require<K extends ProviderKind>(kind: K, id: string): ProviderDefinition<K> {
    const def = this.get(kind, id);
    if (!def) throw new UnknownProviderError(kind, id);
    return def;
  }

  definitions(kind?: ProviderKind): ProviderDefinition[] {
    return [...this.#defs.values()].filter((d) => !kind || d.kind === kind);
  }

  describe(kind?: ProviderKind): ProviderDescriptor[] {
    const available: ProviderDescriptor[] = this.definitions(kind).map((d) => ({
      id: d.id,
      kind: d.kind,
      displayName: d.displayName,
      ...(d.description ? { description: d.description } : {}),
      ...(d.docsUrl ? { docsUrl: d.docsUrl } : {}),
      status: "available",
      modes: d.modes,
      configSchema: jsonSchema(d.configSchema),
      secretsSchema: jsonSchema(d.secretsSchema),
      webhookEvents: d.webhookEvents ?? [],
    }));
    const soon: ProviderDescriptor[] = [...this.#soon.values()]
      .filter((s) => !kind || s.kind === kind)
      .map((s) => ({
        ...s,
        status: "coming_soon",
        modes: [],
        configSchema: null,
        secretsSchema: null,
        webhookEvents: [],
      }));
    return [...available, ...soon];
  }
}
