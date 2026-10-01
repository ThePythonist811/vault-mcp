import { NextResponse } from "next/server";
import { revokeToken } from "@/lib/auth/oauth";

export const dynamic = "force-dynamic";

// RFC 7009: always answer 200, whether or not the token existed.
export async function POST(req: Request) {
  const ct = req.headers.get("content-type") ?? "";
  const body: Record<string, string> = ct.includes("application/json")
    ? ((await req.json().catch(() => ({}))) ?? {})
    : Object.fromEntries(new URLSearchParams(await req.text()).entries());
  if (body.token) await revokeToken(body.token);
  return NextResponse.json({}, { status: 200 });
}
