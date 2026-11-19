/** Permission strings (SPEC §10). Owners hold "*". */
export const PERMISSIONS = [
  "home:read",
  "products:read",
  "products:write",
  "orders:read",
  "orders:write",
  "orders:refund",
  "orders:fulfill",
  "orders:returns",
  "discounts:read",
  "discounts:write",
  "gift_cards:read",
  "gift_cards:write",
  "reports:read",
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
  "settings:tax",
  "settings:security",
  "settings:staff",
  "audit:read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export type SystemRole = "owner" | "admin" | "staff";

export const SYSTEM_ROLES: Record<SystemRole, { name: string; permissions: readonly (Permission | "*")[] }> = {
  owner: { name: "Owner", permissions: ["*"] },
  admin: {
    name: "Admin",
    permissions: PERMISSIONS.filter((p) => p !== "settings:staff" && p !== "settings:payments" && p !== "settings:security"),
  },
  staff: {
    name: "Staff",
    permissions: [
      "home:read",
      "products:read",
      "products:write",
      "orders:read",
      "orders:write",
      "orders:fulfill",
      "orders:returns",
      "discounts:read",
      "gift_cards:read",
      "reports:read",
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

/** Grouped for the role editor. */
export const PERMISSION_GROUPS: { label: string; permissions: Permission[] }[] = [
  { label: "Home & reports", permissions: ["home:read", "analytics:read", "reports:read"] },
  { label: "Products", permissions: ["products:read", "products:write"] },
  { label: "Orders", permissions: ["orders:read", "orders:write", "orders:fulfill", "orders:returns", "orders:refund"] },
  { label: "Customers", permissions: ["customers:read", "customers:write"] },
  { label: "Discounts & gift cards", permissions: ["discounts:read", "discounts:write", "gift_cards:read", "gift_cards:write"] },
  { label: "Content", permissions: ["content:write"] },
  {
    label: "Settings",
    permissions: ["settings:read", "settings:general", "settings:storage", "settings:payments", "settings:email", "settings:analytics", "settings:shipping", "settings:tax", "settings:staff", "settings:security", "audit:read"],
  },
];
