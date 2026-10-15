"""The desk `postMessage` protocol v1 (docs/connect/v1.md section 6).

The embedding itself happens in the browser (see the TypeScript package's `desk` entry point); these
helpers are for EMR backends and tests that relay or check desk messages.

Desk -> parent (posted with targetOrigin = the launch's returnOrigin, never "*"):
    klargy:ready          contract ("klargy-connect/v1"), once after sign-in
    klargy:desk-changed   servicePoint {id, name, externalId} or null
    klargy:waiting        count
    klargy:entry-called   entry (with this integration's refs)
    klargy:entry-updated  entry
Parent -> desk (accepted only from returnOrigin, only from the parent window):
    klargy:logout
Accept a message only when its origin equals the origin of the launch `url`.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional
from urllib.parse import urlsplit


MSG_READY = "klargy:ready"
MSG_DESK_CHANGED = "klargy:desk-changed"
MSG_WAITING = "klargy:waiting"
MSG_ENTRY_CALLED = "klargy:entry-called"
MSG_ENTRY_UPDATED = "klargy:entry-updated"
MSG_LOGOUT = "klargy:logout"

DESK_MESSAGE_TYPES = (MSG_READY, MSG_DESK_CHANGED, MSG_WAITING, MSG_ENTRY_CALLED, MSG_ENTRY_UPDATED)
HOST_MESSAGE_TYPES = (MSG_LOGOUT,)


def origin_of(url: Optional[str]) -> Optional[str]:
    """`scheme://host[:port]` of an http(s) URL, else None."""
    if not isinstance(url, str) or not url:
        return None
    parts = urlsplit(url.strip())
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return None
    host = parts.hostname
    if ":" in host:  # IPv6
        host = f"[{host}]"
    default = {"http": 80, "https": 443}[parts.scheme]
    try:
        port = parts.port
    except ValueError:
        return None
    return f"{parts.scheme}://{host}" + (f":{port}" if port and port != default else "")


def is_desk_origin(message_origin: Optional[str], launch_url: str) -> bool:
    """True when a message came from the desk opened with `launch_url`."""
    expected = origin_of(launch_url)
    return expected is not None and origin_of(message_origin) == expected


@dataclass(frozen=True)
class DeskMessage:
    type: str
    contract: Optional[str] = None
    """klargy:ready."""
    service_point: Optional[Dict[str, Any]] = None
    """klargy:desk-changed: {id, name, externalId}, or None when the practitioner left the room."""
    count: Optional[int] = None
    """klargy:waiting."""
    entry: Optional[Dict[str, Any]] = None
    """klargy:entry-called, klargy:entry-updated."""


def parse_desk_message(data: Any) -> Optional[DeskMessage]:
    """A desk message, or None for anything that is not a well-formed v1 desk message."""
    if not isinstance(data, Mapping):
        return None
    kind = data.get("type")
    if kind == MSG_READY:
        contract = data.get("contract")
        return DeskMessage(kind, contract=contract) if isinstance(contract, str) else None
    if kind == MSG_DESK_CHANGED:
        point = data.get("servicePoint")
        if point is None:
            return DeskMessage(kind)
        if isinstance(point, Mapping) and isinstance(point.get("id"), str):
            return DeskMessage(kind, service_point={"id": point["id"], "name": point.get("name"),
                                                    "externalId": point.get("externalId")})
        return None
    if kind == MSG_WAITING:
        count = data.get("count")
        return DeskMessage(kind, count=count) if isinstance(count, int) and not isinstance(count, bool) and count >= 0 else None
    if kind in (MSG_ENTRY_CALLED, MSG_ENTRY_UPDATED):
        entry = data.get("entry")
        return DeskMessage(kind, entry=dict(entry)) if isinstance(entry, Mapping) else None
    return None


def logout_message() -> Dict[str, str]:
    """What the parent posts to the desk when the practitioner signs out of the EMR."""
    return {"type": MSG_LOGOUT}


__all__ = [
    "DESK_MESSAGE_TYPES",
    "DeskMessage",
    "HOST_MESSAGE_TYPES",
    "MSG_DESK_CHANGED",
    "MSG_ENTRY_CALLED",
    "MSG_ENTRY_UPDATED",
    "MSG_LOGOUT",
    "MSG_READY",
    "MSG_WAITING",
    "is_desk_origin",
    "logout_message",
    "origin_of",
    "parse_desk_message",
]
