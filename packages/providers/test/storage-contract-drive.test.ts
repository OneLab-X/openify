import { generateKeyPairSync, randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DRIVE_API, googleDriveStorage } from "../src/storage/google-drive.js";
import { verifyProxySignature } from "../src/storage/sign.js";
import { ctx, runtime } from "./helpers.js";
import { storageContract } from "./storage-contract.js";

/** In-memory fake of the parts of the Drive v3 API the adapter uses. */
const FOLDER = "folder_ABCDEFGHIJ";
interface FakeFile {
  id: string;
  name: string;
  parents: string[];
  mimeType: string;
  data: Buffer;
}
const files = new Map<string, FakeFile>();
const unquote = (v: string) => v.replace(/\\'/g, "'").replace(/\\\\/g, "\\");

function matches(q: string, f: FakeFile): boolean {
  const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q);
  const parent = /'((?:[^'\\]|\\.)*)' in parents/.exec(q);
  if (name && f.name !== unquote(name[1]!)) return false;
  if (parent && !f.parents.includes(unquote(parent[1]!))) return false;
  return true;
}

function parseMultipart(body: Buffer, contentType: string): { meta: Record<string, unknown>; data: Buffer; mimeType: string } {
  const boundary = /boundary=([^;]+)/.exec(contentType)![1]!;
  const raw = body.toString("latin1");
  const parts = raw.split(`--${boundary}`).slice(1, -1);
  const [metaPart, dataPart] = parts.map((p) => {
    const idx = p.indexOf("\r\n\r\n");
    return { head: p.slice(0, idx), body: p.slice(idx + 4, p.length - 2) };
  });
  return {
    meta: JSON.parse(Buffer.from(metaPart!.body, "latin1").toString("utf8")) as Record<string, unknown>,
    data: Buffer.from(dataPart!.body, "latin1"),
    mimeType: /content-type: ([^\r\n]+)/i.exec(dataPart!.head)![1]!,
  };
}

const authed = (request: Request) => request.headers.get("authorization") === "Bearer drive-token";
const denied = () => HttpResponse.json({ error: { message: "Request had invalid authentication credentials" } }, { status: 401 });

const server = setupServer(
  http.post("https://oauth2.googleapis.com/token", () => HttpResponse.json({ access_token: "drive-token", expires_in: 3600, token_type: "Bearer" })),
  http.get(`${DRIVE_API}/drive/v3/files`, ({ request }) => {
    if (!authed(request)) return denied();
    const url = new URL(request.url);
    const q = url.searchParams.get("q") ?? "";
    const all = [...files.values()].filter((f) => matches(q, f)).sort((a, b) => a.id.localeCompare(b.id));
    const size = Number(url.searchParams.get("pageSize") ?? 100);
    const start = Number(url.searchParams.get("pageToken") ?? 0);
    const page = all.slice(start, start + Math.min(size, 3)); // small pages exercise pagination
    const next = start + page.length < all.length ? String(start + page.length) : undefined;
    return HttpResponse.json({
      files: page.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: String(f.data.length) })),
      ...(next ? { nextPageToken: next } : {}),
    });
  }),
  http.get(`${DRIVE_API}/drive/v3/files/:id`, ({ request, params }) => {
    if (!authed(request)) return denied();
    const id = params.id as string;
    if (id === FOLDER) return HttpResponse.json({ id, mimeType: "application/vnd.google-apps.folder" });
    const f = files.get(id);
    if (!f) return HttpResponse.json({ error: { message: "File not found" } }, { status: 404 });
    return new HttpResponse(new Uint8Array(f.data), { headers: { "content-type": f.mimeType, "content-length": String(f.data.length) } });
  }),
  http.delete(`${DRIVE_API}/drive/v3/files/:id`, ({ request, params }) => {
    if (!authed(request)) return denied();
    return files.delete(params.id as string) ? new HttpResponse(null, { status: 204 }) : HttpResponse.json({}, { status: 404 });
  }),
  http.post(`${DRIVE_API}/upload/drive/v3/files`, async ({ request }) => {
    if (!authed(request)) return denied();
    const { meta, data, mimeType } = parseMultipart(Buffer.from(await request.arrayBuffer()), request.headers.get("content-type")!);
    const id = randomUUID();
    files.set(id, { id, name: meta.name as string, parents: meta.parents as string[], mimeType, data });
    return HttpResponse.json({ id });
  }),
  http.patch(`${DRIVE_API}/upload/drive/v3/files/:id`, async ({ request, params }) => {
    if (!authed(request)) return denied();
    const f = files.get(params.id as string);
    if (!f) return HttpResponse.json({}, { status: 404 });
    f.data = Buffer.from(await request.arrayBuffer());
    f.mimeType = request.headers.get("content-type") ?? f.mimeType;
    return HttpResponse.json({ id: f.id });
  }),
);

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const serviceAccountJson = JSON.stringify({
  client_email: "drive@shopkit-test.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
});

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterAll(() => server.close());

const make = () => googleDriveStorage.create(ctx({ folderId: FOLDER }, { serviceAccountJson }, "live"));

storageContract({ name: "google drive (in-process fake)", make, fetchSignedUrls: false, directUpload: "absent", expectPublicUrl: false });

describe("google drive specifics", () => {
  it("signs /media/s proxy URLs", async () => {
    const url = new URL(await make().getSignedUrl("products/a b.png", { expiresIn: 60 }));
    expect(url.pathname).toMatch(/\/media\/s\/[^/]+\/google-drive\/products\/a%20b\.png$/);
    const store = "0190a1b2-0000-7000-8000-000000000001";
    expect(verifyProxySignature(runtime.signingSecret, store, "google-drive", "products/a b.png", Number(url.searchParams.get("exp")), url.searchParams.get("sig")!)).toBe(true);
  });

  it("explains a missing folder share", async () => {
    const p = googleDriveStorage.create(ctx({ folderId: "unshared_folder_123" }, { serviceAccountJson }, "live"));
    expect(await p.testCredentials()).toMatchObject({ ok: false, error: expect.stringMatching(/Folder not found: share it with drive@/) });
  });

  it("escapes quotes in names", async () => {
    const p = make();
    await p.put("it's/quoted.txt", Buffer.from("q"), { contentType: "text/plain" });
    expect((await p.get("it's/quoted.txt"))?.contentLength).toBe(1);
    await p.delete("it's/quoted.txt");
  });
});
