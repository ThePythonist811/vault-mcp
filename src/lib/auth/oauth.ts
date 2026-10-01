import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { oauthAuthCodes, oauthClients, oauthTokens, type OAuthToken } from "@/lib/db/schema";
import { accessTokenTtl, appSecret, refreshTokenTtl } from "@/lib/config";

const AUTH_CODE_TTL_SECONDS = 5 * 60;
const MAX_CLIENTS = 100;

export const SCOPE_READ = "vault:read";
export const SCOPE_PROPOSE = "vault:propose";
export const SUPPORTED_SCOPES = [SCOPE_READ, SCOPE_PROPOSE];

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (method !== "S256") return false;
  const digest = createHash("sha256").update(verifier).digest("base64url");
  return safeEqual(digest, challenge);
}

/** Keeps only scopes we know; always includes read. */
export function normalizeScope(requested: string | null | undefined, allowPropose: boolean): string {
  const asked = new Set((requested ?? "").split(/\s+/).filter(Boolean));
  const out = [SCOPE_READ];
  if (allowPropose && (asked.size === 0 || asked.has(SCOPE_PROPOSE))) out.push(SCOPE_PROPOSE);
  return out.join(" ");
}

export function hasScope(scope: string, wanted: string): boolean {
  return scope.split(/\s+/).includes(wanted);
}

// --- Consent CSRF token -------------------------------------------------------
// The consent form carries an HMAC over (user, client, redirect, challenge, expiry).
// A forged cross-site POST cannot produce it, and it cannot be replayed for
// another client or after 10 minutes.

function consentPayload(p: {
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  exp: number;
}): string {
  return [p.userId, p.clientId, p.redirectUri, p.codeChallenge, p.exp].join("\n");
}

export function signConsent(p: {
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
}): string {
  const exp = Math.floor(Date.now() / 1000) + 600;
  const mac = createHmac("sha256", appSecret()).update(consentPayload({ ...p, exp })).digest("base64url");
  return `${exp}.${mac}`;
}

export function verifyConsent(
  token: string,
  p: { userId: string; clientId: string; redirectUri: string; codeChallenge: string },
): boolean {
  const [expStr, mac] = token.split(".");
  const exp = Number(expStr);
  if (!exp || !mac || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = createHmac("sha256", appSecret())
    .update(consentPayload({ ...p, exp }))
    .digest("base64url");
  return safeEqual(mac, expected);
}

// --- Clients ------------------------------------------------------------------

export async function registerClient(input: {
  redirectUris: string[];
  name?: string;
  tokenEndpointAuthMethod?: string;
}): Promise<{ client_id: string; client_secret?: string }> {
  let [{ n }] = await db.select({ n: count() }).from(oauthClients);
  if (n >= MAX_CLIENTS) {
    // Registration is anonymous, so someone could fill the table. Drop clients that
    // never obtained a token within a day; real connections are never affected.
    await db.execute(sql`
      DELETE FROM oauth_clients c
      WHERE c.created_at < now() - interval '1 day'
        AND NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.client_id = c.id)`);
    [{ n }] = await db.select({ n: count() }).from(oauthClients);
    if (n >= MAX_CLIENTS) throw new Error("client registration limit reached");
  }
  const clientId = `vmcp_${randomToken(12)}`;
  const authMethod = input.tokenEndpointAuthMethod ?? "none";
  let clientSecret: string | undefined;
  if (authMethod !== "none") clientSecret = randomToken(32);
  await db.insert(oauthClients).values({
    id: clientId,
    clientSecretHash: clientSecret ? sha256(clientSecret) : null,
    redirectUris: input.redirectUris,
    name: input.name?.slice(0, 100) ?? null,
    tokenEndpointAuthMethod: authMethod,
  });
  return { client_id: clientId, client_secret: clientSecret };
}

export async function loadClient(clientId: string) {
  const [row] = await db.select().from(oauthClients).where(eq(oauthClients.id, clientId)).limit(1);
  return row ?? null;
}

// --- Authorization codes --------------------------------------------------------

export async function createAuthCode(input: {
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
}): Promise<string> {
  const code = randomToken(32);
  await db.insert(oauthAuthCodes).values({
    codeHash: sha256(code),
    clientId: input.clientId,
    userId: input.userId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: "S256",
    scope: input.scope,
    expiresAt: new Date(Date.now() + AUTH_CODE_TTL_SECONDS * 1000),
  });
  return code;
}

/** Single use: the UPDATE ... WHERE consumed_at IS NULL makes a race lose. */
export async function consumeAuthCode(code: string) {
  const [row] = await db
    .update(oauthAuthCodes)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(oauthAuthCodes.codeHash, sha256(code)),
        isNull(oauthAuthCodes.consumedAt),
        gt(oauthAuthCodes.expiresAt, new Date()),
      ),
    )
    .returning();
  return row ?? null;
}

// --- Tokens ---------------------------------------------------------------------

export async function issueTokenPair(input: { clientId: string; userId: string; scope: string }) {
  const access = randomToken(32);
  const refresh = randomToken(32);
  await db.insert(oauthTokens).values({
    accessTokenHash: sha256(access),
    refreshTokenHash: sha256(refresh),
    clientId: input.clientId,
    userId: input.userId,
    scope: input.scope,
    accessExpiresAt: new Date(Date.now() + accessTokenTtl() * 1000),
    refreshExpiresAt: new Date(Date.now() + refreshTokenTtl() * 1000),
  });
  return {
    access_token: access,
    refresh_token: refresh,
    expires_in: accessTokenTtl(),
    token_type: "Bearer" as const,
    scope: input.scope,
  };
}

export async function resolveAccessToken(access: string): Promise<OAuthToken | null> {
  const [row] = await db
    .select()
    .from(oauthTokens)
    .where(
      and(
        eq(oauthTokens.accessTokenHash, sha256(access)),
        gt(oauthTokens.accessExpiresAt, new Date()),
        isNull(oauthTokens.revokedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Rotates a refresh token: the old pair is revoked atomically before a new one is issued. */
export async function rotateRefresh(refresh: string): Promise<OAuthToken | null> {
  const [row] = await db
    .update(oauthTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(oauthTokens.refreshTokenHash, sha256(refresh)),
        isNull(oauthTokens.revokedAt),
        gt(oauthTokens.refreshExpiresAt, new Date()),
      ),
    )
    .returning();
  return row ?? null;
}

export async function revokeToken(token: string): Promise<void> {
  const h = sha256(token);
  await db.update(oauthTokens).set({ revokedAt: new Date() }).where(eq(oauthTokens.accessTokenHash, h));
  await db.update(oauthTokens).set({ revokedAt: new Date() }).where(eq(oauthTokens.refreshTokenHash, h));
}

export async function revokeAllForUser(userId: string): Promise<void> {
  await db
    .update(oauthTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(oauthTokens.userId, userId), isNull(oauthTokens.revokedAt)));
}
