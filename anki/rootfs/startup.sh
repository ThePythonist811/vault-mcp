#!/bin/bash
# X server + VNC + window manager + Anki.
#
# Same shape as the upstream x11-vnc startup script (TigerVNC Xvnc provides the
# framebuffer and the RFB server in one process), plus two additions: VNC
# authentication when the entrypoint wrote a password file, and a signal
# handler so `docker stop` closes the collection instead of killing it.
set -uo pipefail

DATA="${ANKI_DATA:-/data}"
GEOMETRY="${VNC_GEOMETRY:-1920x1080}"
SHUTDOWN_TIMEOUT="${ANKI_SHUTDOWN_TIMEOUT:-25}"

anki_pid=""
stopping=0

# As PID 1 this script is the only process docker signals. Anki runs as a
# child, so forward the signal and give it time to close the SQLite collection
# — otherwise every stack restart is an unclean shutdown.
shutdown() {
    stopping=1
    if [ -n "${anki_pid}" ] && kill -0 "${anki_pid}" 2>/dev/null; then
        echo "[startup] Stopping Anki (pid ${anki_pid})..."
        kill -TERM "${anki_pid}" 2>/dev/null || true
        for _ in $(seq 1 "$((SHUTDOWN_TIMEOUT * 2))"); do
            kill -0 "${anki_pid}" 2>/dev/null || break
            sleep 0.5
        done
        if kill -0 "${anki_pid}" 2>/dev/null; then
            echo "[startup] Anki did not exit in ${SHUTDOWN_TIMEOUT}s, killing."
            kill -KILL "${anki_pid}" 2>/dev/null || true
        fi
    fi
    exit 0
}
trap shutdown TERM INT

if [ -f /run/vnc/passwd ]; then
    SECURITY=(-SecurityTypes VncAuth -PasswordFile /run/vnc/passwd)
else
    SECURITY=(-SecurityTypes None)
fi

Xvnc :99 \
    -geometry "${GEOMETRY}" -depth 24 \
    -rfbport 5900 \
    "${SECURITY[@]}" \
    -AlwaysShared \
    -desktop Anki \
    -nolisten tcp &

# Wait for the X socket before starting clients.
for _ in $(seq 1 50); do
    [ -e /tmp/.X11-unix/X99 ] && break
    sleep 0.2
done

openbox &
sleep 1

# Anki is the workload: if it dies (crash, or a sync error the GUI aborts on),
# restart it rather than leaving the container up with dead ports.
while true; do
    anki -b "${DATA}" &
    anki_pid=$!
    wait "${anki_pid}"
    [ "${stopping}" -eq 1 ] && break
    echo "[startup] Anki exited, restarting in 2s..."
    sleep 2
done
