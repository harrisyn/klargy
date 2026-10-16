"""HTTP clients for the Klargy Connect v1 API (docs/connect/v1.md).

`KlargyConnect` is async (httpx.AsyncClient); `KlargyConnectSync` is the same API on httpx.Client.
Every method sends the contract's JSON as given (camelCase keys, exactly as in v1.md) and returns a
`ConnectResponse`: the decoded JSON object, plus `status_code`, `headers`, `created` (201) and
`replayed` (an Idempotency-Key replay).

Retries (`max_retries`, default 2) only happen when repeating cannot do something twice: GET and PUT
calls, POST calls sent with an Idempotency-Key, and any call Klargy refused with 429 (the rate limit
answers before anything runs). They cover connection failures, timeouts, 429, 502, 503, 504 and 409
IDEMPOTENCY_IN_PROGRESS, waiting `Retry-After` when sent, else `retry_backoff * 2 ** attempt`
seconds (at most 30).
"""
from __future__ import annotations

import asyncio
import time
import uuid
from datetime import datetime, timezone
from typing import (
    Any,
    AsyncIterator,
    Callable,
    Dict,
    Iterator,
    Mapping,
    Optional,
    Union,
)
from urllib.parse import quote, urlencode

import httpx

from ._version import __version__
from .constants import (
    CONNECT_PATH,
    ENTRY_ACTIONS,
    HEADER_IDEMPOTENCY_KEY,
    HEADER_IDEMPOTENT_REPLAYED,
    REF_TYPES,
    RESOURCE_TYPES,
)
from .errors import (
    ConnectError,
    ConnectTimeoutError,
    ConnectTransportError,
    ErrorCode,
    InvalidResponseError,
    error_class_for,
)

DEFAULT_TIMEOUT = 20.0
DEFAULT_USER_AGENT = f"klargy-connect-python/{__version__}"
RETRY_STATUSES = (429, 502, 503, 504)
MAX_RETRY_DELAY = 30.0

Body = Mapping[str, Any]
TimeValue = Union[str, datetime]
ResponseHook = Callable[[str, str, int, float], None]
"""on_response(method, path, status_code, elapsed_seconds), called for every HTTP answer."""


def new_idempotency_key() -> str:
    """A fresh random Idempotency-Key. Keep it with the operation and reuse it on every retry."""
    return str(uuid.uuid4())


class ConnectResponse(dict):
    """A Connect answer: the JSON object, with the HTTP details as attributes."""

    def __init__(self, data: Mapping[str, Any], status_code: int, headers: Optional[Mapping[str, str]] = None):
        super().__init__(data)
        self.status_code = status_code
        self.headers: Dict[str, str] = {str(k).lower(): v for k, v in (headers or {}).items()}

    @property
    def created(self) -> bool:
        """True for 201: something was created (a ticket, patient, appointment, transfer)."""
        return self.status_code == 201

    @property
    def replayed(self) -> bool:
        """True when Klargy replayed the first response to this Idempotency-Key."""
        return self.headers.get(HEADER_IDEMPOTENT_REPLAYED.lower()) == "true"


class _Call:
    __slots__ = ("method", "path", "body", "headers", "timeout")

    def __init__(self, method: str, path: str, body: Optional[Body] = None, *,
                 idempotency_key: Optional[str] = None, timeout: Optional[float] = None):
        self.method = method
        self.path = path
        self.body = dict(body) if body is not None else None
        self.headers: Dict[str, str] = {}
        if idempotency_key is not None and str(idempotency_key) != "":
            self.headers[HEADER_IDEMPOTENCY_KEY] = str(idempotency_key)
        self.timeout = timeout

    @property
    def retry_safe(self) -> bool:
        return self.method in ("GET", "PUT") or HEADER_IDEMPOTENCY_KEY in self.headers


def _seg(value: Any) -> str:
    """One URL path segment: an id can never add a path."""
    return quote(str(value), safe="")


def _time(value: TimeValue) -> str:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return str(value)


def _with_query(path: str, query: Mapping[str, Any]) -> str:
    kept = {k: v for k, v in query.items() if v not in (None, "")}
    return f"{path}?{urlencode(kept)}" if kept else path


def _check_ref(ref_type: str, ref_id: Any) -> None:
    if ref_type not in REF_TYPES:
        raise ValueError(f"ref_type must be one of {list(REF_TYPES)}")
    if ref_id in (None, ""):
        raise ValueError("ref_id is required")


class _Endpoints:
    """One method per Connect endpoint. Each returns whatever `_send` returns: a ConnectResponse
    (sync client) or an awaitable of one (async client)."""

    def _send(self, call: _Call) -> Any:  # pragma: no cover - implemented by the clients
        raise NotImplementedError

    # --- phase 1 --------------------------------------------------------------------------------

    def me(self, *, timeout: Optional[float] = None):
        """GET /me: checks the key; `{contract, organization, integration}`."""
        return self._send(_Call("GET", "/me", timeout=timeout))

    def register_integration(self, body: Body, *, timeout: Optional[float] = None):
        """PUT /integration `{system, webhookUrl, lookupUrl?, embedOrigins?}` ->
        `{integrationId, signingSecret, webhookEvents}`. Call it on every save of the EMR's settings."""
        return self._send(_Call("PUT", "/integration", body, timeout=timeout))

    def put_catalog(self, body: Body, *, timeout: Optional[float] = None):
        """PUT /catalog `{locations?, services?, servicePoints?, practitioners?, registrationFields?}`
        (replaces the previous catalogue) -> `{received: {...counts}}`."""
        return self._send(_Call("PUT", "/catalog", body, timeout=timeout))

    def get_catalog(self, *, timeout: Optional[float] = None):
        """GET /catalog: Klargy's own locations, services and service points with their `externalId`."""
        return self._send(_Call("GET", "/catalog", timeout=timeout))

    def get_mappings(self, resource_type: Optional[str] = None, *, timeout: Optional[float] = None):
        """GET /mappings[?resourceType=]: `{mappings: [{resourceType, klargyId, externalId}]}`. Without a
        type, the admin's mappings (location, service, service_point, staff)."""
        if resource_type is not None and resource_type not in RESOURCE_TYPES:
            raise ValueError(f"resource_type must be one of {list(RESOURCE_TYPES)}")
        return self._send(_Call("GET", _with_query("/mappings", {"resourceType": resource_type}), timeout=timeout))

    # --- phase 2: patients and entries ------------------------------------------------------------

    def upsert_patient(self, patient_id: str, body: Body, *, timeout: Optional[float] = None):
        """PUT /patients/{patientId} `{firstName, lastName, phone?, email?, identifiers?}` ->
        `{patientId, klargyId, created}` (201 created, 200 updated)."""
        return self._send(_Call("PUT", f"/patients/{_seg(patient_id)}", body, timeout=timeout))

    def create_entry(self, body: Body, *, idempotency_key: Optional[str] = None, timeout: Optional[float] = None):
        """POST /entries `{refs: {patient, visit, appointment?, encounter?}, patient?, service, priority?,
        notes?, cleared?}` -> `{entry}`: 201 for a new ticket, 200 for the visit's open entry in that service."""
        return self._send(_Call("POST", "/entries", body, idempotency_key=idempotency_key, timeout=timeout))

    def entry_action(self, ref_type: str, ref_id: str, action: str, body: Optional[Body] = None, *,
                     idempotency_key: Optional[str] = None, timeout: Optional[float] = None):
        """POST /entries/by-ref/{type}/{id}/{action}. `ref_type` is visit, encounter or entry; `action`
        is call, complete, cancel, no-show, hold, resume, clear, transfer or priority. Body fields (all
        optional except as the action needs): service (narrows a visit's entry), encounter,
        servicePoint (call, resume), staff, reason, to (transfer), priority (transfer, priority),
        cleared (transfer)."""
        _check_ref(ref_type, ref_id)
        if action not in ENTRY_ACTIONS:
            raise ValueError(f"action must be one of {list(ENTRY_ACTIONS)}")
        return self._send(_Call("POST", f"/entries/by-ref/{ref_type}/{_seg(ref_id)}/{action}",
                                body if body is not None else {}, idempotency_key=idempotency_key, timeout=timeout))

    def call_entry(self, ref_type: str, ref_id: str, body: Optional[Body] = None, **kw: Any):
        """`call` (WAITING -> SERVING); body may name `servicePoint`, or `staff` to call into the room
        that staff member is signed in to (409 ENTRY_IN_OTHER_SERVICE when the visit is elsewhere)."""
        return self.entry_action(ref_type, ref_id, "call", body, **kw)

    def complete_entry(self, ref_type: str, ref_id: str, body: Optional[Body] = None, **kw: Any):
        """`complete` (-> SERVED); runs the service's flow."""
        return self.entry_action(ref_type, ref_id, "complete", body, **kw)

    def cancel_entry(self, ref_type: str, ref_id: str, body: Optional[Body] = None, **kw: Any):
        """`cancel` (-> CANCELLED)."""
        return self.entry_action(ref_type, ref_id, "cancel", body, **kw)

    def no_show_entry(self, ref_type: str, ref_id: str, body: Optional[Body] = None, **kw: Any):
        """`no-show` (-> NO_SHOW)."""
        return self.entry_action(ref_type, ref_id, "no-show", body, **kw)

    def hold_entry(self, ref_type: str, ref_id: str, body: Optional[Body] = None, **kw: Any):
        """`hold`: the entry being served leaves the room and keeps its place (`held: true`)."""
        return self.entry_action(ref_type, ref_id, "hold", body, **kw)

    def resume_entry(self, ref_type: str, ref_id: str, body: Optional[Body] = None, **kw: Any):
        """`resume`: calls a held entry back to `servicePoint`, else `staff`'s room, else the room it
        was held in."""
        return self.entry_action(ref_type, ref_id, "resume", body, **kw)

    def clear_entry(self, ref_type: str, ref_id: str, body: Optional[Body] = None, **kw: Any):
        """`clear`: payment settled; an entry awaiting clearance joins the line."""
        return self.entry_action(ref_type, ref_id, "clear", body, **kw)

    def link_serving_entry(self, body: Body, *, idempotency_key: Optional[str] = None,
                           timeout: Optional[float] = None):
        """POST /entries/serving/link `{staff, refs: {patient, visit, encounter?}, patient?}` -> `{entry}`:
        links the entry being served in `staff`'s room. 404 NO_SERVING_ENTRY when there is none."""
        return self._send(_Call("POST", "/entries/serving/link", body, idempotency_key=idempotency_key,
                                timeout=timeout))

    def transfer_entry(self, ref_type: str, ref_id: str, body: Body, **kw: Any):
        """`transfer` `{to, service?, priority?, encounter?, staff?, reason?}` -> `{entry, from}`: 201
        with the new ticket and the completed one, or 200 with `from: null` when the visit already has an
        open entry in `to`."""
        return self.entry_action(ref_type, ref_id, "transfer", body, **kw)

    def set_entry_priority(self, ref_type: str, ref_id: str, body: Body, **kw: Any):
        """`priority` `{priority: 0-100, service?, encounter?, staff?, reason?}` -> `{entry}`."""
        return self.entry_action(ref_type, ref_id, "priority", body, **kw)

    def get_entry_by_ref(self, ref_type: str, ref_id: str, *, service: Optional[str] = None,
                         timeout: Optional[float] = None):
        """GET /entries/by-ref/{type}/{id}[?service=]: the entry a by-ref action would move, with a
        fresh `position`."""
        _check_ref(ref_type, ref_id)
        path = _with_query(f"/entries/by-ref/{ref_type}/{_seg(ref_id)}", {"service": service})
        return self._send(_Call("GET", path, timeout=timeout))

    def list_entries(self, updated_since: TimeValue, *, visit: Optional[str] = None,
                     timeout: Optional[float] = None):
        """GET /entries?updatedSince=&visit=: `{entries, nextUpdatedSince}`, oldest change first, at
        most 500. See `iter_entries` to page until caught up."""
        path = _with_query("/entries", {"updatedSince": _time(updated_since), "visit": visit})
        return self._send(_Call("GET", path, timeout=timeout))

    # --- phase 3: desk ----------------------------------------------------------------------------

    def launch_desk(self, body: Body, *, timeout: Optional[float] = None):
        """POST /desk/launch `{staff: {id, name, email?}, servicePoint?, returnOrigin}` ->
        `{url, expiresAt, staff: {klargyId, created}}`. The url works once within 60 seconds."""
        return self._send(_Call("POST", "/desk/launch", body, timeout=timeout))

    def get_staff_desk(self, staff_ref: str, *, timeout: Optional[float] = None):
        """GET /staff/{staffRef}/desk: the room the staff member (the EMR's practitioner id) is signed in
        to now: `{servicePoint: {id, ref, name, serviceId, serviceRef} | None, desk: {id, name} | None,
        signedInAt}`. For checking a room without relying on `servicepoint.opened` webhooks. 404
        `STAFF_NOT_MAPPED` for a practitioner Klargy doesn't know."""
        return self._send(_Call("GET", f"/staff/{_seg(staff_ref)}/desk", timeout=timeout))

    # --- phase 5: journey automation --------------------------------------------------------------

    def upsert_appointment(self, appointment_ref: str, body: Body, *, timeout: Optional[float] = None):
        """PUT /appointments/{appointmentRef} `{refs: {patient, visit?}, patient?, service, startTime,
        endTime?, status?, staff?, notes?}` -> `{appointment}` (201 created, 200 updated)."""
        return self._send(_Call("PUT", f"/appointments/{_seg(appointment_ref)}", body, timeout=timeout))

    def get_analytics(self, *, from_: Optional[TimeValue] = None, to: Optional[TimeValue] = None,
                      location: Optional[str] = None, service: Optional[str] = None,
                      timeout: Optional[float] = None):
        """GET /analytics?from=&to=&location=&service=: `{from, to, overall, live, services}`. Without
        from/to, today in the location's timezone; at most 90 days."""
        query = {
            "from": _time(from_) if from_ not in (None, "") else None,
            "to": _time(to) if to not in (None, "") else None,
            "location": location,
            "service": service,
        }
        return self._send(_Call("GET", _with_query("/analytics", query), timeout=timeout))

    def set_service_status(self, service: str, body: Body, *, timeout: Optional[float] = None):
        """POST /services/{service}/status `{status: PAUSED|ACTIVE, reason?, message?}` ->
        `{queueId, status, changed, service, location, refs}`."""
        return self._send(_Call("POST", f"/services/{_seg(service)}/status", body, timeout=timeout))


class _ClientBase(_Endpoints):
    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = 2,
        retry_backoff: float = 0.5,
        user_agent: Optional[str] = DEFAULT_USER_AGENT,
        on_response: Optional[ResponseHook] = None,
    ):
        base = str(base_url or "").strip().rstrip("/")
        if not base.startswith(("https://", "http://")):
            raise ValueError("base_url must be the workspace URL, starting with https://")
        key = str(api_key or "").strip()
        if not key:
            raise ValueError("api_key is required")
        self.base_url = base
        self.api_key = key
        self.timeout = timeout
        self.max_retries = max(0, int(max_retries))
        self.retry_backoff = retry_backoff
        self.user_agent = user_agent
        self.on_response = on_response

    @property
    def connect_url(self) -> str:
        return f"{self.base_url}{CONNECT_PATH}"

    def _url(self, call: _Call) -> str:
        return f"{self.connect_url}{call.path}"

    def _headers(self, call: _Call) -> Dict[str, str]:
        headers = {"Authorization": f"Bearer {self.api_key}", "Accept": "application/json"}
        if self.user_agent:
            headers["User-Agent"] = self.user_agent
        headers.update(call.headers)
        return headers

    def _timeout(self, call: _Call) -> float:
        return call.timeout or self.timeout

    def _observe(self, call: _Call, response: httpx.Response, started: float) -> None:
        if self.on_response is not None:
            self.on_response(call.method, call.path, response.status_code, time.monotonic() - started)

    @staticmethod
    def _payload(response: httpx.Response) -> Any:
        try:
            return response.json()
        except ValueError:
            return None

    def _retry_response(self, call: _Call, response: httpx.Response, attempt: int) -> bool:
        if attempt >= self.max_retries:
            return False
        status = response.status_code
        if status == 429:
            return True
        if not call.retry_safe:
            return False
        if status in RETRY_STATUSES:
            return True
        if status == 409:
            payload = self._payload(response)
            return isinstance(payload, dict) and payload.get("code") == ErrorCode.IDEMPOTENCY_IN_PROGRESS
        return False

    def _retry_error(self, call: _Call, attempt: int) -> bool:
        return attempt < self.max_retries and call.retry_safe

    def _delay(self, attempt: int, response: Optional[httpx.Response] = None) -> float:
        if response is not None:
            after = response.headers.get("retry-after")
            try:
                if after is not None:
                    return min(max(float(after), 0.0), MAX_RETRY_DELAY)
            except ValueError:
                pass
        return min(self.retry_backoff * (2 ** attempt), MAX_RETRY_DELAY)

    @staticmethod
    def _transport_error(call: _Call, exc: httpx.RequestError) -> ConnectTransportError:
        if isinstance(exc, httpx.TimeoutException):
            return ConnectTimeoutError("No response from Klargy (the request timed out)",
                                       method=call.method, path=call.path)
        return ConnectTransportError(f"Couldn't connect to Klargy: {exc}", method=call.method, path=call.path)

    def _result(self, call: _Call, response: httpx.Response) -> ConnectResponse:
        payload = self._payload(response)
        status = response.status_code
        if status >= 400:
            message = payload.get("error") if isinstance(payload, dict) else None
            if not isinstance(message, str) or not message:
                message = response.text[:200] or response.reason_phrase or f"HTTP {status}"
            code = payload.get("code") if isinstance(payload, dict) else None
            raise error_class_for(status)(
                message,
                status=status,
                code=code if isinstance(code, str) else None,
                body=payload,
                text=response.text,
                reason_phrase=response.reason_phrase,
                method=call.method,
                path=call.path,
                headers=response.headers,
            )
        if not isinstance(payload, dict):
            raise InvalidResponseError(f"Klargy {call.path} returned a non-JSON response", status=status,
                                       text=response.text, method=call.method, path=call.path)
        return ConnectResponse(payload, status, response.headers)


class KlargyConnect(_ClientBase):
    """Async client.

        async with KlargyConnect("https://acme.klargy.com", "klg_live_...") as klargy:
            me = await klargy.me()

    `transport` (an httpx.AsyncBaseTransport, e.g. httpx.MockTransport in tests) or `http_client` (an
    httpx.AsyncClient you own) replace the default connection handling.
    """

    def __init__(self, base_url: str, api_key: str, *, transport: Optional[httpx.AsyncBaseTransport] = None,
                 http_client: Optional[httpx.AsyncClient] = None, **options: Any):
        super().__init__(base_url, api_key, **options)
        self._transport = transport
        self._external = http_client
        self._owned: Optional[httpx.AsyncClient] = None
        self._sleep = asyncio.sleep

    def _client(self) -> httpx.AsyncClient:
        if self._external is not None:
            return self._external
        if self._owned is None:
            self._owned = httpx.AsyncClient(timeout=self.timeout, transport=self._transport)
        return self._owned

    async def aclose(self) -> None:
        if self._owned is not None:
            await self._owned.aclose()
            self._owned = None

    async def __aenter__(self) -> "KlargyConnect":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()

    async def _send(self, call: _Call) -> ConnectResponse:
        attempt = 0
        while True:
            started = time.monotonic()
            try:
                response = await self._client().request(
                    call.method, self._url(call), headers=self._headers(call), json=call.body,
                    timeout=self._timeout(call),
                )
            except httpx.RequestError as exc:
                if self._retry_error(call, attempt):
                    await self._sleep(self._delay(attempt))
                    attempt += 1
                    continue
                raise self._transport_error(call, exc) from exc
            self._observe(call, response, started)
            if self._retry_response(call, response, attempt):
                await self._sleep(self._delay(attempt, response))
                attempt += 1
                continue
            return self._result(call, response)

    async def iter_entries(self, updated_since: TimeValue, *, visit: Optional[str] = None,
                           timeout: Optional[float] = None) -> AsyncIterator[Dict[str, Any]]:
        """Every entry changed after `updated_since`, paging `GET /entries` until a page is empty.
        The same entry can come twice if it changed again in between."""
        since = _time(updated_since)
        while True:
            page = await self.list_entries(since, visit=visit, timeout=timeout)
            entries = page.get("entries") or []
            if not entries:
                return
            for entry in entries:
                yield entry
            following = page.get("nextUpdatedSince")
            if not following or following == since:
                return
            since = following


class KlargyConnectSync(_ClientBase):
    """The same API as `KlargyConnect`, blocking (httpx.Client)."""

    def __init__(self, base_url: str, api_key: str, *, transport: Optional[httpx.BaseTransport] = None,
                 http_client: Optional[httpx.Client] = None, **options: Any):
        super().__init__(base_url, api_key, **options)
        self._transport = transport
        self._external = http_client
        self._owned: Optional[httpx.Client] = None
        self._sleep = time.sleep

    def _client(self) -> httpx.Client:
        if self._external is not None:
            return self._external
        if self._owned is None:
            self._owned = httpx.Client(timeout=self.timeout, transport=self._transport)
        return self._owned

    def close(self) -> None:
        if self._owned is not None:
            self._owned.close()
            self._owned = None

    def __enter__(self) -> "KlargyConnectSync":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def _send(self, call: _Call) -> ConnectResponse:
        attempt = 0
        while True:
            started = time.monotonic()
            try:
                response = self._client().request(
                    call.method, self._url(call), headers=self._headers(call), json=call.body,
                    timeout=self._timeout(call),
                )
            except httpx.RequestError as exc:
                if self._retry_error(call, attempt):
                    self._sleep(self._delay(attempt))
                    attempt += 1
                    continue
                raise self._transport_error(call, exc) from exc
            self._observe(call, response, started)
            if self._retry_response(call, response, attempt):
                self._sleep(self._delay(attempt, response))
                attempt += 1
                continue
            return self._result(call, response)

    def iter_entries(self, updated_since: TimeValue, *, visit: Optional[str] = None,
                     timeout: Optional[float] = None) -> Iterator[Dict[str, Any]]:
        """Every entry changed after `updated_since`, paging `GET /entries` until a page is empty."""
        since = _time(updated_since)
        while True:
            page = self.list_entries(since, visit=visit, timeout=timeout)
            entries = page.get("entries") or []
            if not entries:
                return
            yield from entries
            following = page.get("nextUpdatedSince")
            if not following or following == since:
                return
            since = following


__all__ = [
    "ConnectError",
    "ConnectResponse",
    "KlargyConnect",
    "KlargyConnectSync",
    "new_idempotency_key",
]
