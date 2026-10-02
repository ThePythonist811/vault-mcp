import { loadClient, SCOPE_ANKI, type Target } from "@/lib/auth/oauth";
import { appBaseUrl, isAllowedRedirectUri } from "@/lib/config";

export interface AuthorizeParams {
  clientId: string;
  clientName: string | null;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scope: string | null;
  resource: string | null;
  target: Target;
}

/**
 * The client names the resource it wants (RFC 8707 `resource`, sent by Claude),
 * falling back to the requested scope. Anything else is the vault.
 */
export function targetFor(resource: string | null, scope: string | null): Target {
  if (resource) {
    try {
      const r = new URL(resource);
      if (r.origin === new URL(appBaseUrl()).origin && r.pathname.replace(/\/$/, "") === "/api/anki/mcp") return "anki";
    } catch {
      /* not a URL: ignore */
    }
    return "vault";
  }
  return (scope ?? "").split(/\s+/).includes(SCOPE_ANKI) ? "anki" : "vault";
}

/** Validates an authorization request; used by the GET redirect, the consent page and the POST. */
export async function validateAuthorizeParams(
  get: (k: string) => string | null,
): Promise<{ ok: true; params: AuthorizeParams } | { ok: false; error: string }> {
  const clientId = get("client_id");
  const redirectUri = get("redirect_uri");
  const codeChallenge = get("code_challenge");
  if (!clientId || !redirectUri || !codeChallenge || get("response_type") !== "code") {
    return { ok: false, error: "missing or invalid parameters" };
  }
  if ((get("code_challenge_method") ?? "S256") !== "S256") return { ok: false, error: "only S256 PKCE is supported" };
  const client = await loadClient(clientId);
  if (!client) return { ok: false, error: "unknown client" };
  if (!client.redirectUris.includes(redirectUri) || !isAllowedRedirectUri(redirectUri)) {
    return { ok: false, error: "redirect_uri not allowed" };
  }
  return {
    ok: true,
    params: {
      clientId,
      clientName: client.name,
      redirectUri,
      codeChallenge,
      state: get("state") ?? "",
      scope: get("scope"),
      resource: get("resource"),
      target: targetFor(get("resource"), get("scope")),
    },
  };
}
