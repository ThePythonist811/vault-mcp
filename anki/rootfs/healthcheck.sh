#!/bin/bash
# Both addon servers only start once Anki's event loop is up, so an open port
# on each is a real liveness signal for the whole stack.
set -euo pipefail

exec python3 - "${ANKI_MCP_PORT:-3141}" "${ANKICONNECT_PORT:-8765}" <<'PY'
import socket, sys

for port in (int(p) for p in sys.argv[1:]):
    try:
        socket.create_connection(("127.0.0.1", port), timeout=3).close()
    except OSError as exc:
        print(f"port {port} not accepting connections: {exc}", file=sys.stderr)
        sys.exit(1)
PY
