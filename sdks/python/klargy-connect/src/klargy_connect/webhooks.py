"""Verifying what Klargy sends: webhooks and the patient lookup call (same signing scheme).

    X-Webhook-Id: <delivery id>              (the de-duplication key; a retry reuses it)
    X-Webhook-Event: entry.called            (patient.lookup for the lookup call)
    X-Webhook-Timestamp: <unix seconds>
    X-Webhook-Signature: sha256=<hex HMAC-SHA256(signingSecret, "<timestamp>.<raw body>")>

Always verify over the exact raw body bytes, before parsing it.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, Mapping, Optional, Union

from .constants import (
    HEADER_EVENT,
    HEADER_ID,
    HEADER_SIGNATURE,
    HEADER_TIMESTAMP,
    SIGNATURE_TOLERANCE_SECONDS,
)
from .errors import WebhookVerificationError

RawBody = Union[bytes, bytearray, str]
Clock = Union[int, float, datetime, None]


def _bytes(raw_body: RawBody) -> bytes:
    if isinstance(raw_body, str):
        return raw_body.encode("utf-8")
    return bytes(raw_body)


def _lower(headers: Mapping[str, Any]) -> Dict[str, str]:
    lowered: Dict[str, str] = {}
    for key, value in headers.items():
        if isinstance(value, (list, tuple)):
            value = value[0] if value else ""
        lowered[str(key).lower()] = value if isinstance(value, str) else ("" if value is None else str(value))
    return lowered


def _now(now: Clock) -> float:
    if now is None:
        return time.time()
    if isinstance(now, datetime):
        return now.timestamp()
    return float(now)


def sign_payload(secret: str, timestamp: Union[str, int], raw_body: RawBody) -> str:
    """Hex HMAC-SHA256 of "<timestamp>.<raw body>": the signature without its `sha256=` prefix."""
    message = f"{timestamp}.".encode("utf-8") + _bytes(raw_body)
    return hmac.new(str(secret).encode("utf-8"), message, hashlib.sha256).hexdigest()


def signature_headers(
    secret: str,
    raw_body: RawBody,
    *,
    event: str = "ping",
    delivery_id: Optional[str] = None,
    timestamp: Optional[Union[int, str]] = None,
) -> Dict[str, str]:
    """The headers Klargy would send with `raw_body`; for tests and local tools."""
    ts = str(int(time.time()) if timestamp is None else timestamp)
    return {
        "Content-Type": "application/json",
        HEADER_ID: delivery_id or str(uuid.uuid4()),
        HEADER_EVENT: event,
        HEADER_TIMESTAMP: ts,
        HEADER_SIGNATURE: f"sha256={sign_payload(secret, ts, raw_body)}",
    }


def verify_webhook(
    secret: str,
    headers: Mapping[str, Any],
    raw_body: RawBody,
    *,
    tolerance_seconds: int = SIGNATURE_TOLERANCE_SECONDS,
    now: Clock = None,
) -> None:
    """Raise WebhookVerificationError unless `raw_body` was signed by Klargy with `secret` within
    `tolerance_seconds` (default 5 minutes) of `now`. Header names are matched case-insensitively."""
    if not secret:
        raise WebhookVerificationError("A signing secret is required to verify Klargy calls",
                                       WebhookVerificationError.SECRET_MISSING)
    lowered = _lower(headers)
    signature = (lowered.get(HEADER_SIGNATURE.lower()) or "").strip()
    timestamp = (lowered.get(HEADER_TIMESTAMP.lower()) or "").strip()
    if not signature or not timestamp:
        raise WebhookVerificationError("X-Webhook-Signature and X-Webhook-Timestamp are required",
                                       WebhookVerificationError.SIGNATURE_MISSING)
    try:
        sent_at = int(timestamp)
    except ValueError:
        raise WebhookVerificationError("X-Webhook-Timestamp must be unix seconds",
                                       WebhookVerificationError.TIMESTAMP_INVALID) from None
    if abs(_now(now) - sent_at) > tolerance_seconds:
        window = "5 minutes" if tolerance_seconds == SIGNATURE_TOLERANCE_SECONDS else f"{tolerance_seconds} seconds"
        raise WebhookVerificationError(f"X-Webhook-Timestamp is more than {window} from the server clock",
                                       WebhookVerificationError.TIMESTAMP_STALE)
    expected = "sha256=" + sign_payload(secret, timestamp, raw_body)
    if not hmac.compare_digest(expected.encode("utf-8"), signature.encode("utf-8")):
        raise WebhookVerificationError("Invalid webhook signature", WebhookVerificationError.SIGNATURE_INVALID)


@dataclass
class WebhookEvent:
    """A delivery: `{id, event, createdAt, data}`. `data` holds the event's fields; for an
    integration's own endpoint it carries `refs` (the EMR's ids) and `origin`."""

    id: str
    event: str
    created_at: Optional[str]
    data: Dict[str, Any]
    body: Dict[str, Any] = field(repr=False)

    @property
    def refs(self) -> Dict[str, Any]:
        refs = self.data.get("refs")
        return refs if isinstance(refs, dict) else {}

    @property
    def origin(self) -> Dict[str, Any]:
        origin = self.data.get("origin")
        return origin if isinstance(origin, dict) else {}

    def is_own(self, integration_id: Optional[str]) -> bool:
        """True when the event echoes this integration's own Connect call: ignore it."""
        return bool(integration_id) and self.origin.get("type") == "integration" \
            and self.origin.get("integrationId") == integration_id


def parse_webhook(raw_body: RawBody, headers: Optional[Mapping[str, Any]] = None) -> WebhookEvent:
    """Decode a (verified) delivery. The id and event come from X-Webhook-Id / X-Webhook-Event when
    given, else from the body. Raises ValueError for a body that is not a delivery."""
    body = json.loads(_bytes(raw_body))
    if not isinstance(body, dict):
        raise ValueError("Webhook body must be a JSON object")
    lowered = _lower(headers or {})
    event_id = lowered.get(HEADER_ID.lower()) or body.get("id")
    event = lowered.get(HEADER_EVENT.lower()) or body.get("event")
    if not event_id or not event:
        raise ValueError("Webhook has no id or event type")
    data = body.get("data") if isinstance(body.get("data"), dict) else {}
    created = body.get("createdAt")
    return WebhookEvent(id=str(event_id), event=str(event), created_at=created if isinstance(created, str) else None,
                        data=data, body=body)


def construct_event(
    secret: str,
    headers: Mapping[str, Any],
    raw_body: RawBody,
    *,
    tolerance_seconds: int = SIGNATURE_TOLERANCE_SECONDS,
    now: Clock = None,
) -> WebhookEvent:
    """`verify_webhook`, then `parse_webhook`."""
    verify_webhook(secret, headers, raw_body, tolerance_seconds=tolerance_seconds, now=now)
    return parse_webhook(raw_body, headers)


__all__ = [
    "WebhookEvent",
    "construct_event",
    "parse_webhook",
    "sign_payload",
    "signature_headers",
    "verify_webhook",
]
