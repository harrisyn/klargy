# klargy-connect (Python)

Python SDK for **Klargy Connect v1**, the API an EMR (or any system that sends
people into a queue) uses to work with Klargy. The contract is
[`docs/connect/v1.md`](../../../docs/connect/v1.md); this package covers all of it:

- `KlargyConnect` (async, httpx) and `KlargyConnectSync`: one method per endpoint,
  typed errors, `Idempotency-Key` support and safe retries
- `verify_webhook` / `construct_event`: check `X-Webhook-*` signatures
- `verify_lookup_request` and answer helpers for the patient lookup
- desk `postMessage` protocol constants and parsers

Python 3.9 or later; the only dependency is `httpx`. Not published to PyPI yet:
install it from this folder (`pip install ./sdks/python/klargy-connect`) or vendor
`src/klargy_connect` (its imports are all relative).

## Quick start

```python
from klargy_connect import KlargyConnect, ConflictError, ErrorCode, new_idempotency_key

async with KlargyConnect("https://acme.klargy.com", "klg_live_...") as klargy:
    me = await klargy.me()                      # "Test connection"

    reg = await klargy.register_integration({   # on every save of your settings
        "system": {"name": "Acme EMR", "version": "3.1"},
        "webhookUrl": "https://emr.example.com/hooks/klargy",
        "lookupUrl": "https://emr.example.com/klargy/lookup",
        "embedOrigins": ["https://emr.example.com"],
    })
    store_secret(reg["signingSecret"])          # verifies webhooks and lookups

    await klargy.put_catalog({"locations": [...], "services": [...], "practitioners": [...]})

    # Issue a ticket for a visit. Keep the key with the operation and reuse it on retries.
    try:
        reply = await klargy.create_entry(
            {"refs": {"patient": "p-123", "visit": "v-456"},
             "patient": {"firstName": "Ama", "lastName": "Mensah", "phone": "+233..."},
             "service": "clinic-gp"},
            idempotency_key="visit:v-456:clinic-gp",
        )
        print(reply["entry"]["ticketNumber"], reply.created, reply.replayed)
    except ConflictError as err:
        if err.code == ErrorCode.ALREADY_IN_QUEUE:
            print("already queued:", err.entry["ticketNumber"])
        else:
            raise

    # Move it from the EMR side
    await klargy.call_entry("visit", "v-456", {"servicePoint": "room-3", "staff": "dr-1"},
                            idempotency_key=new_idempotency_key())
    await klargy.transfer_entry("visit", "v-456", {"to": "lab", "reason": "Lab orders"},
                                idempotency_key=new_idempotency_key())
```

`KlargyConnectSync` has the same methods without `await`.

### Methods

| Method | Call |
|---|---|
| `me()` | `GET /me` |
| `register_integration(body)` | `PUT /integration` |
| `put_catalog(body)` / `get_catalog()` | `PUT` / `GET /catalog` |
| `get_mappings(resource_type=None)` | `GET /mappings[?resourceType=]` |
| `upsert_patient(patient_id, body)` | `PUT /patients/{id}` |
| `create_entry(body, idempotency_key=)` | `POST /entries` |
| `entry_action(ref_type, ref_id, action, body, idempotency_key=)` | `POST /entries/by-ref/{type}/{id}/{action}` |
| `call_entry`, `complete_entry`, `cancel_entry`, `no_show_entry`, `hold_entry`, `resume_entry`, `clear_entry`, `transfer_entry`, `set_entry_priority` | the same, one per action |
| `link_serving_entry(body, idempotency_key=)` | `POST /entries/serving/link` |
| `get_entry_by_ref(ref_type, ref_id, service=None)` | `GET /entries/by-ref/{type}/{id}[?service=]` |
| `list_entries(updated_since, visit=None)` / `iter_entries(...)` | `GET /entries` (one page / every page) |
| `launch_desk(body)` | `POST /desk/launch` |
| `get_staff_desk(staff_ref)` | `GET /staff/{staffRef}/desk` |
| `upsert_appointment(appointment_ref, body)` | `PUT /appointments/{ref}` |
| `get_analytics(from_=, to=, location=, service=)` | `GET /analytics` |
| `set_service_status(service, body)` | `POST /services/{service}/status` |

Bodies are the contract's JSON exactly as in v1.md (camelCase keys), sent as
given; `klargy_connect.types` has TypedDicts for them. Each method returns a
`ConnectResponse`: the decoded JSON object (a `dict`) with `status_code`,
`headers`, `created` (HTTP 201) and `replayed` (`Idempotent-Replayed: true`).
Every method takes `timeout=` to override the client's (default 20 seconds).

Client options: `timeout`, `max_retries` (default 2), `retry_backoff`,
`user_agent` (`None` leaves httpx's), `on_response(method, path, status,
seconds)` for logging, and `transport` (any httpx transport, e.g.
`httpx.MockTransport` in tests) or `http_client` (an httpx client you own).

**Retries** only happen when repeating can't do anything twice: `GET` and `PUT`,
`POST` with an `Idempotency-Key`, and 429 for any call. They cover connection
errors, timeouts, 429, 502, 503, 504 and `409 IDEMPOTENCY_IN_PROGRESS`, and
honour `Retry-After`. Set `max_retries=0` to turn them off.

### Errors

| Raised | When |
|---|---|
| `BadRequestError` (400), `AuthenticationError` (401), `PermissionDeniedError` (403), `NotFoundError` (404), `ConflictError` (409), `UnprocessableEntityError` (422), `RateLimitError` (429), `ServerError` (5xx) | Klargy refused; all are `ConnectError` with `status`, `code` (see `ErrorCode`), `message`, `body`, `details`, and `entry` / `entry_status` for `ALREADY_IN_QUEUE` / `INVALID_TRANSITION` |
| `ConnectTimeoutError`, `ConnectTransportError` | no answer (the httpx error is `__cause__`) |
| `InvalidResponseError` | a 2xx that is not a JSON object |

Everything derives from `KlargyConnectError`.

## Webhooks

```python
from klargy_connect import construct_event, WebhookVerificationError

@app.post("/hooks/klargy")
async def klargy_webhook(request: Request):
    raw = await request.body()                  # the exact raw bytes
    try:
        event = construct_event(secret, request.headers, raw)   # signature + 5-minute window
    except WebhookVerificationError as err:
        return Response(status_code=401, content=err.message)
    if seen_before(event.id):                   # X-Webhook-Id; a retry reuses it
        return {"ok": True}
    if event.is_own(my_integration_id):         # echo of your own Connect call
        return {"ok": True}
    handle(event.event, event.data, event.refs)
    return {"ok": True}
```

`verify_webhook(secret, headers, raw_body, tolerance_seconds=300, now=None)`
only verifies; `parse_webhook(raw_body, headers)` only parses. Refusals carry a
`code`: `SECRET_MISSING`, `SIGNATURE_MISSING`, `TIMESTAMP_INVALID`,
`TIMESTAMP_STALE`, `SIGNATURE_INVALID` (and `EVENT_MISMATCH` for lookups).
`sign_payload` and `signature_headers` produce what Klargy sends, for tests.

## Patient lookup

```python
from klargy_connect import (verify_lookup_request, lookup_match, lookup_candidates, lookup_no_match,
                            lookup_patient, lookup_cover, lookup_response, mask_phone, LookupRequestError)

@app.post("/klargy/lookup")
async def klargy_lookup(request: Request):
    raw = await request.body()
    try:
        lookup = verify_lookup_request(secret, request.headers, raw)  # also checks X-Webhook-Event
    except WebhookVerificationError:
        return Response(status_code=401)
    except LookupRequestError as err:
        return Response(status_code=400, content=str(err))
    found = search(lookup.identifier_type, lookup.identifier, lookup.location_ref)
    if not found:
        answer = lookup_no_match()
    else:
        answer = lookup_match(lookup_patient(
            found.id, found.name, first_name=found.first_name, mr_number=found.mrn,
            phone_masked=mask_phone(found.phone),
            cover=lookup_cover("Acme Health", status="active", expires_on="2027-01-31", checked_via="payer"),
        ))
    return lookup_response(lookup, answer)      # public lookups get only matched + firstName
```

Klargy waits 5 seconds and never retries inside someone's request; a failed
cover check is `status="unknown"` with a `message`, never an error.

## The desk

The desk runs in the browser; embed it with the TypeScript package
(`@klargy/connect/desk`). Your server calls `launch_desk(...)` and hands the
single-use `url` to the page. `klargy_connect.desk` has the v1 message names,
`parse_desk_message`, `origin_of` / `is_desk_origin` and `logout_message` for
backends and tests that relay desk messages.

## Development

```bash
python -m venv .venv && .venv/bin/pip install -e '.[test]'
.venv/bin/python -m pytest
```
