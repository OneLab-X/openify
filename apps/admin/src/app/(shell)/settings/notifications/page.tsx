import type { Metadata } from "next";
import { NotificationsSettings } from "@/components/commerce/NotificationsSettings";
import { serverApi } from "@/lib/api-server";

export const metadata: Metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  const api = await serverApi();
  const [settings, templates] = await Promise.all([api.GET("/api/admin/settings"), api.GET("/api/admin/notifications/templates")]);
  if (!settings.data?.notifications || !templates.data) return <p>You do not have access to settings.</p>;
  return <NotificationsSettings config={settings.data.notifications} templates={templates.data.items} />;
}
