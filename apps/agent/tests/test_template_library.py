"""The ready-made agents: every one is valid, honest about what it can do, and up to date."""

import json
import re

import pytest

from agent_builder.compiler import compile_agent
from agent_builder.config import AgentConfig
from agent_builder.template_library import (
    LIBRARY_FILE,
    all_industries,
    build,
    entry,
    library,
    plain_ask,
)

INDUSTRIES = all_industries()
IDS = [i.key for i in INDUSTRIES]

# Nothing a template says may be a made-up fact or a promise it cannot keep.
FACTS = re.compile(
    r"\$\s?\d|\b\d{3}[-. )]\d{3,4}|\b\d{1,2}(:\d{2})?\s?(am|pm)\b|https?://|www\.", re.IGNORECASE
)
PROMISES = re.compile(
    r"\byou'?re (all )?(booked|set|confirmed)|\bi'?ll (book|schedule|confirm)|connecting you|transferring you|"
    r"your appointment is (booked|confirmed)",
    re.IGNORECASE,
)
KNOWN_TOOLS = {"take_message", "send_booking_link", "transfer_to_human"}
TOOLISH = re.compile(r"\b[a-z]+(?:_[a-z]+)+\b")


def texts(i):
    cfg = build(i)
    yield from [
        i.blurb,
        i.description,
        i.opening,
        i.disclosure,
        *i.handles,
        *i.collects,
        *i.guardrails,
    ]
    yield from [i.urgent or "", i.urgent_rule, *i.transfer_when, i.speaking_rules, i.flows]
    yield from [c for pair in i.message_when for c in pair]
    yield cfg["policy"]["backend_flows"]


def test_there_is_at_least_the_starting_set():
    assert {"general", "auto-repair", "dental", "home-services"} <= set(IDS)


WANTED = {
    "general",
    "auto-repair",
    "car-dealership",
    "chiropractor",
    "construction",
    "consultant",
    "dental",
    "education",
    "financial-services",
    "fitness",
    "health",
    "home-services",
    "hospitality",
    "insurance",
    "legal",
    "life-coach",
    "loan-and-mortgage",
    "marketing-agency",
    "medical",
    "real-estate",
    "recruitment",
    "retail",
    "solar",
    "spa-and-wellness",
}


def test_every_requested_kind_of_business_is_there():
    assert set(IDS) == WANTED


def test_each_agent_has_its_own_name():
    names = [i.agent_name for i in INDUSTRIES]
    assert len(names) == len(set(names)), sorted(n for n in names if names.count(n) > 1)


def test_keys_are_unique_and_url_safe():
    assert len(IDS) == len(set(IDS))
    assert all(re.fullmatch(r"[a-z]+(-[a-z]+)*", k) for k in IDS)


@pytest.mark.parametrize("i", INDUSTRIES, ids=IDS)
def test_each_template_is_a_valid_agent_that_compiles(i):
    cfg = AgentConfig.model_validate(build(i))
    compiled = compile_agent(cfg)
    assert compiled.fingerprint
    assert "{business}" in i.opening and "{" not in i.opening.replace("{business}", "").replace(
        "{agent_name}", ""
    )
    assert cfg.persona.business_name == "Your business"  # the picker replaces this


@pytest.mark.parametrize("i", INDUSTRIES, ids=IDS)
def test_each_template_has_what_the_picker_card_needs(i):
    assert i.icon and 3 <= len(i.handles) <= 5
    assert i.blurb.endswith(".") and len(i.blurb) <= 130
    assert 40 <= len(i.description) <= 400
    assert i.agent_name.isalpha()
    assert all(q.endswith((".", "?")) for q in i.collects) and len(i.collects) <= 5


@pytest.mark.parametrize("i", INDUSTRIES, ids=IDS)
def test_each_template_is_honest_and_has_sensible_handoffs(i):
    for g in i.guardrails:
        assert g.startswith(("Never", "Always")), g
    assert i.urgent and i.urgent_rule, "every business needs a rule for urgent calls"
    cfg = build(i)
    actions = [e["action"] for e in cfg["escalation"]]
    assert actions[0] == "transfer" and "take_message" in actions or i.message_when == []
    assert any("asks for a person" in e["condition"] for e in cfg["escalation"])


@pytest.mark.parametrize("i", INDUSTRIES, ids=IDS)
def test_no_invented_facts_promises_or_tools(i):
    for t in texts(i):
        assert not FACTS.search(t), f"made-up fact in {i.key}: {t[:80]}"
        assert not PROMISES.search(t), f"promise it cannot keep in {i.key}: {t[:80]}"
        assert set(TOOLISH.findall(t)) <= KNOWN_TOOLS | {"request_type", "agent_name"}, (
            f"unknown tool in {i.key}: {t[:80]}"
        )


@pytest.mark.parametrize("i", INDUSTRIES, ids=IDS)
def test_the_message_flow_asks_for_the_details_a_team_needs(i):
    flow = build(i)["policy"]["backend_flows"].lower()
    for needed in ("first name", "last name", "email", "take_message", "request_type"):
        assert needed in flow, f"{i.key} flow lacks {needed}"


def test_the_library_file_is_up_to_date():
    on_disk = json.loads(LIBRARY_FILE.read_text())
    assert on_disk == json.loads(json.dumps(library())), (
        "templates/library.json is stale: run `uv run python -m agent_builder.template_library`"
    )


def test_an_entry_carries_card_text_and_config():
    e = entry(INDUSTRIES[0])
    assert {"key", "label", "icon", "blurb", "handles", "asks", "greeting", "config"} <= set(e)
    assert e["asks"][:4] == ["First and last name", "Phone number", "Email", "Why they are calling"]


def test_asks_read_as_plain_phrases_for_the_owner():
    assert plain_ask("Ask for the car's year, make and model.") == "Car's year, make and model"
    assert (
        plain_ask("Ask whether they are looking to buy, sell or rent.")
        == "Whether they are looking to buy, sell or rent"
    )
    assert plain_ask("Ask for a short summary. Tell them to keep it brief.") == "Short summary"
    assert (
        plain_ask("If they are buying, ask whether they are pre-approved.")
        == "Whether they are pre-approved (if they are buying)"
    )
    assert plain_ask("Ask what is wrong with the car.") == "What is wrong with the car"


@pytest.mark.parametrize("i", INDUSTRIES, ids=IDS)
def test_no_ask_on_the_card_is_an_instruction_to_the_agent(i):
    for a in entry(i)["asks"]:
        assert not a.lower().startswith(("ask ", "tell ", "say ")), (i.key, a)
        assert len(a) <= 140, (i.key, a)
