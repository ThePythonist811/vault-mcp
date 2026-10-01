import Link from "next/link";
import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";
import type { Viewer } from "@/lib/auth/clerk";

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="container">
      <nav className="topnav">
        <Link href="/" className="topnav-brand">
          <span className="topnav-logo">V</span>
          <span>Vault MCP</span>
        </Link>
        <div className="topnav-links">
          <SignedIn>
            <Link href="/proposals" className="btn btn-ghost btn-sm">Vorschläge</Link>
            <Link href="/activity" className="btn btn-ghost btn-sm">Aktivität</Link>
            <Link href="/connect" className="btn btn-ghost btn-sm">Verbinden</Link>
            <UserButton />
          </SignedIn>
          <SignedOut>
            <SignInButton mode="modal">
              <button className="btn btn-primary btn-sm">Anmelden</button>
            </SignInButton>
          </SignedOut>
        </div>
      </nav>
      {children}
    </div>
  );
}

/** Renders children only for allowlisted users. */
export function Guard({ viewer, children }: { viewer: Viewer; children: React.ReactNode }) {
  if (viewer.state === "ok") return <>{children}</>;
  if (viewer.state === "signed-out") return <div className="alert alert-info">Bitte anmelden.</div>;
  return (
    <div className="alert alert-error">
      Dieses Konto hat keinen Zugriff auf den Vault. (Clerk-ID: <code>{viewer.clerkUserId}</code>)
    </div>
  );
}
