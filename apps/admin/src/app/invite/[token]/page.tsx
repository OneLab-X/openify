import type { Metadata } from "next";
import { serverApi } from "@/lib/api-server";
import { AcceptInvite } from "./AcceptInvite";

export const metadata: Metadata = { title: "Join the team" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { data } = await (await serverApi()).GET("/api/admin/auth/invites/{token}", { params: { path: { token } } });
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      {data ? (
        <AcceptInvite token={token} invite={data} />
      ) : (
        <div className="grid max-w-sm gap-2 text-center">
          <h1 className="text-xl font-semibold">This invitation can’t be used</h1>
          <p className="text-sm text-muted-foreground">It may have expired, been revoked or already accepted. Ask the store owner for a new one.</p>
        </div>
      )}
    </main>
  );
}
