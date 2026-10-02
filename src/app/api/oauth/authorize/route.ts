import { NextResponse } from "next/server";
import { validateAuthorizeParams } from "@/lib/auth/authorize";
import { getViewer, isSameOrigin } from "@/lib/auth/clerk";
import { createAuthCode, SCOPE_ANKI, scopeForLevel, verifyConsent } from "@/lib/auth/oauth";
import { appBaseUrl } from "@/lib/config";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

// GET never issues a code: it only validates and sends the user to the consent page.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const v = await validateAuthorizeParams((k) => url.searchParams.get(k));
  if (!v.ok) return NextResponse.json({ error: "invalid_request", error_description: v.error }, { status: 400 });
  return NextResponse.redirect(`${appBaseUrl()}/consent?${url.searchParams.toString()}`, 303);
}

// POST comes from the consent form only.
export async function POST(req: Request) {
  if (!isSameOrigin(req, appBaseUrl())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const viewer = await getViewer();
  if (viewer.state !== "ok") return NextResponse.json({ error: "access_denied" }, { status: 403 });

  const form = await req.formData();
  const get = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : null;
  };
  const v = await validateAuthorizeParams(get);
  if (!v.ok) return NextResponse.json({ error: "invalid_request", error_description: v.error }, { status: 400 });
  const p = v.params;

  const consentOk = verifyConsent(get("consent_token") ?? "", {
    userId: viewer.userId,
    clientId: p.clientId,
    redirectUri: p.redirectUri,
    codeChallenge: p.codeChallenge,
    target: p.target,
  });
  if (!consentOk) return NextResponse.json({ error: "consent expired, please retry" }, { status: 400 });

  const redirect = new URL(p.redirectUri);
  if (p.state) redirect.searchParams.set("state", p.state);

  if (get("decision") !== "allow") {
    await audit({ actor: `user:${viewer.clerkUserId}`, action: "oauth.deny", detail: p.clientName ?? p.clientId, ok: true });
    redirect.searchParams.set("error", "access_denied");
    return NextResponse.redirect(redirect.toString(), 303);
  }

  const access = get("access");
  const scope =
    p.target === "anki"
      ? SCOPE_ANKI
      : scopeForLevel(access === "write" || access === "propose" ? access : "read");
  const code = await createAuthCode({
    clientId: p.clientId,
    userId: viewer.userId,
    redirectUri: p.redirectUri,
    codeChallenge: p.codeChallenge,
    scope,
  });
  await audit({
    actor: `user:${viewer.clerkUserId}`,
    action: "oauth.grant",
    detail: `${p.target}: ${p.clientName ?? p.clientId} (${p.clientId}) scope="${scope}" redirect=${new URL(p.redirectUri).host}`,
    ok: true,
  });
  redirect.searchParams.set("code", code);
  return NextResponse.redirect(redirect.toString(), 303);
}
