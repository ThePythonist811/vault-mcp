// Central place for everything security-relevant that comes from the environment.
// Values are read lazily so `next build` works without real secrets.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function appBaseUrl(): string {
  return required("NEXT_PUBLIC_APP_URL").replace(/\/$/, "");
}

export function appSecret(): string {
  const s = required("APP_SECRET");
  if (s.length < 32) throw new Error("APP_SECRET must be at least 32 characters");
  return s;
}

/** Clerk user IDs that may use this server at all. Empty list = nobody. */
export function allowedClerkUserIds(): string[] {
  return list("ALLOWED_CLERK_USER_IDS");
}

export function isAllowedClerkUser(clerkUserId: string | null | undefined): boolean {
  return !!clerkUserId && allowedClerkUserIds().includes(clerkUserId);
}

const DEFAULT_REDIRECTS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
];

/**
 * OAuth redirect URIs a client may register. Exact matches from
 * ALLOWED_REDIRECT_URIS (default: Claude's hosted callbacks), plus loopback
 * http URIs on any port for local clients such as Claude Code.
 */
export function isAllowedRedirectUri(uri: string): boolean {
  const exact = list("ALLOWED_REDIRECT_URIS");
  if ((exact.length ? exact : DEFAULT_REDIRECTS).includes(uri)) return true;
  if (process.env.ALLOW_LOOPBACK_REDIRECTS === "false") return false;
  try {
    const u = new URL(uri);
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

export function vaultRoot(): string {
  return required("VAULT_ROOT");
}

/** Top-level folders (relative to the vault) Claude can neither see nor touch. */
export function hiddenFolders(): string[] {
  return list("VAULT_HIDDEN_FOLDERS").map((f) => f.replace(/^\/+|\/+$/g, ""));
}

/** Folders proposals may target. Empty = every visible folder. */
export function writableFolders(): string[] {
  return list("VAULT_WRITABLE_FOLDERS").map((f) => f.replace(/^\/+|\/+$/g, ""));
}

/**
 * Folders that are readable but never writable, e.g. folders whose notes a plugin
 * executes as code (Excalidraw scripts, Templater templates).
 */
export function readOnlyFolders(): string[] {
  return list("VAULT_READONLY_FOLDERS").map((f) => f.replace(/^\/+|\/+$/g, ""));
}

export function proposalTtlSeconds(): number {
  return Number(process.env.PROPOSAL_TTL_SECONDS ?? 7 * 24 * 3600);
}

export function accessTokenTtl(): number {
  return Number(process.env.OAUTH_ACCESS_TOKEN_TTL ?? 3600);
}

export function refreshTokenTtl(): number {
  return Number(process.env.OAUTH_REFRESH_TOKEN_TTL ?? 30 * 24 * 3600);
}

/** Optional ntfy topic URL for "new proposal" pushes (no note content is sent). */
export function ntfyUrl(): string | null {
  return process.env.NTFY_URL || null;
}
