import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { frameAncestors } from "@/lib/embed-code";
import { embedInfo } from "@/lib/embed-info";

// Refresh the Supabase session cookie on every page request, and send signed-out visitors
// to /login. Authorization itself is enforced by row-level security, not by this file.
export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // The website embed is public: the loader script, the start route, and the embed page itself.
  // The page may only be shown by the sites its owner listed (frame-ancestors), and only while
  // the owner has the embed switched on.
  if (path === "/embed.js" || path === "/api/health" || path.startsWith("/api/embed/")) return NextResponse.next();
  // A client's shared dashboard link carries its own secret; no sign-in.
  if (path.startsWith("/share/")) return NextResponse.next();
  if (path.startsWith("/embed/")) {
    const info = await embedInfo(path.split("/")[2] ?? "");
    if (info === "error") return new NextResponse("Temporarily unavailable. Try again in a minute.", { status: 503 });
    if (!info || !info.enabled) return new NextResponse("This assistant isn't available.", { status: 404 });
    const res = NextResponse.next();
    res.headers.set("Content-Security-Policy", frameAncestors(info.origins));
    return res;
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          for (const { name, value } of list) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of list) response.cookies.set(name, value, options);
        },
      },
    },
  );

  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims);
  const onLogin = request.nextUrl.pathname === "/login";

  if (!signedIn && !onLogin) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  if (signedIn && onLogin) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
