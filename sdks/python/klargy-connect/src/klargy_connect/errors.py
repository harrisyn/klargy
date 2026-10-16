"""Typed errors.

Every Connect refusal is `{"error": "message"}`, and most add a machine-readable `"code"` (and for some
codes extra fields: `entry`, `status`, `limitType`, `current`, `limit`). `ConnectError` carries all of
it; its subclasses let callers catch by HTTP status.
"""
from __future__ import annotations

from typing import Any, Dict, Mapping, Optional, Type


class ErrorCode:
    """The `code` values Klargy Connect v1 sends."""

    SERVICE_NOT_MAPPED = "SERVICE_NOT_MAPPED"
    LOCATION_NOT_MAPPED = "LOCATION_NOT_MAPPED"
    SERVICE_POINT_NOT_MAPPED = "SERVICE_POINT_NOT_MAPPED"
    INVALID_SERVICE_POINT = "INVALID_SERVICE_POINT"
    QUEUE_CLOSED = "QUEUE_CLOSED"
    PATIENT_REQUIRED = "PATIENT_REQUIRED"
    LIMIT_REACHED = "LIMIT_REACHED"
    VISIT_PATIENT_MISMATCH = "VISIT_PATIENT_MISMATCH"
    ALREADY_IN_QUEUE = "ALREADY_IN_QUEUE"
    ENTRY_NOT_FOUND = "ENTRY_NOT_FOUND"
    NO_OPEN_ENTRY = "NO_OPEN_ENTRY"
    INVALID_TRANSITION = "INVALID_TRANSITION"
    IDEMPOTENCY_KEY_REUSED = "IDEMPOTENCY_KEY_REUSED"
    IDEMPOTENCY_IN_PROGRESS = "IDEMPOTENCY_IN_PROGRESS"
    ORIGIN_NOT_ALLOWED = "ORIGIN_NOT_ALLOWED"
    STAFF_INACTIVE = "STAFF_INACTIVE"
    STAFF_NOT_MAPPED = "STAFF_NOT_MAPPED"
    AWAITING_CLEARANCE = "AWAITING_CLEARANCE"
    ENTRY_IN_OTHER_SERVICE = "ENTRY_IN_OTHER_SERVICE"
    NO_SERVING_ENTRY = "NO_SERVING_ENTRY"


class KlargyConnectError(Exception):
    """Base class of everything this package raises on purpose."""


class ConnectError(KlargyConnectError):
    """Klargy answered with an HTTP error (4xx or 5xx).

    Attributes: `status` (HTTP status), `code` (the contract's `code`, or None), `message` (the
    `error` text), `body` (the parsed JSON body, or None), `text` (the raw body), `reason_phrase`,
    `method` and `path` (the Connect path called, with its query), `headers` (response headers).
    """

    def __init__(
        self,
        message: str,
        *,
        status: int,
        code: Optional[str] = None,
        body: Any = None,
        text: str = "",
        reason_phrase: str = "",
        method: str = "",
        path: str = "",
        headers: Optional[Mapping[str, str]] = None,
    ):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code
        self.body = body
        self.text = text
        self.reason_phrase = reason_phrase
        self.method = method
        self.path = path
        self.headers: Dict[str, str] = dict(headers or {})

    @property
    def details(self) -> Dict[str, Any]:
        """Fields sent beside `error` and `code` (e.g. `entry`, `status`, `limitType`)."""
        if not isinstance(self.body, dict):
            return {}
        return {k: v for k, v in self.body.items() if k not in ("error", "code")}

    @property
    def entry(self) -> Optional[Dict[str, Any]]:
        """The open entry an `ALREADY_IN_QUEUE` refusal carries."""
        entry = self.body.get("entry") if isinstance(self.body, dict) else None
        return entry if isinstance(entry, dict) else None

    @property
    def entry_status(self) -> Optional[str]:
        """The entry's current status an `INVALID_TRANSITION` refusal carries."""
        status = self.body.get("status") if isinstance(self.body, dict) else None
        return status if isinstance(status, str) else None

    def __repr__(self) -> str:
        return f"{type(self).__name__}(status={self.status}, code={self.code!r}, message={self.message!r})"


class BadRequestError(ConnectError):
    """400: a missing or malformed field (or `ORIGIN_NOT_ALLOWED`)."""


class AuthenticationError(ConnectError):
    """401: a missing, unknown or revoked API key."""


class PermissionDeniedError(ConnectError):
    """403: a missing scope, a plan without `emrIntegration`, `LIMIT_REACHED` or `STAFF_INACTIVE`."""


class NotFoundError(ConnectError):
    """404: `SERVICE_NOT_MAPPED`, `NO_OPEN_ENTRY`, `ENTRY_NOT_FOUND` and similar."""


class ConflictError(ConnectError):
    """409: `QUEUE_CLOSED`, `INVALID_TRANSITION`, `ALREADY_IN_QUEUE`, `IDEMPOTENCY_IN_PROGRESS` and similar."""


class UnprocessableEntityError(ConnectError):
    """422: `PATIENT_REQUIRED`, `IDEMPOTENCY_KEY_REUSED`, `INVALID_SERVICE_POINT`."""


class RateLimitError(ConnectError):
    """429: too many requests for this key."""


class ServerError(ConnectError):
    """5xx."""


_BY_STATUS: Dict[int, Type[ConnectError]] = {
    400: BadRequestError,
    401: AuthenticationError,
    403: PermissionDeniedError,
    404: NotFoundError,
    409: ConflictError,
    422: UnprocessableEntityError,
    429: RateLimitError,
}


def error_class_for(status: int) -> Type[ConnectError]:
    if status >= 500:
        return ServerError
    return _BY_STATUS.get(status, ConnectError)


class ConnectTransportError(KlargyConnectError):
    """No HTTP answer: the connection failed. The underlying httpx error is `__cause__`."""

    def __init__(self, message: str, *, method: str = "", path: str = ""):
        super().__init__(message)
        self.message = message
        self.method = method
        self.path = path


class ConnectTimeoutError(ConnectTransportError):
    """No HTTP answer within the timeout."""


class InvalidResponseError(KlargyConnectError):
    """A successful answer that is not a JSON object."""

    def __init__(self, message: str, *, status: int, text: str = "", method: str = "", path: str = ""):
        super().__init__(message)
        self.message = message
        self.status = status
        self.text = text
        self.method = method
        self.path = path


class WebhookVerificationError(KlargyConnectError):
    """A signed call from Klargy (webhook or patient lookup) that must be refused with 401.

    `code` is one of: SECRET_MISSING, SIGNATURE_MISSING, TIMESTAMP_INVALID, TIMESTAMP_STALE,
    SIGNATURE_INVALID, EVENT_MISMATCH.
    """

    SECRET_MISSING = "SECRET_MISSING"
    SIGNATURE_MISSING = "SIGNATURE_MISSING"
    TIMESTAMP_INVALID = "TIMESTAMP_INVALID"
    TIMESTAMP_STALE = "TIMESTAMP_STALE"
    SIGNATURE_INVALID = "SIGNATURE_INVALID"
    EVENT_MISMATCH = "EVENT_MISMATCH"

    def __init__(self, message: str, code: str):
        super().__init__(message)
        self.message = message
        self.code = code


class LookupRequestError(KlargyConnectError, ValueError):
    """A verified patient lookup whose body is not a valid lookup request (answer 400)."""
