import asyncio
import json
from datetime import datetime, timezone

import httpx
import pytest

from klargy_connect import (
    AuthenticationError,
    BadRequestError,
    ConflictError,
    ConnectError,
    ConnectTimeoutError,
    ConnectTransportError,
    ErrorCode,
    InvalidResponseError,
    KlargyConnect,
    KlargyConnectSync,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
    ServerError,
    UnprocessableEntityError,
    new_idempotency_key,
)

BASE = "https://acme.klargy.test"
KEY = "klg_live_abc"
ENTRY = {"entryId": "e1", "ticketNumber": "G012", "status": "WAITING", "position": 2}


def run(coro):
    return asyncio.run(coro)


def make(handler, *, sync=False, **options):
    calls = []

    def record(request: httpx.Request):
        calls.append(request)
        return handler(request)

    options.setdefault("max_retries", 0)
    if sync:
        client = KlargyConnectSync(BASE + "/", KEY, transport=httpx.MockTransport(record), **options)
    else:
        client = KlargyConnect(BASE + "/", KEY, transport=httpx.MockTransport(record), **options)
    client._sleep = (lambda s: None) if sync else _no_sleep
    return client, calls


async def _no_sleep(_seconds):
    return None


def body(request):
    return json.loads(request.content) if request.content else None


def ok(payload, status=200, headers=None):
    return lambda request: httpx.Response(status, json=payload, headers=headers)


# --- construction ---------------------------------------------------------------------------------


def test_requires_url_and_key():
    with pytest.raises(ValueError):
        KlargyConnect("acme.klargy.test", KEY)
    with pytest.raises(ValueError):
        KlargyConnect(BASE, " ")
    assert KlargyConnect(BASE + "//", KEY).connect_url == BASE + "/api/v1/connect/v1"


# --- every endpoint: method, path, body, headers -------------------------------------------------


def test_me_sends_bearer_key_and_user_agent():
    client, calls = make(ok({"contract": "klargy-connect/v1"}))
    me = run(client.me())
    assert me["contract"] == "klargy-connect/v1" and me.status_code == 200
    req = calls[0]
    assert req.method == "GET" and str(req.url) == f"{BASE}/api/v1/connect/v1/me"
    assert req.headers["Authorization"] == f"Bearer {KEY}"
    assert req.headers["Accept"] == "application/json"
    assert req.headers["User-Agent"].startswith("klargy-connect-python/")
    assert req.content == b""


def test_user_agent_can_be_left_to_httpx():
    client, calls = make(ok({}), user_agent=None)
    run(client.me())
    assert calls[0].headers["User-Agent"].startswith("python-httpx/")


@pytest.mark.parametrize(
    "invoke, method, path, sent",
    [
        (lambda c: c.register_integration({"webhookUrl": "https://emr/x"}), "PUT", "/integration",
         {"webhookUrl": "https://emr/x"}),
        (lambda c: c.put_catalog({"locations": []}), "PUT", "/catalog", {"locations": []}),
        (lambda c: c.get_catalog(), "GET", "/catalog", None),
        (lambda c: c.get_mappings(), "GET", "/mappings", None),
        (lambda c: c.get_mappings("patient"), "GET", "/mappings?resourceType=patient", None),
        (lambda c: c.upsert_patient("p/1", {"firstName": "Ama", "lastName": "Mensah"}), "PUT", "/patients/p%2F1",
         {"firstName": "Ama", "lastName": "Mensah"}),
        (lambda c: c.create_entry({"service": "s1"}), "POST", "/entries", {"service": "s1"}),
        (lambda c: c.entry_action("visit", "v1", "call", {"servicePoint": "r3"}), "POST",
         "/entries/by-ref/visit/v1/call", {"servicePoint": "r3"}),
        (lambda c: c.call_entry("encounter", "enc 1"), "POST", "/entries/by-ref/encounter/enc%201/call", {}),
        (lambda c: c.complete_entry("visit", "v1", {"service": "lab"}), "POST", "/entries/by-ref/visit/v1/complete",
         {"service": "lab"}),
        (lambda c: c.cancel_entry("entry", "e1", {"reason": "left"}), "POST", "/entries/by-ref/entry/e1/cancel",
         {"reason": "left"}),
        (lambda c: c.no_show_entry("visit", "v1"), "POST", "/entries/by-ref/visit/v1/no-show", {}),
        (lambda c: c.hold_entry("visit", "v1"), "POST", "/entries/by-ref/visit/v1/hold", {}),
        (lambda c: c.resume_entry("visit", "v1", {"staff": "pr1"}), "POST", "/entries/by-ref/visit/v1/resume",
         {"staff": "pr1"}),
        (lambda c: c.clear_entry("encounter", "enc1"), "POST", "/entries/by-ref/encounter/enc1/clear", {}),
        (lambda c: c.entry_action("visit", "v1", "clear"), "POST", "/entries/by-ref/visit/v1/clear", {}),
        (lambda c: c.link_serving_entry({"staff": "pr2", "refs": {"patient": "p1", "visit": "v1"}}), "POST",
         "/entries/serving/link", {"staff": "pr2", "refs": {"patient": "p1", "visit": "v1"}}),
        (lambda c: c.create_entry({"service": "s1", "cleared": True}), "POST", "/entries",
         {"service": "s1", "cleared": True}),
        (lambda c: c.transfer_entry("visit", "v1", {"to": "cons", "cleared": True}), "POST",
         "/entries/by-ref/visit/v1/transfer", {"to": "cons", "cleared": True}),
        (lambda c: c.transfer_entry("visit", "v1", {"to": "lab", "priority": 50}), "POST",
         "/entries/by-ref/visit/v1/transfer", {"to": "lab", "priority": 50}),
        (lambda c: c.set_entry_priority("visit", "v1", {"priority": 70}), "POST", "/entries/by-ref/visit/v1/priority",
         {"priority": 70}),
        (lambda c: c.get_entry_by_ref("visit", "v1"), "GET", "/entries/by-ref/visit/v1", None),
        (lambda c: c.get_entry_by_ref("visit", "v1", service="lab"), "GET", "/entries/by-ref/visit/v1?service=lab",
         None),
        (lambda c: c.list_entries("2026-10-14T00:00:00.000Z", visit="v1"), "GET",
         "/entries?updatedSince=2026-10-14T00%3A00%3A00.000Z&visit=v1", None),
        (lambda c: c.launch_desk({"staff": {"id": "d1", "name": "Ama"}, "returnOrigin": "https://emr"}), "POST",
         "/desk/launch", {"staff": {"id": "d1", "name": "Ama"}, "returnOrigin": "https://emr"}),
        (lambda c: c.get_staff_desk("DR 1"), "GET", "/staff/DR%201/desk", None),
        (lambda c: c.upsert_appointment("a1", {"service": "s1"}), "PUT", "/appointments/a1", {"service": "s1"}),
        (lambda c: c.get_analytics(), "GET", "/analytics", None),
        (lambda c: c.get_analytics(from_="2026-10-01T00:00:00Z", to="2026-10-02T00:00:00Z", location="l1",
                                   service="s1"), "GET",
         "/analytics?from=2026-10-01T00%3A00%3A00Z&to=2026-10-02T00%3A00%3A00Z&location=l1&service=s1", None),
        (lambda c: c.set_service_status("s 1", {"status": "PAUSED"}), "POST", "/services/s%201/status",
         {"status": "PAUSED"}),
    ],
)
def test_endpoints(invoke, method, path, sent):
    client, calls = make(ok({"ok": True}))
    reply = run(invoke(client))
    assert reply == {"ok": True}
    req = calls[0]
    assert req.method == method
    assert str(req.url) == f"{BASE}/api/v1/connect/v1{path}"
    assert body(req) == sent


def test_sync_client_has_the_same_endpoints():
    client, calls = make(ok({"entry": ENTRY}, status=201), sync=True)
    reply = client.create_entry({"service": "s1"}, idempotency_key="k1")
    assert reply.created and reply["entry"]["ticketNumber"] == "G012"
    assert calls[0].headers["Idempotency-Key"] == "k1"
    with client:
        pass


def test_times_accept_datetimes():
    client, calls = make(ok({"entries": [], "nextUpdatedSince": "x"}))
    run(client.list_entries(datetime(2026, 10, 14, 13, 5, tzinfo=timezone.utc)))
    assert calls[0].url.params["updatedSince"] == "2026-10-14T13:05:00Z"


def test_invalid_arguments_are_refused_before_sending():
    client, calls = make(ok({}))
    with pytest.raises(ValueError):
        run(client.entry_action("patient", "p1", "call"))
    with pytest.raises(ValueError):
        run(client.entry_action("visit", "v1", "serve"))
    with pytest.raises(ValueError):
        run(client.get_entry_by_ref("visit", ""))
    with pytest.raises(ValueError):
        run(client.get_mappings("ward"))
    assert calls == []


# --- responses ------------------------------------------------------------------------------------


def test_created_and_replayed():
    client, _ = make(ok({"entry": ENTRY}, status=201, headers={"Idempotent-Replayed": "true"}))
    reply = run(client.create_entry({}, idempotency_key=new_idempotency_key()))
    assert reply.created and reply.replayed
    client, _ = make(ok({"entry": ENTRY}))
    reply = run(client.create_entry({}))
    assert not reply.created and not reply.replayed


def test_idempotency_key_only_when_given():
    client, calls = make(ok({"entry": ENTRY}))
    run(client.create_entry({}))
    run(client.call_entry("visit", "v1", idempotency_key="abc"))
    assert "Idempotency-Key" not in calls[0].headers
    assert calls[1].headers["Idempotency-Key"] == "abc"


def test_non_json_success_is_invalid_response():
    client, _ = make(lambda r: httpx.Response(200, text="<html>"))
    with pytest.raises(InvalidResponseError) as info:
        run(client.me())
    assert str(info.value) == "Klargy /me returned a non-JSON response"


@pytest.mark.parametrize(
    "status, cls",
    [(400, BadRequestError), (401, AuthenticationError), (403, PermissionDeniedError), (404, NotFoundError),
     (409, ConflictError), (422, UnprocessableEntityError), (429, RateLimitError), (500, ServerError),
     (418, ConnectError)],
)
def test_errors_are_typed_by_status(status, cls):
    client, _ = make(ok({"error": "nope"}, status=status))
    with pytest.raises(cls) as info:
        run(client.me())
    assert info.value.status == status and info.value.message == "nope" and info.value.code is None


def test_error_carries_code_and_extra_fields():
    entry = dict(ENTRY)
    client, _ = make(ok({"error": "Already queued", "code": "ALREADY_IN_QUEUE", "entry": entry}, status=409))
    with pytest.raises(ConflictError) as info:
        run(client.create_entry({"service": "s1"}))
    err = info.value
    assert err.code == ErrorCode.ALREADY_IN_QUEUE and err.entry == entry
    assert err.method == "POST" and err.path == "/entries"
    assert err.details == {"entry": entry}

    client, _ = make(ok({"error": "x", "code": "INVALID_TRANSITION", "status": "CANCELLED"}, status=409))
    with pytest.raises(ConflictError) as info:
        run(client.complete_entry("visit", "v1"))
    assert info.value.entry_status == "CANCELLED"

    client, _ = make(ok({"error": "limit", "code": "LIMIT_REACHED", "limitType": "users", "current": 5, "limit": 5},
                        status=403))
    with pytest.raises(PermissionDeniedError) as info:
        run(client.launch_desk({}))
    assert info.value.details == {"limitType": "users", "current": 5, "limit": 5}


def test_error_without_json_uses_the_text():
    client, _ = make(lambda r: httpx.Response(502, text="Bad gateway from proxy"))
    with pytest.raises(ServerError) as info:
        run(client.me())
    assert info.value.message == "Bad gateway from proxy" and info.value.body is None
    assert info.value.reason_phrase == "Bad Gateway"


def test_transport_errors():
    def boom(request):
        raise httpx.ConnectError("refused", request=request)

    def slow(request):
        raise httpx.ReadTimeout("slow", request=request)

    client, _ = make(boom)
    with pytest.raises(ConnectTransportError) as info:
        run(client.me())
    assert str(info.value) == "Couldn't connect to Klargy: refused"
    assert isinstance(info.value.__cause__, httpx.ConnectError)
    client, _ = make(slow)
    with pytest.raises(ConnectTimeoutError) as info:
        run(client.me())
    assert str(info.value) == "No response from Klargy (the request timed out)"


def test_timeout_override_reaches_httpx():
    seen = []

    def handler(request):
        seen.append(request.extensions["timeout"])
        return httpx.Response(200, json={})

    client, _ = make(handler, timeout=20.0)
    run(client.me())
    run(client.get_entry_by_ref("visit", "v1", timeout=5))
    assert seen[0]["read"] == 20.0 and seen[1]["read"] == 5


def test_on_response_hook():
    seen = []
    client, _ = make(ok({}), on_response=lambda m, p, s, t: seen.append((m, p, s, t >= 0)))
    run(client.get_mappings("service"))
    assert seen == [("GET", "/mappings?resourceType=service", 200, True)]


# --- retries --------------------------------------------------------------------------------------


def sequence(*responses):
    items = list(responses)

    def handler(request):
        item = items.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    return handler


def test_get_retries_on_503_and_connection_errors():
    client, calls = make(sequence(httpx.Response(503), httpx.ConnectError("x"), httpx.Response(200, json={"a": 1})),
                         max_retries=2)
    assert run(client.me()) == {"a": 1}
    assert len(calls) == 3


def test_retries_stop_at_max():
    client, calls = make(sequence(httpx.Response(503), httpx.Response(503)), max_retries=1)
    with pytest.raises(ServerError):
        run(client.me())
    assert len(calls) == 2


def test_post_without_idempotency_key_is_not_retried():
    client, calls = make(sequence(httpx.Response(503), httpx.Response(201, json={})), max_retries=2)
    with pytest.raises(ServerError):
        run(client.create_entry({}))
    client, calls = make(sequence(httpx.ReadTimeout("slow"), httpx.Response(201, json={})), max_retries=2)
    with pytest.raises(ConnectTimeoutError):
        run(client.launch_desk({}))
    assert len(calls) == 1


def test_post_with_idempotency_key_is_retried_with_the_same_key():
    in_progress = httpx.Response(409, json={"error": "busy", "code": "IDEMPOTENCY_IN_PROGRESS"})
    client, calls = make(sequence(httpx.ReadTimeout("slow"), in_progress, httpx.Response(201, json={"entry": ENTRY})),
                         max_retries=3)
    reply = run(client.create_entry({"service": "s1"}, idempotency_key="k1"))
    assert reply.created and len(calls) == 3
    assert {c.headers["Idempotency-Key"] for c in calls} == {"k1"}


def test_other_conflicts_are_not_retried():
    client, calls = make(sequence(httpx.Response(409, json={"error": "closed", "code": "QUEUE_CLOSED"})), max_retries=3)
    with pytest.raises(ConflictError):
        run(client.create_entry({}, idempotency_key="k"))
    assert len(calls) == 1


def test_rate_limit_is_retried_for_any_call_honouring_retry_after():
    waits = []

    async def sleep(seconds):
        waits.append(seconds)

    client, calls = make(sequence(httpx.Response(429, headers={"Retry-After": "2"}), httpx.Response(200, json={})),
                         max_retries=1)
    client._sleep = sleep
    run(client.launch_desk({}))
    assert len(calls) == 2 and waits == [2.0]


def test_backoff_grows():
    client = KlargyConnect(BASE, KEY, retry_backoff=0.5)
    assert [client._delay(n) for n in range(3)] == [0.5, 1.0, 2.0]
    assert client._delay(20) == 30.0


# --- paging ---------------------------------------------------------------------------------------


def test_iter_entries_pages_until_empty():
    pages = [
        {"entries": [{"entryId": "a"}, {"entryId": "b"}], "nextUpdatedSince": "t2"},
        {"entries": [{"entryId": "c"}], "nextUpdatedSince": "t3"},
        {"entries": [], "nextUpdatedSince": "t3"},
    ]
    client, calls = make(lambda r: httpx.Response(200, json=pages.pop(0)))

    async def collect():
        return [e["entryId"] async for e in client.iter_entries("t1", visit="v1")]

    assert run(collect()) == ["a", "b", "c"]
    assert [c.url.params["updatedSince"] for c in calls] == ["t1", "t2", "t3"]
    assert all(c.url.params["visit"] == "v1" for c in calls)


def test_sync_iter_entries():
    pages = [{"entries": [{"entryId": "a"}], "nextUpdatedSince": "t2"}, {"entries": [], "nextUpdatedSince": "t2"}]
    client, _ = make(lambda r: httpx.Response(200, json=pages.pop(0)), sync=True)
    assert [e["entryId"] for e in client.iter_entries("t1")] == ["a"]


def test_owned_client_is_reused_and_closed():
    client, calls = make(ok({}))

    async def go():
        async with client:
            await client.me()
            first = client._owned
            await client.me()
            assert client._owned is first
        assert client._owned is None

    run(go())
    assert len(calls) == 2


def test_external_http_client_is_used():
    seen = []
    transport = httpx.MockTransport(lambda r: seen.append(r) or httpx.Response(200, json={}))

    async def go():
        async with httpx.AsyncClient(transport=transport) as http:
            client = KlargyConnect(BASE, KEY, http_client=http)
            await client.me()
            await client.aclose()
            assert not http.is_closed

    run(go())
    assert len(seen) == 1
