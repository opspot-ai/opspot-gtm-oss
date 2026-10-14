import { NextResponse, type NextRequest } from "next/server";
import { isLocalMode, isLoopbackHost } from "./lib/local-mode";
import { refreshSupabaseSession } from "./lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  if (isLocalMode()) {
    if (!isLoopbackHost(request.nextUrl.hostname)) {
      return NextResponse.json({ ok: false, error: { code: "local-origin-required", message: "Local mode accepts loopback origins only." } }, { status: 403 });
    }
    return NextResponse.next({ request });
  }
  return refreshSupabaseSession(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"]
};
