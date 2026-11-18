import { redirect } from "next/navigation";
import { serverApi } from "./api-server";

/** Loads the signed-in staff member or redirects (Data Access Layer pattern from the Next auth guide). */
export async function requireMe() {
  const api = await serverApi();
  const { data, response } = await api.GET("/api/admin/auth/me");
  if (data) return data;
  if (response.status === 409) redirect("/setup");
  redirect("/login");
}
export type Me = Awaited<ReturnType<typeof requireMe>>;

export function can(me: Me, permission: string) {
  return me.permissions.includes("*") || me.permissions.includes(permission as never);
}
