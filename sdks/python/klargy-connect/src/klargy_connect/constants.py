"""Names and limits fixed by Klargy Connect v1 (docs/connect/v1.md)."""
from __future__ import annotations

CONTRACT = "klargy-connect/v1"
"""The contract name `GET /me` and the desk's `klargy:ready` message report."""

CONNECT_PATH = "/api/v1/connect/v1"
"""Where the Connect API lives under a workspace URL."""

SCOPES = (
    "integration:write",
    "catalog:read",
    "catalog:write",
    "patients:write",
    "entries:read",
    "entries:write",
    "desk:launch",
    "appointments:write",
    "analytics:read",
)

# --- queue entries ------------------------------------------------------------------------------

REF_TYPES = ("visit", "encounter", "entry")
"""How a by-ref call names an entry: the EMR visit, the EMR encounter, or a Klargy entry id."""

STATUS_ACTIONS = ("call", "complete", "cancel", "no-show", "hold", "resume", "clear")
"""By-ref actions that only change an entry's status (hold, resume and clear: the patient journey)."""

ENTRY_ACTIONS = STATUS_ACTIONS + ("transfer", "priority")
"""Every `POST /entries/by-ref/{type}/{id}/{action}` action."""

ENTRY_STATUSES = ("WAITING", "SERVING", "SERVED", "CANCELLED", "NO_SHOW")

PRIORITY_MIN = 0
PRIORITY_MAX = 100

MAX_IDEMPOTENCY_KEY_LENGTH = 255
"""Klargy keeps the first successful response to a key for 24 hours."""

# --- mappings, appointments, services -----------------------------------------------------------

ADMIN_RESOURCE_TYPES = ("location", "service", "service_point", "staff")
REFERENCE_RESOURCE_TYPES = ("patient", "visit", "encounter", "appointment")
RESOURCE_TYPES = ADMIN_RESOURCE_TYPES + REFERENCE_RESOURCE_TYPES
"""`GET /mappings?resourceType=` values."""

SERVICE_KINDS = ("clinic", "lab", "imaging", "pharmacy", "cashier")
"""Known catalogue service kinds (any other text is kept by Klargy)."""

APPOINTMENT_STATUSES = ("booked", "cancelled", "no_show", "completed")
"""What `PUT /appointments/{ref}` accepts; responses may also say `checked_in`."""

SERVICE_STATUSES = ("PAUSED", "ACTIVE")
"""What `POST /services/{service}/status` accepts."""

# --- webhooks -----------------------------------------------------------------------------------

WEBHOOK_EVENTS = (
    "entry.joined",
    "entry.called",
    "entry.served",
    "entry.cancelled",
    "entry.no_show",
    "entry.transferred",
    "entry.priority_changed",
    "entry.held",
    "entry.resumed",
    "entry.cleared",
    "queue.paused",
    "queue.resumed",
    "appointment.created",
    "appointment.rescheduled",
    "appointment.cancelled",
    "appointment.checked_in",
    "journey.completed",
    "servicepoint.opened",
    "servicepoint.closed",
)
"""Events an integration's endpoint is subscribed to. The admin's "Send test" button sends `ping`."""

PING_EVENT = "ping"
LOOKUP_EVENT = "patient.lookup"
"""`X-Webhook-Event` of Klargy's patient lookup call."""

ORIGIN_TYPES = ("staff", "public", "integration", "system")

SENT_BY = ("staff", "patient", "integration")
"""An entry's `sentBy` when a transfer made it (else null)."""

SIGNATURE_TOLERANCE_SECONDS = 300
"""Reject a timestamp more than 5 minutes from the receiver's clock."""

HEADER_ID = "X-Webhook-Id"
HEADER_EVENT = "X-Webhook-Event"
HEADER_TIMESTAMP = "X-Webhook-Timestamp"
HEADER_SIGNATURE = "X-Webhook-Signature"
HEADER_IDEMPOTENCY_KEY = "Idempotency-Key"
HEADER_IDEMPOTENT_REPLAYED = "Idempotent-Replayed"

# --- patient lookup -----------------------------------------------------------------------------

LOOKUP_IDENTIFIER_TYPES = ("mrNumber", "memberNumber", "phone", "nationalId", "passport", "patientRef")
LOOKUP_CONTEXTS = ("staff", "public")
COVER_STATUSES = ("active", "expired", "inactive", "unknown")
COVER_CHECKED_VIA = ("payer", "records")
LOOKUP_MAX_CANDIDATES = 5
LOOKUP_TIMEOUT_SECONDS = 5
"""Klargy waits this long for the EMR's answer."""
