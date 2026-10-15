"""Serving Klargy's patient lookup (docs/connect/v1.md section 7).

Klargy POSTs to the integration's `lookupUrl`, signed like a webhook with `X-Webhook-Event:
patient.lookup`:

    {"identifierType": "mrNumber", "identifier": "NH-004512", "context": "staff", "locationRef": null}

Answer 401 for a bad, missing or stale signature (`verify_lookup_request` raises
WebhookVerificationError), 400 for a bad body (LookupRequestError), 404 for an unknown or switched-off
connection, else 200 with `lookup_match(...)`, `lookup_candidates(...)` or `lookup_no_match()`. For
`context == "public"` send only `public_response(...)` (Klargy drops anything else anyway).
Klargy waits 5 seconds and never retries inside someone's request.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Mapping, Optional

from .constants import (
    COVER_CHECKED_VIA,
    COVER_STATUSES,
    HEADER_EVENT,
    LOOKUP_CONTEXTS,
    LOOKUP_EVENT,
    LOOKUP_IDENTIFIER_TYPES,
    LOOKUP_MAX_CANDIDATES,
    SIGNATURE_TOLERANCE_SECONDS,
)
from .errors import LookupRequestError, WebhookVerificationError
from .webhooks import Clock, RawBody, _bytes, _lower, verify_webhook


@dataclass(frozen=True)
class LookupRequest:
    identifier_type: str
    """mrNumber, memberNumber, phone, nationalId, passport or patientRef (staff only)."""
    identifier: str
    context: str
    """staff (someone in Klargy) or public (kiosk, join page)."""
    location_ref: Optional[str]
    """The EMR's id for the Klargy location, when mapped."""

    @property
    def is_public(self) -> bool:
        return self.context == "public"


def parse_lookup_request(raw_body: RawBody) -> LookupRequest:
    """Decode a lookup body; LookupRequestError (answer 400) when it isn't one."""
    try:
        body = json.loads(_bytes(raw_body))
    except ValueError as exc:
        raise LookupRequestError(f"Lookup body is not JSON: {exc}") from None
    if not isinstance(body, dict):
        raise LookupRequestError("Lookup body must be a JSON object")
    identifier_type = body.get("identifierType")
    if identifier_type not in LOOKUP_IDENTIFIER_TYPES:
        raise LookupRequestError(f"identifierType must be one of: {', '.join(LOOKUP_IDENTIFIER_TYPES)}")
    identifier = body.get("identifier")
    if not isinstance(identifier, str) or not identifier.strip():
        raise LookupRequestError("identifier is required")
    context = body.get("context")
    if context not in LOOKUP_CONTEXTS:
        raise LookupRequestError(f"context must be one of: {', '.join(LOOKUP_CONTEXTS)}")
    if context == "public" and identifier_type == "patientRef":
        raise LookupRequestError("patientRef lookups are staff only")
    location_ref = body.get("locationRef")
    return LookupRequest(
        identifier_type=identifier_type,
        identifier=identifier.strip(),
        context=context,
        location_ref=str(location_ref) if location_ref not in (None, "") else None,
    )


def verify_lookup_request(
    secret: str,
    headers: Mapping[str, Any],
    raw_body: RawBody,
    *,
    tolerance_seconds: int = SIGNATURE_TOLERANCE_SECONDS,
    now: Clock = None,
) -> LookupRequest:
    """Verify the signature (as `verify_webhook`) and that `X-Webhook-Event` is `patient.lookup`,
    then decode the body."""
    verify_webhook(secret, headers, raw_body, tolerance_seconds=tolerance_seconds, now=now)
    event = (_lower(headers).get(HEADER_EVENT.lower()) or "").strip()
    if event != LOOKUP_EVENT:
        raise WebhookVerificationError(f"X-Webhook-Event must be {LOOKUP_EVENT}", WebhookVerificationError.EVENT_MISMATCH)
    return parse_lookup_request(raw_body)


# --- answers ------------------------------------------------------------------------------------


def lookup_cover(
    payer: str,
    *,
    status: str = "unknown",
    plan: Optional[str] = None,
    member_number: Optional[str] = None,
    expires_on: Optional[str] = None,
    checked_via: Optional[str] = None,
    message: Optional[str] = None,
) -> Dict[str, Any]:
    """A patient's `cover`. A failed cover check is `status="unknown"` with a `message`, never an error."""
    if status not in COVER_STATUSES:
        raise ValueError(f"status must be one of {list(COVER_STATUSES)}")
    if checked_via is not None and checked_via not in COVER_CHECKED_VIA:
        raise ValueError(f"checked_via must be one of {list(COVER_CHECKED_VIA)}")
    return {"payer": payer, "plan": plan, "memberNumber": member_number, "status": status,
            "expiresOn": expires_on, "checkedVia": checked_via, "message": message}


def lookup_patient(
    ref: str,
    display_name: str,
    *,
    first_name: Optional[str] = None,
    mr_number: Optional[str] = None,
    birth_date: Optional[str] = None,
    gender: Optional[str] = None,
    phone_masked: Optional[str] = None,
    photo_url: Optional[str] = None,
    national_id: Optional[str] = None,
    passport: Optional[str] = None,
    member_number: Optional[str] = None,
    cover: Optional[Mapping[str, Any]] = None,
    flags: Iterable[str] = (),
) -> Dict[str, Any]:
    """The staff answer's `patient`."""
    return {
        "ref": str(ref),
        "displayName": display_name,
        "firstName": first_name,
        "mrNumber": mr_number,
        "birthDate": birth_date,
        "gender": gender,
        "phoneMasked": phone_masked,
        "photoUrl": photo_url,
        "identifiers": {"nationalId": national_id, "passport": passport, "memberNumber": member_number},
        "cover": dict(cover) if cover is not None else None,
        "flags": [str(f) for f in flags],
    }


def lookup_candidate(
    ref: str,
    display_name: str,
    *,
    mr_number: Optional[str] = None,
    birth_date: Optional[str] = None,
    phone_masked: Optional[str] = None,
) -> Dict[str, Any]:
    """One of several patients a staff phone lookup matched."""
    return {"ref": str(ref), "displayName": display_name, "mrNumber": mr_number, "birthDate": birth_date,
            "phoneMasked": phone_masked}


def lookup_match(patient: Mapping[str, Any]) -> Dict[str, Any]:
    """Staff answer: one patient matched."""
    return {"matched": True, "patient": dict(patient), "candidates": []}


def lookup_candidates(candidates: Iterable[Mapping[str, Any]]) -> Dict[str, Any]:
    """Staff answer: several patients matched (at most 5 are sent)."""
    return {"matched": False, "patient": None,
            "candidates": [dict(c) for c in list(candidates)[:LOOKUP_MAX_CANDIDATES]]}


def lookup_no_match() -> Dict[str, Any]:
    return {"matched": False, "patient": None, "candidates": []}


def public_response(matched: bool, first_name: Optional[str] = None) -> Dict[str, Any]:
    """Public answer (kiosk, join page): whether it matched and the first name, nothing else."""
    return {"matched": bool(matched), "patient": {"firstName": first_name} if matched else None, "candidates": []}


def lookup_response(request: LookupRequest, answer: Mapping[str, Any]) -> Dict[str, Any]:
    """The answer for `request`'s context: a staff answer as given, reduced to the public shape for
    a public lookup."""
    if not request.is_public:
        return dict(answer)
    patient = answer.get("patient") if isinstance(answer.get("patient"), Mapping) else None
    matched = answer.get("matched") is True and patient is not None
    return public_response(matched, patient.get("firstName") if matched and patient else None)


def mask_phone(phone: Optional[str], *, keep_start: int = 3, keep_end: int = 2) -> Optional[str]:
    """`0241234519` -> `024•••••19`: enough for staff to recognise a number without showing it."""
    if not phone:
        return None
    digits = "".join(ch for ch in str(phone) if ch.isdigit() or ch == "+")
    if len(digits) <= keep_start + keep_end:
        return "•" * len(digits)
    return digits[:keep_start] + "•" * (len(digits) - keep_start - keep_end) + digits[-keep_end:]


__all__: List[str] = [
    "LookupRequest",
    "lookup_candidate",
    "lookup_candidates",
    "lookup_cover",
    "lookup_match",
    "lookup_no_match",
    "lookup_patient",
    "lookup_response",
    "mask_phone",
    "parse_lookup_request",
    "public_response",
    "verify_lookup_request",
]
