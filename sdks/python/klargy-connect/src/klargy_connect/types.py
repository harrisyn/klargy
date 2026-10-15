"""Shapes of the main Connect v1 request bodies, for type checkers (docs/connect/v1.md).

They are plain dicts at runtime: the clients send exactly what they are given. Every key is
optional here (total=False); the docstrings say which ones Klargy requires.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, TypedDict, Union


class SystemInfo(TypedDict, total=False):
    name: str
    version: str


class RegisterIntegrationBody(TypedDict, total=False):
    """PUT /integration. `webhookUrl` is required."""

    system: SystemInfo
    webhookUrl: str
    lookupUrl: Optional[str]
    embedOrigins: List[str]


class CatalogItem(TypedDict, total=False):
    id: str
    name: str
    locationId: str
    kind: str
    email: str


class RegistrationField(TypedDict, total=False):
    key: str
    label: str
    required: bool
    type: str


class CatalogBody(TypedDict, total=False):
    """PUT /catalog. Every array is optional; ids are unique within their array."""

    locations: List[CatalogItem]
    services: List[CatalogItem]
    servicePoints: List[CatalogItem]
    practitioners: List[CatalogItem]
    registrationFields: List[RegistrationField]


class PatientBody(TypedDict, total=False):
    """PUT /patients/{id} (firstName and lastName required) and the `patient` of POST /entries."""

    firstName: str
    lastName: str
    phone: Optional[str]
    email: Optional[str]
    identifiers: Dict[str, Union[str, int, float]]


class EntryRefs(TypedDict, total=False):
    patient: str
    visit: str
    appointment: Optional[str]
    encounter: Optional[str]


class CreateEntryBody(TypedDict, total=False):
    """POST /entries. `refs.patient`, `refs.visit` and `service` are required; `patient` the first
    time Klargy sees `refs.patient`."""

    refs: EntryRefs
    patient: PatientBody
    service: str
    priority: int
    notes: Optional[str]
    cleared: bool
    """Payment already settled: skips the service's payment gate."""


class EntryActionBody(TypedDict, total=False):
    """POST /entries/by-ref/{type}/{id}/{action}. `to` is required for transfer, `priority` for
    priority."""

    service: str
    encounter: str
    servicePoint: str
    staff: str
    reason: str
    to: str
    priority: int
    cleared: bool
    """transfer: payment already settled, skips the target service's payment gate."""


class ServingLinkRefs(TypedDict, total=False):
    patient: str
    visit: str
    encounter: Optional[str]


class ServingLinkBody(TypedDict, total=False):
    """POST /entries/serving/link. `staff` and `refs.patient`/`refs.visit` are required."""

    staff: str
    refs: ServingLinkRefs
    patient: PatientBody


class JourneyService(TypedDict):
    id: str
    ref: Optional[str]
    name: str


class JourneyStep(TypedDict):
    """One stop in an entry's `journey` (oldest first)."""

    entryId: str
    ticketNumber: str
    service: JourneyService
    status: str
    joinedAt: str
    endedAt: Optional[str]


class DeskStaff(TypedDict, total=False):
    id: str
    name: str
    email: Optional[str]


class LaunchDeskBody(TypedDict, total=False):
    """POST /desk/launch. `staff.id`, `staff.name` and `returnOrigin` are required."""

    staff: DeskStaff
    servicePoint: Optional[str]
    returnOrigin: str


class AppointmentRefs(TypedDict, total=False):
    patient: str
    visit: Optional[str]


class AppointmentBody(TypedDict, total=False):
    """PUT /appointments/{ref}. `refs.patient`, `service` and `startTime` are required."""

    refs: AppointmentRefs
    patient: PatientBody
    service: str
    startTime: str
    endTime: Optional[str]
    status: str
    staff: Optional[str]
    notes: Optional[str]


class ServiceStatusBody(TypedDict, total=False):
    """POST /services/{service}/status. `status` is PAUSED or ACTIVE."""

    status: str
    reason: str
    message: str


Entry = Dict[str, Any]
"""The entry object: webhook `data` for an entry event, with `refs`, without `origin`."""
