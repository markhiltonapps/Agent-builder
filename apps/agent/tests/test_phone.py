from types import SimpleNamespace as N

from livekit import rtc

from agent_builder.calls_store import source_for
from agent_builder.worker import sip_caller

SIP = rtc.ParticipantKind.PARTICIPANT_KIND_SIP
STANDARD = rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD


def test_a_phone_call_reports_the_callers_number():
    room = N(
        remote_participants={
            "web": N(kind=STANDARD, attributes={}),
            "phone": N(kind=SIP, attributes={"sip.phoneNumber": "+16025550123"}),
        }
    )
    assert sip_caller(room) == "+16025550123"


def test_a_browser_call_has_no_caller_number():
    assert sip_caller(N(remote_participants={"web": N(kind=STANDARD, attributes={})})) is None
    assert sip_caller(N(remote_participants={})) is None


def test_a_phone_participant_without_a_number_is_none():
    assert sip_caller(N(remote_participants={"p": N(kind=SIP, attributes={})})) is None


def test_phone_rooms_are_phone_calls_and_browser_rooms_are_not():
    assert source_for("call-_+16025550123_abc123") == "phone"
    assert source_for("talk-9bef4c7c-1234abcd") == "browser"
