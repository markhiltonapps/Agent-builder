"""Card details never reach a transcript, a call record or a saved conversation."""

import json

from agent_builder.calls_store import transcript_lines
from agent_builder.redact import REMOVED, mask_card, redact_chat, redact_data, redact_text
from agent_builder.tools import CallRecorder, ToolCallRecord


def test_a_card_number_in_any_common_spelling_is_removed():
    for said in (
        "4242424242424242",
        "4242 4242 4242 4242",
        "4242-4242-4242-4242",
        "my card is 4242 4242 4242 4242, thanks",
    ):
        out = redact_text(said)
        assert "4242" not in out and REMOVED in out, said
    spoken = "four two four two four two four two four two four two four two four two"
    assert redact_text(f"It's {spoken} okay") == f"It's {REMOVED} okay"
    assert "4242" not in redact_text("378282246310005") and "4242" not in redact_text(
        "3782 822463 10005"
    )


def test_ordinary_numbers_are_left_alone():
    for fine in (
        "call me at 512-555-0142",
        "(512) 555-0142 extension 12",
        "confirmation HH-48301",
        "December 12th, three nights, $668.64",
        "zip 78701",
        "room 214",
    ):
        assert redact_text(fine) == fine, fine


def test_a_security_code_is_removed_after_its_name():
    assert "123" not in redact_text("the cvv is 123")
    assert "4321" not in redact_text("security code: 4321")
    assert "one two three" not in redact_text("CVV one two three")
    assert redact_text("we need your date of birth") == "we need your date of birth"


def test_fields_named_like_a_card_are_masked_even_when_they_look_harmless():
    args = {
        "card_number": "4242424242424242",
        "cvv": "123",
        "expiry": "12/29",
        "billing_zip": "78701",
        "amount": 150.5,
        "guest": {"cardNumber": "4242 4242 4242 4242"},
    }
    out = redact_data(args)
    assert (
        out["card_number"] == mask_card("4242") == "•••• 4242" or out["card_number"] == "•••• 4242"
    )
    assert out["cvv"] == "•••" and out["expiry"] == "••/••"
    assert out["billing_zip"] == "78701" and out["amount"] == 150.5
    assert out["guest"]["cardNumber"] == "•••• 4242"
    assert "4242424242424242" not in json.dumps(out)


def test_a_recorded_tool_call_never_holds_the_card():
    rec = CallRecorder()
    rec.calls.append(
        ToolCallRecord(
            "charge_card",
            {"card_number": "4242424242424242", "cvv": "123", "amount": 100},
            True,
            {"approved": True, "note": "card 4242 4242 4242 4242 ok"},
            5,
            False,
        )
    )
    text = json.dumps(rec.to_json())
    assert (
        "4242424242424242" not in text and "4242 4242 4242 4242" not in text and "123" not in text
    )
    restored = CallRecorder()
    restored.restore(rec.to_json(), False, None)
    assert restored.calls[0].args["card_number"] == "•••• 4242"


def test_a_saved_conversation_loses_the_card_in_messages_and_in_tool_calls():
    chat = {
        "items": [
            {
                "type": "message",
                "role": "user",
                "content": ["my number is 4242 4242 4242 4242 and cvv 123"],
            },
            {
                "type": "function_call",
                "name": "charge_card",
                "arguments": json.dumps(
                    {"card_number": "4242424242424242", "cvv": "123", "amount": 99}
                ),
            },
            {
                "type": "function_call_output",
                "output": json.dumps({"approved": True, "last4": "4242"}),
            },
            {
                "type": "message",
                "role": "assistant",
                "content": ["Thanks. I have the card ending 4242."],
            },
        ]
    }
    out = json.dumps(redact_chat(chat))
    assert (
        "4242424242424242" not in out
        and "4242 4242 4242 4242" not in out
        and '"123"' not in out
        and "cvv 123" not in out
    )
    kept = json.loads(redact_chat(chat)["items"][2]["output"])
    assert "ending 4242" in out and kept == {
        "approved": True,
        "last4": "4242",
    }  # the last four are fine to keep


def test_the_transcript_saved_under_calls_is_clean():
    chat = {"items": [{"type": "message", "role": "user", "content": ["card 4242 4242 4242 4242"]}]}
    assert transcript_lines(chat) == [{"who": "caller", "text": f"card {REMOVED}"}]
