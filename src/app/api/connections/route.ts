import { NextResponse } from "next/server";
import { getViewer, isSameOrigin } from "@/lib/auth/clerk";
import { revokeAllForUser } from "@/lib/auth/oauth";
import { appBaseUrl } from "@/lib/config";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/** Emergency stop: revokes every access and refresh token. Clients must re-authorize. */
export async function POST(req: Request) {
  if (!isSameOrigin(req, appBaseUrl())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const viewer = await getViewer();
  if (viewer.state !== "ok") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  await revokeAllForUser(viewer.userId);
  await audit({ actor: `user:${viewer.clerkUserId}`, action: "oauth.revoke_all", ok: true });
  return NextResponse.redirect(`${appBaseUrl()}/activity`, 303);
}
