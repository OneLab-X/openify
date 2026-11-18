"use client";
import { BarChart3, FileText, Home, LogOut, Package, Settings, ShoppingCart, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { api } from "@/lib/api-client";

const NAV = [
  { href: "/", label: "Home", icon: Home },
  { href: "/orders", label: "Orders", icon: ShoppingCart },
  { href: "/products", label: "Products", icon: Package },
  { href: "/customers", label: "Customers", icon: Users },
  { href: "/content", label: "Content", icon: FileText },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar({ storeName, logoUrl, staffName }: { storeName: string; logoUrl: string | null; staffName: string }) {
  const path = usePathname();
  return (
    <aside className="flex w-full flex-col border-b border-border bg-background md:min-h-screen md:w-60 md:border-b-0 md:border-r">
      <div className="flex items-center gap-2 px-4 py-4">
        {logoUrl ? <img src={logoUrl} alt="" className="h-8 w-8 rounded object-contain" /> : null}
        <span className="truncate font-semibold">{storeName}</span>
      </div>
      <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-2 md:flex-col">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? path === "/" : path.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm ${active ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted"}`}
            >
              <Icon className="h-4 w-4" aria-hidden /> {label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto hidden items-center justify-between px-4 py-4 text-sm md:flex">
        <span className="truncate text-muted-foreground">{staffName}</span>
        <button
          type="button"
          aria-label="Sign out"
          className="rounded p-1 hover:bg-muted"
          onClick={async () => {
            await api.POST("/api/admin/auth/logout");
            window.location.assign("/admin/login");
          }}
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </aside>
  );
}
