import hashlib
import hmac
import json
import time

import pytest

from klargy_connect import (
    WebhookVerificationError,
    construct_event,
    parse_webhook,
    sign_payload,
    signature_headers,
    verify_webhook,
)

SECRET = "whsec_test"
RAW = json.dumps({
    "id": "d1",
    "event": "entry.called",
    "createdAt": "2026-10-14T13:05:00.000Z",
    "data": {
        "entryId": "e1", "ticketNumber": "G012", "status": "SERVING",
        "origin": {"type": "integration", "integrationId": "int_1"},
        "refs": {"patient": "p1", "visit": "v1"},
    },
}).encode()


def test_signature_matches_the_server_scheme():
    # webhooks.service.ts: createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
    expected = hmac.new(SECRET.encode(), b"1791927099." + RAW, hashlib.sha256).hexdigest()
    assert sign_payload(SECRET, "1791927099", RAW) == expected
    assert sign_payload(SECRET, 1791927099, RAW.decode()) == expected


def test_valid_delivery_passes_with_any_header_case():
    headers = signature_headers(SECRET, RAW, event="entry.called", delivery_id="d1")
    verify_webhook(SECRET, headers, RAW)
    verify_webhook(SECRET, {k.lower(): v for k, v in headers.items()}, RAW)
    verify_webhook(SECRET, {k.upper(): [v] for k, v in headers.items()}, RAW)


@pytest.mark.parametrize(
    "mutate, code, message",
    [
        (lambda h: h.pop("X-Webhook-Signature"), "SIGNATURE_MISSING",
         "X-Webhook-Signature and X-Webhook-Timestamp are required"),
        (lambda h: h.pop("X-Webhook-Timestamp"), "SIGNATURE_MISSING",
         "X-Webhook-Signature and X-Webhook-Timestamp are required"),
        (lambda h: h.update({"X-Webhook-Timestamp": "soon"}), "TIMESTAMP_INVALID",
         "X-Webhook-Timestamp must be unix seconds"),
        (lambda h: h.update({"X-Webhook-Signature": "sha256=00"}), "SIGNATURE_INVALID", "Invalid webhook signature"),
        (lambda h: h.update({"X-Webhook-Signature": h["X-Webhook-Signature"][7:]}), "SIGNATURE_INVALID",
         "Invalid webhook signature"),
    ],
)
def test_refusals(mutate, code, message):
    headers = signature_headers(SECRET, RAW)
    mutate(headers)
    with pytest.raises(WebhookVerificationError) as info:
        verify_webhook(SECRET, headers, RAW)
    assert info.value.code == code and info.value.message == message


def test_tampered_body_or_wrong_secret_fails():
    headers = signature_headers(SECRET, RAW)
    with pytest.raises(WebhookVerificationError):
        verify_webhook(SECRET, headers, RAW + b" ")
    with pytest.raises(WebhookVerificationError):
        verify_webhook("whsec_other", headers, RAW)


def test_missing_secret():
    with pytest.raises(WebhookVerificationError) as info:
        verify_webhook("", signature_headers(SECRET, RAW), RAW)
    assert info.value.code == "SECRET_MISSING"


def test_five_minute_window():
    now = int(time.time())
    for offset in (-300, 300):
        verify_webhook(SECRET, signature_headers(SECRET, RAW, timestamp=now + offset), RAW, now=now)
    for offset in (-301, 301):
        with pytest.raises(WebhookVerificationError) as info:
            verify_webhook(SECRET, signature_headers(SECRET, RAW, timestamp=now + offset), RAW, now=now)
        assert info.value.code == "TIMESTAMP_STALE"
        assert info.value.message == "X-Webhook-Timestamp is more than 5 minutes from the server clock"
    with pytest.raises(WebhookVerificationError) as info:
        verify_webhook(SECRET, signature_headers(SECRET, RAW, timestamp=now - 61), RAW, now=now, tolerance_seconds=60)
    assert "60 seconds" in info.value.message


def test_parse_and_construct_event():
    headers = signature_headers(SECRET, RAW, event="entry.called", delivery_id="d1")
    event = construct_event(SECRET, headers, RAW)
    assert (event.id, event.event, event.created_at) == ("d1", "entry.called", "2026-10-14T13:05:00.000Z")
    assert event.refs == {"patient": "p1", "visit": "v1"}
    assert event.data["ticketNumber"] == "G012"
    assert event.is_own("int_1") and not event.is_own("int_2") and not event.is_own(None)
    # Without headers the body's id and event are used.
    assert parse_webhook(RAW).id == "d1"


def test_parse_refuses_non_deliveries():
    with pytest.raises(ValueError):
        parse_webhook(b"[]")
    with pytest.raises(ValueError):
        parse_webhook(b'{"data": {}}')
    with pytest.raises(ValueError):
        parse_webhook(b"not json")
