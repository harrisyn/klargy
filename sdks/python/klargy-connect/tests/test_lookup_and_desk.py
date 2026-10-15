import json

import pytest

from klargy_connect import (
    LookupRequestError,
    WebhookVerificationError,
    is_desk_origin,
    logout_message,
    lookup_candidate,
    lookup_candidates,
    lookup_cover,
    lookup_match,
    lookup_no_match,
    lookup_patient,
    lookup_response,
    mask_phone,
    origin_of,
    parse_desk_message,
    parse_lookup_request,
    public_response,
    signature_headers,
    verify_lookup_request,
)

SECRET = "whsec_test"


def lookup_body(**overrides):
    body = {"identifierType": "mrNumber", "identifier": " NH-004512 ", "context": "staff", "locationRef": None}
    body.update(overrides)
    return json.dumps(body).encode()


# --- lookup request -------------------------------------------------------------------------------


def test_verified_lookup_request():
    raw = lookup_body(locationRef="loc-1")
    request = verify_lookup_request(SECRET, signature_headers(SECRET, raw, event="patient.lookup"), raw)
    assert (request.identifier_type, request.identifier, request.context, request.location_ref) == (
        "mrNumber", "NH-004512", "staff", "loc-1")
    assert not request.is_public


def test_lookup_needs_the_lookup_event_and_a_good_signature():
    raw = lookup_body()
    with pytest.raises(WebhookVerificationError) as info:
        verify_lookup_request(SECRET, signature_headers(SECRET, raw, event="entry.called"), raw)
    assert info.value.code == "EVENT_MISMATCH"
    with pytest.raises(WebhookVerificationError) as info:
        verify_lookup_request(SECRET, signature_headers("other", raw, event="patient.lookup"), raw)
    assert info.value.code == "SIGNATURE_INVALID"


@pytest.mark.parametrize(
    "raw",
    [
        b"nope",
        b"[]",
        lookup_body(identifierType="email"),
        lookup_body(identifier=""),
        lookup_body(context="kiosk"),
        lookup_body(identifierType="patientRef", context="public"),
    ],
)
def test_bad_lookup_bodies(raw):
    with pytest.raises(LookupRequestError):
        parse_lookup_request(raw)
    assert issubclass(LookupRequestError, ValueError)


# --- lookup answers -------------------------------------------------------------------------------


def test_staff_answer_shape():
    cover = lookup_cover("Acme Health", plan="Gold", member_number="M1", status="active", expires_on="2027-01-31",
                         checked_via="payer")
    patient = lookup_patient("p1", "Ama Mensah", first_name="Ama", mr_number="NH-004512", birth_date="1988-04-02",
                             gender="Female", phone_masked="024•••••19", member_number="M1", cover=cover,
                             flags=["has_open_visit"])
    assert lookup_match(patient) == {
        "matched": True,
        "patient": {
            "ref": "p1", "displayName": "Ama Mensah", "firstName": "Ama", "mrNumber": "NH-004512",
            "birthDate": "1988-04-02", "gender": "Female", "phoneMasked": "024•••••19", "photoUrl": None,
            "identifiers": {"nationalId": None, "passport": None, "memberNumber": "M1"},
            "cover": {"payer": "Acme Health", "plan": "Gold", "memberNumber": "M1", "status": "active",
                      "expiresOn": "2027-01-31", "checkedVia": "payer", "message": None},
            "flags": ["has_open_visit"],
        },
        "candidates": [],
    }


def test_cover_values_are_checked():
    with pytest.raises(ValueError):
        lookup_cover("X", status="lapsed")
    with pytest.raises(ValueError):
        lookup_cover("X", checked_via="guess")
    assert lookup_cover("X", message="Payer timed out")["status"] == "unknown"


def test_candidates_and_no_match():
    many = [lookup_candidate(f"p{i}", f"Patient {i}") for i in range(7)]
    answer = lookup_candidates(many)
    assert answer["matched"] is False and answer["patient"] is None and len(answer["candidates"]) == 5
    assert answer["candidates"][0] == {"ref": "p0", "displayName": "Patient 0", "mrNumber": None, "birthDate": None,
                                       "phoneMasked": None}
    assert lookup_no_match() == {"matched": False, "patient": None, "candidates": []}


def test_public_answers_only_say_matched_and_first_name():
    patient = lookup_patient("p1", "Ama Mensah", first_name="Ama", mr_number="NH-1")
    public = parse_lookup_request(lookup_body(context="public"))
    staff = parse_lookup_request(lookup_body())
    assert lookup_response(public, lookup_match(patient)) == {"matched": True, "patient": {"firstName": "Ama"},
                                                              "candidates": []}
    assert lookup_response(public, lookup_candidates([lookup_candidate("p", "P")])) == public_response(False)
    assert lookup_response(staff, lookup_match(patient)) == lookup_match(patient)
    assert public_response(False, "Ama") == {"matched": False, "patient": None, "candidates": []}


def test_mask_phone():
    assert mask_phone("024 123 4519") == "024•••••19"
    assert mask_phone(None) is None
    assert mask_phone("1234") == "••••"


# --- desk protocol --------------------------------------------------------------------------------


def test_desk_messages():
    assert parse_desk_message({"type": "klargy:ready", "contract": "klargy-connect/v1"}).contract == "klargy-connect/v1"
    changed = parse_desk_message({"type": "klargy:desk-changed",
                                  "servicePoint": {"id": "sp1", "name": "Room 3", "externalId": "r3"}})
    assert changed.service_point == {"id": "sp1", "name": "Room 3", "externalId": "r3"}
    left = parse_desk_message({"type": "klargy:desk-changed", "servicePoint": None})
    assert left is not None and left.service_point is None
    assert parse_desk_message({"type": "klargy:waiting", "count": 4}).count == 4
    called = parse_desk_message({"type": "klargy:entry-called", "entry": {"entryId": "e1"}})
    assert called.type == "klargy:entry-called" and called.entry == {"entryId": "e1"}
    assert parse_desk_message({"type": "klargy:entry-updated", "entry": {"entryId": "e1"}}).entry["entryId"] == "e1"


@pytest.mark.parametrize(
    "data",
    [None, "klargy:ready", {"type": "klargy:ready"}, {"type": "klargy:waiting", "count": -1},
     {"type": "klargy:waiting", "count": True}, {"type": "klargy:entry-called"},
     {"type": "klargy:desk-changed", "servicePoint": {"name": "x"}}, {"type": "klargy:logout"}, {"type": "other"}],
)
def test_malformed_desk_messages_are_ignored(data):
    assert parse_desk_message(data) is None


def test_origin_rules():
    url = "https://acme.klargy.com/widget/desk?launch=abc"
    assert origin_of(url) == "https://acme.klargy.com"
    assert origin_of("https://acme.klargy.com:443/x") == "https://acme.klargy.com"
    assert origin_of("http://localhost:3000/x") == "http://localhost:3000"
    assert origin_of("javascript:alert(1)") is None
    assert is_desk_origin("https://acme.klargy.com", url)
    assert not is_desk_origin("https://evil.example", url)
    assert not is_desk_origin("null", url)
    assert logout_message() == {"type": "klargy:logout"}
