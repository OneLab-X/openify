import { notFound, permanentRedirect } from "next/navigation";
import { findRedirect } from "./index";

/** A resource is missing: follow its redirect (renamed handle) or show the 404 page. */
export async function notFoundOrRedirect(path: string): Promise<never> {
  const to = await findRedirect(path);
  if (to) permanentRedirect(to);
  notFound();
}
