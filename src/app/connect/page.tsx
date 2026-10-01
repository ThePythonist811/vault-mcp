import { Shell, Guard } from "@/components/Shell";
import { CopyBlock } from "@/components/CopyButton";
import { getViewer } from "@/lib/auth/clerk";
import { appBaseUrl } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function ConnectPage() {
  const viewer = await getViewer();
  const mcpUrl = `${appBaseUrl()}/api/mcp`;
  return (
    <Shell>
      <Guard viewer={viewer}>
        <div className="stack-lg stack">
          <h2>Mit Claude verbinden</h2>
          <div className="card stack">
            <strong>MCP-Server-URL</strong>
            <CopyBlock value={mcpUrl} />
          </div>
          <div className="card stack">
            <h3>claude.ai / iPhone-App</h3>
            <p>
              Einstellungen → Connectors → <em>Custom Connector hinzufügen</em> → URL einfügen → Verbinden. Danach
              hier anmelden und auf der Zustimmungsseite wählen, ob Claude nur lesen oder auch Vorschläge machen darf.
            </p>
            <h3>Claude Code</h3>
            <CopyBlock value={`claude mcp add --transport http vault ${mcpUrl}`} />
            <p className="muted">Danach in Claude Code <code>/mcp</code> → vault → Authenticate.</p>
          </div>
        </div>
      </Guard>
    </Shell>
  );
}
