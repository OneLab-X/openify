import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic routing only (SPEC §5): while setup is required every admin route goes to /setup;
 * signed-out visitors go to /login. Real authorisation happens in the API on every request.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = request.cookies.has("sk_session");
  const onSetup = pathname === "/setup" || pathname.startsWith("/setup/");
  const onLogin = pathname === "/login";
  // Invitation links are opened by people who have no account yet.
  if (pathname.startsWith("/invite/")) return NextResponse.next();

  if (hasSession && !onSetup) return NextResponse.next();

  let required: boolean;
  try {
    const res = await fetch(`${process.env.API_INTERNAL_URL ?? "http://localhost:4000"}/api/setup/status`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    required = ((await res.json()) as { required: boolean }).required;
  } catch {
    return NextResponse.next(); // API down: let the page render its own error state
  }

  const to = (path: string) => {
    const url = request.nextUrl.clone();
    url.pathname = path;
    url.search = "";
    return NextResponse.redirect(url);
  };
  if (required && !onSetup) return to("/setup");
  if (!required && onSetup) return to(hasSession ? "/" : "/login");
  if (!required && !hasSession && !onLogin) return to("/login");
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/|favicon.ico).*)"],
};
