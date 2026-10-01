import Link from "next/link";
import { Shell } from "@/components/Shell";

export default function HomePage() {
  return (
    <Shell>
      <section className="hero">
        <h1>Obsidian-Vault für Claude.</h1>
        <p>
          Privater MCP-Server. Lesen nach Freigabe per OAuth, Schreiben nur über Vorschläge, die hier
          einzeln bestätigt werden.
        </p>
        <div className="hero-actions">
          <Link href="/proposals" className="btn btn-primary">Offene Vorschläge</Link>
          <Link href="/connect" className="btn">Mit Claude verbinden</Link>
        </div>
      </section>
    </Shell>
  );
}
