import { NextResponse, type NextRequest } from "next/server";
import { authorizeDemoRequest } from "./lib/demo-access";

const publicPath = "/api/health";

export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === publicPath) return NextResponse.next();

  const result = authorizeDemoRequest(request.headers.get("authorization"));
  if (result === "authorized") return NextResponse.next();

  if (result === "unconfigured") {
    return NextResponse.json(
      { error: "Demo access is not configured" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    { error: "Authentication required" },
    {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Basic realm="VK Tech demo", charset="UTF-8"',
      },
    },
  );
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
