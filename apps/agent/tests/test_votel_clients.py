"""Clients two ways with Votel contacts, against a stand-in for Votel's tools."""

import pytest

from agent_builder import votel_clients as vc
from agent_builder.votel import VotelConfig, VotelError

CFG = VotelConfig(key="sk_test")
A = "b9a2fcdc-b9af-4c7e-a526-ae2e5767c93e"
B = "800a25d7-66ec-4f90-966b-2e4d83068ffe"

LISTING = f"""Found 3 contact(s):

- ZZ Test Client Co | email: zz-test-client@example.com | phone: None | stage: lead | tags: agent-builder-client | created: 2026-11-05 | id: {A}
- Bright &amp; Smile Dental | email: front@bright.test | phone: +15125550100 | stage: customer | tags: agent-builder-client, vip | created: 2026-11-03 | id: {B.upper()}
- No Id Here | email: x@y.z
"""

GET = f"""Contact: ZZ Test Client Co
  email: zz-test-client@example.com
  company: Real Company &amp; Sons
  lifecycle_stage: lead
  tags: agent-builder-client, vip
  id: {A}
  created: 2026-11-05T04:08:14.522023+00:00"""


class Votel:
    """Records every tool call; replies come from ``replies`` by tool name."""

    def __init__(self, **replies):
        self.replies = replies
        self.calls: list[tuple[str, dict]] = []

    async def __call__(self, cfg, name, args, **_kw):
        self.calls.append((name, args))
        reply = self.replies.get(name, "")
        if isinstance(reply, Exception):
            raise reply
        return reply(args) if callable(reply) else reply


@pytest.fixture
def votel(monkeypatch):
    def install(**replies):
        v = Votel(**replies)
        monkeypatch.setattr(vc, "call_tool", v)
        return v

    return install


def test_tagged_contacts_are_read_from_votels_text():
    found = vc.parse_clients(LISTING)
    assert [c.name for c in found] == ["ZZ Test Client Co", "Bright & Smile Dental"]
    assert found[0].email == "zz-test-client@example.com" and found[0].phone == ""  # None -> empty
    assert found[1].phone == "+15125550100"
    assert found[1].id == B  # lower-cased
    assert vc.parse_clients("No contacts match that search.") == []


async def test_the_list_asks_votel_for_the_tag(votel):
    v = votel(list_contacts=LISTING)
    assert len(await vc.list_clients(CFG)) == 2
    assert v.calls == [("list_contacts", {"tags": ["agent-builder-client"], "limit": 100})]


async def test_a_company_name_becomes_the_client_name(votel):
    votel(get_contact=GET)
    client = await vc.fetch_client(CFG, A)
    assert client.name == "Real Company & Sons" and client.id == A


async def test_a_contact_without_the_tag_is_not_a_client(votel):
    votel(get_contact=GET.replace("agent-builder-client, vip", "vip"))
    with pytest.raises(VotelError, match="does not have the agent-builder-client tag"):
        await vc.fetch_client(CFG, A)


async def test_a_bad_id_is_refused_before_asking_votel(votel):
    v = votel()
    with pytest.raises(VotelError, match="not a Votel contact id"):
        await vc.fetch_client(CFG, "../../x")
    assert v.calls == []


async def test_a_new_client_becomes_a_tagged_contact_with_a_link_back(votel):
    v = votel(
        create_contact=f'Contact "Acme" created!\n  ID: {A}', add_contact_tags="ok", add_note="ok"
    )
    got = await vc.push_client(
        CFG,
        name="Acme Dental",
        email="front@acme.test",
        phone="(512) 555-0100",
        app_url="https://bots.test/",
    )
    assert got == A
    names = [n for n, _ in v.calls]
    assert names == ["create_contact", "add_contact_tags", "add_note"]
    created = v.calls[0][1]
    assert created["company"] == "Acme Dental" and created["tags"] == ["agent-builder-client"]
    assert created["email"] == "front@acme.test" and created["phone"] == "+15125550100"
    assert "https://bots.test/clients" in v.calls[2][1]["note"]


async def test_a_bad_email_or_phone_is_left_out_not_sent(votel):
    v = votel(create_contact=f"created ID: {A}", add_contact_tags="ok")
    await vc.push_client(CFG, name="Acme", email="not-an-email", phone="12")
    assert set(v.calls[0][1]) == {"first_name", "company", "tags"}


async def test_an_existing_link_is_kept_and_retagged(votel):
    v = votel(add_contact_tags="ok")
    assert await vc.push_client(CFG, name="Acme", contact_id=B) == B
    assert [n for n, _ in v.calls] == ["add_contact_tags"]


async def test_a_contact_deleted_in_votel_is_replaced(votel):
    v = votel(
        add_contact_tags=lambda a: (
            (_ for _ in ()).throw(VotelError("gone")) if a["contact_id"] == B else "ok"
        ),
        create_contact=f"created ID: {A}",
    )
    assert await vc.push_client(CFG, name="Acme", contact_id=B) == A
    assert [n for n, _ in v.calls][:2] == ["add_contact_tags", "create_contact"]


async def test_votel_giving_no_id_is_an_error(votel):
    votel(create_contact="Something odd")
    with pytest.raises(VotelError, match="did not return a contact id"):
        await vc.push_client(CFG, name="Acme")


async def test_a_call_note_never_raises(votel):
    v = votel(add_note=VotelError("down"))
    await vc.note_call(CFG, A, agent="Front desk", outcome="Booked.", link="https://x/calls/1")
    assert v.calls[0][1]["subject"] == "Call: Front desk"
    v2 = votel(add_note="ok")
    await vc.note_call(CFG, A, agent="Front desk", outcome="Booked.", link="https://x/calls/1")
    assert "Booked." in v2.calls[0][1]["note"] and "https://x/calls/1" in v2.calls[0][1]["note"]
