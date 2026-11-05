"""Importing an agent from Votel: reading its list and handing it to the drafter."""

import pytest

from agent_builder.votel import VotelError
from agent_builder.votel_import import MAX_DIGEST, as_brief, fetch_agent, parse_agents

LISTING = """Found 3 agent(s):

- Neato Ventures Agent [live] channels: chat, social, sms, email | agent_id: eb4582ec-46c2-42c1-a0db-363383eff661 | numbers: 1, triggers: 0
- Live Oak Tree &amp; Land Services [live] channels: chat | agent_id: 7ff308ad-6ebf-460e-888a-700111bfd6a5 | numbers: 0, triggers: 0
- Plumbing Leadline [draft] channels: chat | agent_id: CBEDFBE9-157A-46B3-8893-13BAD907DDD1 | numbers: 0, triggers: 1

Note: to add NEW automation, create a fresh agent with create_ai_agent unless the user named one.
"""


def test_the_agent_list_is_read_from_votels_text():
    agents = parse_agents(LISTING)
    assert [a.name for a in agents] == [
        "Neato Ventures Agent",
        "Live Oak Tree & Land Services",  # HTML entity decoded
        "Plumbing Leadline",
    ]
    assert [a.status for a in agents] == ["live", "live", "draft"]
    assert agents[0].channels == "chat, social, sms, email"
    assert agents[2].id == "cbedfbe9-157a-46b3-8893-13bad907ddd1"  # lower-cased


def test_nothing_else_in_the_reply_is_taken_for_an_agent():
    assert parse_agents("No agents found.\n\n- not a real line") == []
    assert parse_agents("") == []


def test_the_brief_keeps_the_agent_and_says_to_invent_nothing():
    brief = as_brief("Front Desk", "# Personality\nWarm and kind.\n# Goal\nBook visits.")
    assert '"Front Desk"' in brief and "Warm and kind." in brief and "Book visits." in brief
    assert "Do not add facts, prices, hours or policies" in brief
    assert "take a message" in brief


def test_a_very_long_agent_is_cut_and_says_so():
    brief = as_brief("Big", "x" * (MAX_DIGEST + 500))
    assert "[the rest was cut for length]" in brief
    assert "x" * MAX_DIGEST in brief and "x" * (MAX_DIGEST + 1) not in brief


async def test_a_bad_id_is_refused_before_asking_votel():
    with pytest.raises(VotelError, match="not a Votel agent id"):
        await fetch_agent(object(), "../../etc/passwd")  # type: ignore[arg-type]
