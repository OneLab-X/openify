/** Permission strings (SPEC §10). Owners hold "*". */
export const PERMISSIONS = [
  "home:read",
  "products:read",
  "products:write",
  "orders:read",
  "orders:write",
  "orders:refund",
  "customers:read",
  "customers:write",
  "content:write",
  "analytics:read",
  "settings:read",
  "settings:general",
  "settings:storage",
  "settings:payments",
  "settings:email",
  "settings:analytics",
  "settings:shipping",
  "settings:staff",
  "audit:read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export type SystemRole = "owner" | "admin" | "staff";

export const SYSTEM_ROLES: Record<SystemRole, { name: string; permissions: readonly (Permission | "*")[] }> = {
  owner: { name: "Owner", permissions: ["*"] },
  admin: {
    name: "Admin",
    permissions: PERMISSIONS.filter((p) => p !== "settings:staff" && p !== "settings:payments"),
  },
  staff: {
    name: "Staff",
    permissions: [
      "home:read",
      "products:read",
      "products:write",
      "orders:read",
      "orders:write",
      "customers:read",
      "customers:write",
      "content:write",
      "analytics:read",
    ],
  },
};

export function hasPermission(granted: readonly string[], required: Permission): boolean {
  return granted.includes("*") || granted.includes(required);
}
