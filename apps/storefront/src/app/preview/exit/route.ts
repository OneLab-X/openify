import { cookies, draftMode } from "next/headers";
import { PREVIEW_COOKIE } from "@/lib/theme";

export async function POST() {
  (await draftMode()).disable();
  (await cookies()).delete(PREVIEW_COOKIE);
  return new Response(null, { status: 303, headers: { location: "/" } });
}
