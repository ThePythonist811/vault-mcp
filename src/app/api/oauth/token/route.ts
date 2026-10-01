import { NextResponse } from "next/server";
import {
  consumeAuthCode,
  issueTokenPair,
  loadClient,
  rotateRefresh,
  safeEqual,
  sha256,
  verifyPkce,
} from "@/lib/auth/oauth";
import { clerkIdForUser } from "@/lib/auth/clerk";
import { isAllowedClerkUser } from "@/lib/config";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

function err(error: string, status = 400, description?: string) {
  return NextResponse.json({ error, error_description: description }, { status, headers: noStore });
}

async function readForm(req: Request): Promise<Record<string, string>> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return ((await req.json().catch(() => ({}))) ?? {}) as Record<string, string>;
  return Object.fromEntries(new URLSearchParams(await req.text()).entries());
}

function parseBasicAuth(req: Request): { clientId: string; clientSecret: string } | null {
  const h = req.headers.get("authorization");
  if (!h?.toLowerCase().startsWith("basic ")) return null;
  const decoded = Buffer.from(h.slice(6), "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  if (idx < 0) return null;
  return {
    clientId: decodeURIComponent(decoded.slice(0, idx)),
    clientSecret: decodeURIComponent(decoded.slice(idx + 1)),
  };
}

async function authenticateClient(req: Request, body: Record<string, string>) {
  const basic = parseBasicAuth(req);
  const clientId = basic?.clientId ?? body.client_id;
  if (!clientId) return null;
  const client = await loadClient(clientId);
  if (!client) return null;
  if (client.tokenEndpointAuthMethod === "none") return client;
  const provided = basic?.clientSecret ?? body.client_secret;
  if (!provided || !client.clientSecretHash) return null;
  return safeEqual(sha256(provided), client.clientSecretHash) ? client : null;
}

export async function POST(req: Request) {
  const body = await readForm(req);
  const client = await authenticateClient(req, body);
  if (!client) return err("invalid_client", 401);

  if (body.grant_type === "authorization_code") {
    if (!body.code || !body.code_verifier || !body.redirect_uri) return err("invalid_request");
    const code = await consumeAuthCode(body.code);
    if (!code || code.clientId !== client.id || code.redirectUri !== body.redirect_uri) return err("invalid_grant");
    if (!verifyPkce(body.code_verifier, code.codeChallenge, code.codeChallengeMethod)) {
      return err("invalid_grant", 400, "bad pkce");
    }
    return NextResponse.json(
      await issueTokenPair({ clientId: client.id, userId: code.userId, scope: code.scope }),
      { headers: noStore },
    );
  }

  if (body.grant_type === "refresh_token") {
    if (!body.refresh_token) return err("invalid_request");
    const old = await rotateRefresh(body.refresh_token);
    if (!old || old.clientId !== client.id) return err("invalid_grant");
    if (!isAllowedClerkUser(await clerkIdForUser(old.userId))) return err("invalid_grant");
    return NextResponse.json(
      await issueTokenPair({ clientId: client.id, userId: old.userId, scope: old.scope }),
      { headers: noStore },
    );
  }

  return err("unsupported_grant_type");
}
