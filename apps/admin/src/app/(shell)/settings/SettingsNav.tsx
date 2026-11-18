"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  ["general", "General"],
  ["branding", "Branding"],
  ["storage", "Storage"],
  ["payments", "Payments"],
  ["email", "Email"],
  ["analytics", "Analytics"],
  ["shipping", "Shipping & taxes"],
  ["staff", "Staff & security"],
  ["audit-log", "Audit log"],
] as const;

export function SettingsNav() {
  const path = usePathname();
  return (
    <nav aria-label="Settings" className="flex gap-1 overflow-x-auto lg:flex-col">
      {ITEMS.map(([slug, label]) => {
        const href = `/settings/${slug}`;
        const active = path === href;
        return (
          <Link key={slug} href={href} aria-current={active ? "page" : undefined}
            className={`whitespace-nowrap rounded-md px-3 py-2 text-sm ${active ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:bg-background"}`}>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
