"""The demonstration hotel: dates, rates, the card payment, bookings and changes all behave like a real system."""

import pytest

from agent_builder.adapters import ToolFailed, build_adapter
from agent_builder.adapters.hotel_demo import HotelDemoAdapter, MemoryStore
from agent_builder.config import AdapterConfig
from agent_builder.demo_hotel import options

NOW = "2026-11-05T10:00:00"  # a Thursday


def hotel(store=None, now=NOW) -> HotelDemoAdapter:
    return HotelDemoAdapter(
        "hotel", {**options(), "now": now}, store=store if store is not None else MemoryStore()
    )


GOOD = {
    "card_number": "4242 4242 4242 4242",
    "expiry": "08/28",
    "cvv": "123",
    "billing_zip": "78701",
}


async def book(
    h: HotelDemoAdapter,
    room="Deluxe King with Balcony",
    ci="2026-12-10",
    co="2026-12-13",
    guests=2,
    **extra,
):
    q = await h.call(
        "check_room_availability",
        {"check_in": ci, "check_out": co, "guests": guests, "room_type": room},
    )
    deposit = float(q["rooms"][0]["deposit_due_now"].replace("$", "").replace(",", ""))
    paid = await h.call("charge_card", {**GOOD, "amount": deposit})
    return await h.call(
        "book_room",
        {
            "room_type": room,
            "check_in": ci,
            "check_out": co,
            "guests": guests,
            "first_name": "Sam",
            "last_name": "Rivera",
            "phone": "512-555-0142",
            "payment_authorization": paid["authorization_code"],
            **extra,
        },
    )


def test_the_mock_adapter_with_the_hotel_engine_is_the_hotel():
    adapter = build_adapter("hotel", AdapterConfig(kind="mock", options=options()))
    assert isinstance(adapter, HotelDemoAdapter)


async def test_rates_add_up_exactly_with_weekend_nights_tax_and_deposit():
    q = await hotel().call(
        "check_room_availability",
        {
            "check_in": "2026-12-10",
            "check_out": "2026-12-13",
            "guests": 2,
            "room_type": "Deluxe King with Balcony",
        },
    )
    (r,) = q["rooms"]
    # Thursday $199, Friday and Saturday $229 each: 657 plus 12% tax; the deposit is the first night plus its tax
    assert r["nightly_rates"] == ["$199.00", "$229.00", "$229.00"]
    assert (r["room_total_before_tax"], r["tax"], r["total_with_tax"]) == (
        "$657.00",
        "$78.84",
        "$735.84",
    )
    assert (r["deposit_due_now"], r["balance_due_at_check_in"]) == ("$222.88", "$512.96")
    assert q["check_in_day"] == "Thursday" and q["nights"] == 3 and q["bookable"] is True


async def test_the_same_dates_always_give_the_same_answer_and_the_party_size_filters_rooms():
    args = {"check_in": "2026-12-10", "check_out": "2026-12-12", "guests": 5}
    a, b = (
        await hotel().call("check_room_availability", args),
        await hotel().call("check_room_availability", args),
    )
    assert a == b
    assert [r["room_type"] for r in a["rooms"]] == ["Family Suite"]
    assert any("Standard King (sleeps 2)" in s for s in a["too_small_for_this_party"])


async def test_an_event_weekend_sells_out_and_a_holiday_costs_more():
    q = await hotel().call(
        "check_room_availability",
        {"check_in": "2026-11-20", "check_out": "2026-11-22", "guests": 2},
    )
    assert q["bookable"] is False and all(r["availability"] == "sold out" for r in q["rooms"])
    assert "convention" in q["notices"][0]
    xmas = await hotel().call(
        "check_room_availability",
        {
            "check_in": "2026-12-24",
            "check_out": "2026-12-25",
            "guests": 2,
            "room_type": "Standard King",
        },
    )
    assert xmas["rooms"][0]["nightly_rates"] == ["$199.00"]  # $149 plus the $50 Christmas night


async def test_new_years_eve_has_a_two_night_minimum():
    one = await hotel().call(
        "check_room_availability",
        {"check_in": "2026-12-31", "check_out": "2027-01-01", "guests": 2},
    )
    assert one["bookable"] is False and "minimum stay of 2 nights" in one["notices"][0]
    two = await hotel().call(
        "check_room_availability",
        {
            "check_in": "2026-12-30",
            "check_out": "2027-01-01",
            "guests": 2,
            "room_type": "Standard Double Queen",
        },
    )
    assert (
        two["bookable"] is True and two["rooms"][0]["nightly_rates"][1] == "$229.00"
    )  # 169 plus 60 on the 31st


async def test_a_promo_code_takes_a_percentage_off_and_a_bad_one_is_refused():
    q = await hotel().call(
        "check_room_availability",
        {
            "check_in": "2026-12-08",
            "check_out": "2026-12-10",
            "guests": 2,
            "room_type": "Standard King",
            "promo_code": "welcome10",
        },
    )
    r = q["rooms"][0]
    assert (
        r["room_total_before_tax"] == "$298.00"
        and r["promo_discount"] == "$29.80"
        and "10%" in q["promo_applied"]
    )
    with pytest.raises(ToolFailed, match="not valid"):
        await hotel().call(
            "check_room_availability",
            {
                "check_in": "2026-12-08",
                "check_out": "2026-12-10",
                "guests": 2,
                "promo_code": "FREEROOM",
            },
        )


@pytest.mark.parametrize(
    "args,message",
    [
        ({"check_in": "2026-11-01", "check_out": "2026-11-03", "guests": 2}, "in the past"),
        ({"check_in": "2026-12-10", "check_out": "2026-12-10", "guests": 2}, "after check_in"),
        ({"check_in": "2026-12-01", "check_out": "2026-12-20", "guests": 2}, "up to 14 nights"),
        ({"check_in": "2026-12-10", "check_out": "2026-12-12", "guests": 12}, "1 to 8"),
        ({"check_in": "next friday", "check_out": "2026-12-12", "guests": 2}, "YYYY-MM-DD"),
    ],
)
async def test_impossible_requests_say_what_is_wrong(args, message):
    with pytest.raises(ToolFailed, match=message):
        await hotel().call("check_room_availability", args)


async def test_only_test_cards_are_taken_and_a_real_looking_card_is_refused():
    h = hotel()
    real = await h.call("charge_card", {**GOOD, "card_number": "4111111111111111", "amount": 100})
    assert (
        real["approved"] is False
        and real["reason"] == "not_a_test_card"
        and "4242" in real["message"]
    )
    ok = await h.call("charge_card", {**GOOD, "amount": 222.88})
    assert (
        ok["approved"] is True
        and ok["last4"] == "4242"
        and ok["authorization_code"].startswith("A")
    )
    assert "4242424242424242" not in str(ok)


async def test_the_declined_card_the_bad_expiry_and_the_wrong_code_are_each_explained():
    h = hotel()
    declined = await h.call(
        "charge_card", {**GOOD, "card_number": "4000000000000002", "amount": 100}
    )
    assert declined["approved"] is False and declined["reason"] == "declined"
    assert (
        await h.call("charge_card", {**GOOD, "card_number": "4000000000009995", "amount": 100})
    )["message"].startswith("The card has insufficient funds")
    assert (await h.call("charge_card", {**GOOD, "expiry": "01/24", "amount": 100}))[
        "reason"
    ] == "card_expired"
    assert (await h.call("charge_card", {**GOOD, "expiry": "13/28", "amount": 100}))[
        "reason"
    ] == "card_expired"
    assert (await h.call("charge_card", {**GOOD, "cvv": "12", "amount": 100}))[
        "reason"
    ] == "invalid_security_code"
    assert (await h.call("charge_card", {**GOOD, "billing_zip": "787", "amount": 100}))[
        "reason"
    ] == "invalid_zip"
    amex = {**GOOD, "card_number": "378282246310005", "amount": 100}
    assert (await h.call("charge_card", {**amex, "cvv": "123"}))[
        "reason"
    ] == "invalid_security_code"
    assert (await h.call("charge_card", {**amex, "cvv": "1234"}))["approved"] is True
    with pytest.raises(ToolFailed):
        await h.call("charge_card", {**GOOD, "amount": 99999})


async def test_a_room_cannot_be_booked_before_its_deposit_is_paid_or_with_the_wrong_amount():
    h = hotel()
    base = {
        "room_type": "Deluxe King with Balcony",
        "check_in": "2026-12-10",
        "check_out": "2026-12-13",
        "guests": 2,
        "first_name": "Sam",
        "last_name": "Rivera",
        "phone": "5125550142",
    }
    with pytest.raises(ToolFailed, match="has not been charged yet"):
        await h.call("book_room", {**base, "payment_authorization": ""})
    wrong = await h.call("charge_card", {**GOOD, "amount": 50})
    with pytest.raises(ToolFailed, match="is not the deposit due"):
        await h.call("book_room", {**base, "payment_authorization": wrong["authorization_code"]})


async def test_a_booking_returns_a_confirmation_and_one_payment_books_only_one_room():
    h = hotel()
    out = await book(h, special_requests="Anniversary")
    assert (
        out["booked"] is True
        and out["confirmation_number"].startswith("HH-")
        and out["deposit_paid"] == "$222.88"
    )
    assert (
        out["balance_due_at_check_in"] == "$512.96"
        and out["paid_with"] == "Visa ending 4242"
        and out["check_in_time"] == "3 pm"
    )
    assert out["free_cancellation_until"].startswith("2026-12-08T15:00")
    with pytest.raises(
        ToolFailed, match="has not been charged yet"
    ):  # the same payment cannot book a second room
        await h.call(
            "book_room",
            {
                "room_type": "Deluxe King with Balcony",
                "check_in": "2026-12-10",
                "check_out": "2026-12-13",
                "guests": 2,
                "first_name": "Sam",
                "last_name": "Rivera",
                "phone": "5125550142",
                "payment_authorization": (h.state["charges"][0]["auth_code"]),
            },
        )


async def test_a_booking_is_found_again_by_number_and_name_or_by_name_and_phone_even_in_a_later_call():
    store = MemoryStore()
    first = hotel(store)
    out = await book(first)
    number = out["confirmation_number"]
    later = hotel(store)  # a different call, a different adapter, the same hotel database
    found = await later.call(
        "lookup_reservation",
        {"confirmation_number": number.lower().replace("-", " "), "last_name": "RIVERA"},
    )
    assert (
        found["found"] is True
        and found["room_type"] == "Deluxe King with Balcony"
        and found["status"] == "confirmed"
    )
    by_phone = await later.call(
        "lookup_reservation", {"last_name": "Rivera", "phone": "(512) 555-0142"}
    )
    assert by_phone["confirmation_number"] == number
    assert (
        await later.call(
            "lookup_reservation", {"confirmation_number": number, "last_name": "Smith"}
        )
    )["found"] is False
    with pytest.raises(ToolFailed, match="last name"):
        await later.call("lookup_reservation", {"confirmation_number": number})


async def test_the_sample_reservations_are_there_to_find():
    found = await hotel().call(
        "lookup_reservation", {"confirmation_number": "HH-48213", "last_name": "Johnson"}
    )
    assert (
        found["found"]
        and found["total_with_tax"] == "$479.36"
        and found["deposit_paid"] == "$256.48"
        and found["paid_with"] == "Visa ending 4242"
    )


async def test_cancelling_inside_the_free_window_refunds_the_deposit_and_after_it_keeps_it():
    early = hotel()
    out = await early.call(
        "cancel_reservation", {"confirmation_number": "HH-48213", "last_name": "Johnson"}
    )  # check-in 14 Nov, today 5 Nov
    assert (
        out["cancelled"]
        and out["refund_amount"] == "$256.48"
        and "3 to 5 business days" in out["refund_note"]
    )
    with pytest.raises(ToolFailed, match="cancelled"):
        await early.call(
            "cancel_reservation", {"confirmation_number": "HH-48213", "last_name": "Johnson"}
        )
    late = hotel(now="2026-11-13T09:00:00")  # a day before check-in
    kept = await late.call(
        "cancel_reservation", {"confirmation_number": "HH-48213", "last_name": "Johnson"}
    )
    assert kept["refund_amount"] == "$0.00" and "kept" in kept["refund_note"]
    with pytest.raises(ToolFailed, match="last name"):
        await hotel().call("cancel_reservation", {"confirmation_number": "HH-47790"})


async def test_changing_dates_requotes_and_refuses_unavailable_dates_and_rooms_that_are_too_small():
    h = hotel()
    out = await h.call(
        "modify_reservation",
        {
            "confirmation_number": "HH-47790",
            "last_name": "Patel",
            "new_check_in": "2026-12-03",
            "new_check_out": "2026-12-05",
        },
    )
    assert (
        out["modified"] and out["nights"] == 2 and out["total_with_tax"] == "$658.56"
    )  # Thursday 279 and Friday 309
    assert out["balance_due_at_check_in"] == "$346.08"
    with pytest.raises(ToolFailed, match="not available"):
        await h.call(
            "modify_reservation",
            {
                "confirmation_number": "HH-48213",
                "last_name": "Johnson",
                "new_check_in": "2026-11-20",
                "new_check_out": "2026-11-22",
            },
        )
    with pytest.raises(ToolFailed, match="sleeps up to 2"):
        await h.call(
            "modify_reservation",
            {
                "confirmation_number": "HH-47790",
                "last_name": "Patel",
                "new_room_type": "Standard King",
            },
        )


async def test_services_have_fees_and_ask_for_what_they_need():
    h = hotel()
    shuttle = await h.call(
        "request_service",
        {
            "confirmation_number": "HH-47790",
            "last_name": "Patel",
            "service": "airport_shuttle",
            "details": "United 482, landing 3:40 pm",
        },
    )
    assert (
        shuttle["fee"] == "$125.00" and shuttle["fee_is_added_to"] == "the balance paid at check-in"
    )  # $25 for each of 5 guests
    assert (
        await h.call(
            "request_service",
            {"confirmation_number": "HH-47790", "last_name": "Patel", "service": "crib"},
        )
    )["fee"] == "no charge"
    with pytest.raises(ToolFailed, match="flight"):
        await h.call(
            "request_service",
            {"confirmation_number": "HH-47790", "last_name": "Patel", "service": "airport_shuttle"},
        )
    with pytest.raises(ToolFailed, match="services are"):
        await h.call(
            "request_service",
            {"confirmation_number": "HH-47790", "last_name": "Patel", "service": "helicopter"},
        )
    found = await h.call(
        "lookup_reservation", {"confirmation_number": "HH-47790", "last_name": "Patel"}
    )
    assert found["extras"] == ["airport_shuttle", "crib"]


async def test_a_call_that_restarts_keeps_its_payment_and_booking():
    h = hotel()
    paid = await h.call("charge_card", {**GOOD, "amount": 222.88})
    snap = h.snapshot()
    again = hotel()
    again.restore(snap)
    assert again.state["charges"][0]["auth_code"] == paid["authorization_code"]
    assert "4242424242424242" not in str(snap)
