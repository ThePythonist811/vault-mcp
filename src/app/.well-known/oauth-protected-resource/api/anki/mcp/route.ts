import { NextResponse } from "next/server";
import { appBaseUrl } from "@/lib/config";
import { ANKI_SCOPES } from "@/lib/auth/oauth";

export const dynamic = "force-dynamic";

// RFC 9728 metadata for the Anki resource (path-suffixed well-known URL).
export async function GET() {
  const base = appBaseUrl();
  return NextResponse.json({
    resource: `${base}/api/anki/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    scopes_supported: ANKI_SCOPES,
  });
}
