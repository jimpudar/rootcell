#!/usr/bin/env python3
import os
import selectors
import signal
import socket
import sys
from typing import Optional


def die(message: str) -> None:
    print(f"rootcell-vfkit-l2: {message}", file=sys.stderr)
    sys.exit(2)


def bind_datagram(path: str) -> socket.socket:
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    sock.bind(path)
    os.chmod(path, 0o600)
    sock.setblocking(False)
    return sock


def main() -> int:
    if len(sys.argv) != 3:
        die("usage: rootcell-vfkit-l2-helper.py FIREWALL_SOCKET AGENT_SOCKET")
    firewall_path, agent_path = sys.argv[1], sys.argv[2]
    os.makedirs(os.path.dirname(firewall_path), exist_ok=True)
    os.makedirs(os.path.dirname(agent_path), exist_ok=True)

    firewall = bind_datagram(firewall_path)
    agent = bind_datagram(agent_path)
    peers: dict[socket.socket, Optional[str]] = {firewall: None, agent: None}
    other = {firewall: agent, agent: firewall}
    selector = selectors.DefaultSelector()
    selector.register(firewall, selectors.EVENT_READ)
    selector.register(agent, selectors.EVENT_READ)

    running = True

    def stop(_signum, _frame) -> None:
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    while running:
        for key, _events in selector.select(timeout=1.0):
            src = key.fileobj
            if not isinstance(src, socket.socket):
                continue
            try:
                payload, peer = src.recvfrom(65536)
            except BlockingIOError:
                continue
            if peer:
                peers[src] = peer
            dst = other[src]
            dst_peer = peers[dst]
            if dst_peer is None:
                continue
            try:
                dst.sendto(payload, dst_peer)
            except OSError as error:
                print(f"rootcell-vfkit-l2: failed to forward frame: {error}", file=sys.stderr)

    firewall.close()
    agent.close()
    for path in (firewall_path, agent_path):
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
