"""The demonstration hotel: the settings, tools, conversation rules and sample reservations that turn an
agent into "Holiday Hotel" in Houston, Texas, a made-up hotel with a booking system that is also made up
(``adapters/hotel_demo.py``). The hotel and its booking system are fiction; the area (restaurants, golf, directions) is looked up on the real web.

``build_config(base)`` returns a full agent configuration from an existing one (keeping its voice and
settings). The documents the agent answers from live in ``demo/hotel/*.md`` and are uploaded under Knowledge.
"""

from __future__ import annotations

import copy
from typing import Any

from .adapters.hotel_demo import HotelDemoAdapter

PREFIX = "HH"
TAX_RATE = 0.12

ROOMS: list[dict[str, Any]] = [
    {
        "type": "Standard King",
        "beds": "1 king bed",
        "max_guests": 2,
        "base_rate": 149,
        "count": 48,
        "details": "Quiet courtyard view, work desk, free wifi, 43-inch TV, coffee maker",
    },
    {
        "type": "Standard Double Queen",
        "beds": "2 queen beds",
        "max_guests": 4,
        "base_rate": 169,
        "count": 44,
        "details": "Room for four, work desk, free wifi, mini fridge",
    },
    {
        "type": "Deluxe King with Balcony",
        "beds": "1 king bed",
        "max_guests": 2,
        "base_rate": 199,
        "count": 20,
        "details": "Private balcony with a city view, sitting area, soaking tub, free wifi",
    },
    {
        "type": "Family Suite",
        "beds": "1 king bed and a sofa bed, plus a second bedroom with 2 twin beds",
        "max_guests": 6,
        "base_rate": 279,
        "count": 7,
        "details": "Two rooms, kitchenette, two bathrooms, sleeps six",
    },
    {
        "type": "Penthouse Suite",
        "beds": "1 king bed",
        "max_guests": 3,
        "base_rate": 449,
        "count": 1,
        "weekend_surcharge": 60,
        "details": "Top floor, wraparound terrace, panoramic city views, jetted tub, separate living room",
    },
]

TEST_CARDS: list[dict[str, Any]] = [
    {"number": "4242424242424242", "brand": "Visa", "result": "approved"},
    {"number": "5555555555554444", "brand": "Mastercard", "result": "approved"},
    {"number": "378282246310005", "brand": "Amex", "result": "approved"},
    {"number": "6011111111111117", "brand": "Discover", "result": "approved"},
    {
        "number": "4000000000000002",
        "brand": "Visa",
        "result": "declined",
        "message": "The bank declined the card.",
    },
    {
        "number": "4000000000009995",
        "brand": "Visa",
        "result": "declined",
        "message": "The card has insufficient funds.",
    },
]

SERVICES: dict[str, dict[str, Any]] = {
    "early_check_in": {
        "fee": 0,
        "status": "confirmed",
        "note": "A room is guaranteed from 12 noon; earlier if one is ready, and the front desk will hold luggage.",
    },
    "late_check_out": {
        "fee": 0,
        "status": "confirmed",
        "needs": "the time they would like to leave",
        "free_until": 13,
        "fee_until": 15,
        "fee_amount": 30,
        "note": "Late check-out until 1 pm is complimentary. Until 3 pm costs $30, if the room is not needed. 3 pm is the latest.",
    },
    "airport_shuttle": {
        "fee": 25,
        "per": "guest",
        "status": "confirmed",
        "needs": "the flight number and arrival time",
        "note": "The hotel shuttle serves both Houston airports, Bush Intercontinental and Hobby, by reservation; the front desk confirms the pickup time.",
    },
    "crib": {
        "fee": 0,
        "status": "confirmed",
        "note": "A crib will be set up in the room before arrival, free of charge.",
    },
    "extra_bed": {
        "fee": 20,
        "per": "night",
        "status": "confirmed",
        "note": "A rollaway bed, $20 per night. Not available in the Standard King.",
    },
    "dinner_reservation": {
        "fee": 0,
        "status": "confirmed",
        "needs": "the time and the number of people",
        "note": "A table at the Holiday Grill, seating from 5 pm to 9:30 pm. Hotel guests get a complimentary dessert.",
    },
    "celebration_package": {
        "fee": 45,
        "status": "confirmed",
        "needs": "what they are celebrating",
        "note": "Champagne or sparkling cider, chocolate-covered strawberries and a handwritten card waiting in the room.",
    },
}

HOLIDAYS = [
    {"from": "2026-11-25", "to": "2026-11-28", "amount": 40, "name": "Thanksgiving week"},
    {"from": "2026-12-23", "to": "2026-12-26", "amount": 50, "name": "Christmas"},
    {"from": "2026-12-31", "to": "2026-12-31", "amount": 60, "name": "New Year's Eve"},
]

SEEDED = [
    {
        "confirmation": "HH-48213",
        "first_name": "Maria",
        "last_name": "Johnson",
        "phone": "7135550188",
        "room": "Deluxe King with Balcony",
        "check_in": "2026-11-14",
        "check_out": "2026-11-16",
        "guests": 2,
        "request": "Late arrival, around 10 pm",
        "card": "Visa ending 4242",
    },
    {
        "confirmation": "HH-47790",
        "first_name": "Anil",
        "last_name": "Patel",
        "phone": "5125550133",
        "room": "Family Suite",
        "check_in": "2026-12-02",
        "check_out": "2026-12-06",
        "guests": 5,
        "request": "Crib needed",
        "card": "Mastercard ending 4444",
    },
]


def base_options() -> dict[str, Any]:
    return {
        "engine": "hotel",
        "scope": "holiday-hotel-demo",
        "prefix": PREFIX,
        "timezone": "America/Chicago",
        "tax_rate": TAX_RATE,
        "weekend_surcharge": 30,
        "free_cancel_hours": 48,
        "check_in_time": "3 pm",
        "check_out_time": "11 am",
        "rooms": ROOMS,
        "holiday_surcharges": HOLIDAYS,
        "sold_out": [
            {"from": "2026-11-20", "to": "2026-11-22", "reason": "a large convention in town"}
        ],
        "min_stay": [{"includes": "2026-12-31", "nights": 2, "reason": "New Year's Eve"}],
        "promos": {
            "WELCOME10": {"percent": 10, "label": "Welcome offer"},
            "MILITARY": {"percent": 15, "label": "Military and veterans rate (ID at check-in)"},
            "AAA": {"percent": 10, "label": "Auto club member rate (card at check-in)"},
        },
        "test_cards": TEST_CARDS,
        "services": SERVICES,
    }


def options() -> dict[str, Any]:
    """The settings with sample reservations filled in from the hotel's own rates, so they add up exactly."""
    opts = base_options()
    engine = HotelDemoAdapter("seed", opts)
    seeded = []
    for s in SEEDED:
        from datetime import date

        room = engine._find_room(s["room"])
        ci, co = date.fromisoformat(s["check_in"]), date.fromisoformat(s["check_out"])
        nights = (co - ci).days
        q = engine._quote(room, ci, nights, None)
        seeded.append(
            {
                "confirmation": s["confirmation"],
                "status": "confirmed",
                "guest": {
                    "first_name": s["first_name"],
                    "last_name": s["last_name"],
                    "phone": s["phone"],
                    "email": "",
                },
                "room_type": room["type"],
                "check_in": s["check_in"],
                "check_out": s["check_out"],
                "nights": nights,
                "guests": s["guests"],
                "special_requests": s["request"],
                "promo": None,
                "total_with_tax": q["total_with_tax"],
                "deposit_paid": q["deposit_due_now"],
                "balance_due_at_check_in": q["balance_due_at_check_in"],
                "paid_with": s["card"],
                "authorization_code": "A" + s["confirmation"][-5:],
                "free_cancellation_until": f"{(ci.fromordinal(ci.toordinal() - 2)).isoformat()}T15:00:00-06:00",
                "services": [],
                "booked_at": "2026-10-20T14:05:00-05:00",
            }
        )
    opts["reservations"] = seeded
    return opts


TOOLS: list[dict[str, Any]] = [
    {
        "name": "check_room_availability",
        "adapter": "hotel",
        "description": "Check which rooms are available for a stay and what they cost. Returns every room that sleeps the party with its beds, availability, the rate for each night, tax, the total, the deposit due now and the balance due at check-in. Call it as soon as you have the dates and the number of guests.",
        "parameters": {
            "check_in": {"type": "string", "description": "Check-in date as YYYY-MM-DD."},
            "check_out": {"type": "string", "description": "Check-out date as YYYY-MM-DD."},
            "guests": {"type": "integer", "description": "How many people will stay."},
            "room_type": {
                "type": "string",
                "description": "Only this room type, if the caller asked about one.",
                "required": False,
            },
            "promo_code": {
                "type": "string",
                "description": "A promo code the caller gave, such as WELCOME10.",
                "required": False,
            },
        },
    },
    {
        "name": "charge_card",
        "adapter": "hotel",
        "description": "Charge the deposit to the caller's card. Digits only for the number, with no spaces. The amount is the deposit due now from the availability check. Returns an authorization code to pass to book_room. Never repeat the full card number to the caller.",
        "parameters": {
            "card_number": {"type": "string", "description": "The card number, digits only."},
            "expiry": {"type": "string", "description": "Expiry date as MM/YY."},
            "cvv": {
                "type": "string",
                "description": "The 3-digit security code (4 digits for American Express).",
            },
            "billing_zip": {"type": "string", "description": "The 5-digit billing ZIP code."},
            "amount": {
                "type": "number",
                "description": "The deposit due now, in dollars, as a number such as 256.48.",
            },
        },
    },
    {
        "name": "book_room",
        "adapter": "hotel",
        "goal": True,
        "description": "Book the room after the caller has chosen it, confirmed the details and the deposit has been charged. Returns the confirmation number to read to the caller.",
        "parameters": {
            "room_type": {
                "type": "string",
                "description": "The room type the caller chose, exactly as the availability check named it.",
            },
            "check_in": {"type": "string", "description": "Check-in date as YYYY-MM-DD."},
            "check_out": {"type": "string", "description": "Check-out date as YYYY-MM-DD."},
            "guests": {"type": "integer", "description": "How many people will stay."},
            "first_name": {"type": "string", "description": "Guest's first name."},
            "last_name": {"type": "string", "description": "Guest's last name."},
            "phone": {"type": "string", "description": "Callback phone number."},
            "payment_authorization": {
                "type": "string",
                "description": "The authorization code returned by charge_card.",
            },
            "email": {
                "type": "string",
                "description": "Email address, if the caller gave one.",
                "required": False,
            },
            "special_requests": {
                "type": "string",
                "description": "Anything the hotel should know, such as a celebration or accessibility needs.",
                "required": False,
            },
            "promo_code": {
                "type": "string",
                "description": "The promo code used for the quote, if any.",
                "required": False,
            },
        },
    },
    {
        "name": "lookup_reservation",
        "adapter": "hotel",
        "description": "Find a reservation. Give the confirmation number and the last name on it, or the last name and phone number.",
        "parameters": {
            "confirmation_number": {
                "type": "string",
                "description": "The confirmation number, such as HH-48213.",
                "required": False,
            },
            "last_name": {"type": "string", "description": "The last name on the reservation."},
            "phone": {
                "type": "string",
                "description": "The phone number on the reservation, if no confirmation number.",
                "required": False,
            },
        },
    },
    {
        "name": "modify_reservation",
        "adapter": "hotel",
        "description": "Change the dates or the room of an existing reservation, after the caller has confirmed the change. Returns the new total and balance.",
        "parameters": {
            "confirmation_number": {"type": "string", "description": "The confirmation number."},
            "last_name": {"type": "string", "description": "The last name on the reservation."},
            "new_check_in": {
                "type": "string",
                "description": "New check-in date as YYYY-MM-DD.",
                "required": False,
            },
            "new_check_out": {
                "type": "string",
                "description": "New check-out date as YYYY-MM-DD.",
                "required": False,
            },
            "new_room_type": {
                "type": "string",
                "description": "A different room type.",
                "required": False,
            },
        },
    },
    {
        "name": "cancel_reservation",
        "adapter": "hotel",
        "description": "Cancel a reservation, only after the caller has clearly confirmed they want to. Returns the refund the cancellation policy gives.",
        "parameters": {
            "confirmation_number": {"type": "string", "description": "The confirmation number."},
            "last_name": {"type": "string", "description": "The last name on the reservation."},
        },
    },
    {
        "name": "request_service",
        "adapter": "hotel",
        "description": "Add a service to a reservation: early_check_in, late_check_out, airport_shuttle, crib, extra_bed, dinner_reservation or celebration_package. Some need details (flight number, time, party size).",
        "parameters": {
            "confirmation_number": {"type": "string", "description": "The confirmation number."},
            "last_name": {"type": "string", "description": "The last name on the reservation."},
            "service": {
                "type": "string",
                "description": "Which service.",
                "enum": [
                    "early_check_in",
                    "late_check_out",
                    "airport_shuttle",
                    "crib",
                    "extra_bed",
                    "dinner_reservation",
                    "celebration_package",
                ],
            },
            "details": {
                "type": "string",
                "description": "The details the service needs, such as the flight and arrival time, the dinner time and party size, or what is being celebrated.",
                "required": False,
            },
        },
    },
]

FLOWS = """Book a room:
1. Ask for the check-in date, the check-out date (or the number of nights) and how many guests. Say dates the way a person says them aloud, with the weekday.
2. Call check_room_availability. Offer the best one or two rooms for the party with the beds, the nightly rate (mention if weekend nights cost more), and the total with tax. If a promo code is mentioned, include it. A sold-out room is not offered. If the result says the hotel is sold out or there is a minimum stay, explain and suggest other dates.
3. When they choose, ask for their first name, then last name, a phone number (read it back digit by digit) and an email address if they want one. Ask if there is anything the hotel should know, such as a celebration, a late arrival, accessibility needs or a crib.
4. Say what the booking needs: a deposit of the first night plus tax is charged now to guarantee the room, and the balance is paid at check-in. Give the deposit amount from the result and mention the free cancellation window.
5. Read the booking back in one go: room, dates, guests, total, deposit, name and phone, and ask them to confirm.
6. Take the card. Say that for their security you will only repeat the last four digits. Ask for the card number, then the expiry, then the 3-digit security code (4 digits for American Express), then the billing ZIP code, one at a time. Call charge_card with the digits only and the deposit amount.
   - If the tool says the number is the wrong length, ask the caller to say it again.
   - If it is declined, say so kindly and offer to try another card or to book without paying now by taking a message.
   - If it works, say the deposit went through and give the last four digits.
7. Call book_room with the authorization code. When it succeeds the room is booked: say so, read the confirmation number slowly, one character at a time, say the deposit paid and the balance due at check-in, repeat check-in and check-out times, and say they will get a confirmation by email. Then offer extras (airport shuttle, dinner table, late check-out, celebration package) with request_service, and ask if there is anything else.
8. If a step fails, apologize, say what is wrong in plain words and offer another room, other dates or to take a message.

Find a reservation:
1. Ask for the confirmation number and the last name on the booking (or the last name and phone number). Call lookup_reservation.
2. Tell them the room, dates, total, what was paid and what is due at check-in, and any extras.

Change a reservation:
1. Find it first. Ask what they want to change. Check the new dates with check_room_availability if you need the price, then confirm the change with them and call modify_reservation.

Cancel a reservation:
1. Find it first. Tell them what the cancellation policy means for them (free before the deadline, otherwise the deposit is kept) and ask if they are sure. Only then call cancel_reservation, and tell them the refund it reports.

Extras for a stay (early check-in, late check-out, airport shuttle, crib, extra bed, dinner table, celebration package):
1. Find the reservation, collect the details the service needs, and call request_service. Tell them the fee, if any, and that it is added to the balance at check-in.

Questions about the hotel or the area:
1. Answer questions about the hotel (rooms, amenities, policies, dining) from the knowledge base. For anything about the area, such as restaurants, golf, attractions, shopping, directions, events, the weather or the airports, say you will look it up and use search_web. If neither has the answer, say you are not sure and offer to take a message. After answering, ask if they would like to book.

Take a message or a request:
1. Find out what they need. Ask for their first name, then last name, and confirm the best number. Ask for an email if they want one.
2. Call take_message with everything and say in one sentence what happens next. Use this for groups of more than 8, events, weddings, billing disputes, lost property and anything you cannot do."""

SPEAKING_RULES = """- If anyone is hurt or in danger, or there is fire or smoke, tell them to call 911 right away, before anything else.
- Ask for one thing at a time and wait for the answer. Keep answers short and warm, like a good front desk agent.
- When you are not sure you heard a name or email right, ask the caller to spell it, then say it back.
- Read a phone number back digit by digit. Say money plainly, such as "two hundred twenty-nine dollars" or "two hundred twenty-nine dollars and forty-eight cents".
- Read amounts exactly as the tools give them. Never work out rates, totals or deposits yourself.
- Read a card number only as the last four digits. Never repeat the full number, the expiry or the security code.
- Say a confirmation number one character at a time, and say "dash" for the dash.
- Do not mention tools, systems or the demo unless the card is refused or the caller asks.
- After you finish a task, ask if there is anything else you can help with."""

GUARDRAILS = [
    "Say a room is available, and what it costs, only from check_room_availability. Never work out rates or totals yourself; read the amounts the tool gives.",
    "A room is booked only after book_room succeeds. Never say it is booked, or give a confirmation number, before that.",
    "Take card details only for the deposit, through charge_card. Say only the last four digits back. Never write a card number anywhere else.",
    "Answer hotel questions from the knowledge base and area questions with search_web. If you have neither, say you are not sure and offer to take a message. Never make up facts.",
    "Never give out another guest's details. For an existing reservation you need the confirmation number and the last name on it.",
    "Never promise an upgrade, a refund or a rate the tools did not give you. Refunds follow the cancellation policy the tool reports.",
    "Never say a request outside the tools (an event, a group, a complaint) is arranged; take a message and say the team will follow up.",
    "Stay on hotel topics. Politely decline unrelated requests and offer to take a message instead.",
]

ESCALATION = [
    {
        "action": "transfer",
        "condition": "a guest reports an emergency, a safety problem, an injury, illness, a security concern or a fire or smoke",
        "handoff_summary": "Urgent: {reason}",
    },
    {
        "action": "transfer",
        "condition": "a current guest has a problem with their room or stay that needs help right now",
        "handoff_summary": "Needs a person: {reason}",
    },
    {
        "action": "transfer",
        "condition": "the caller asks for a person, or is upset after two attempts to help",
        "handoff_summary": "Caller asked for a person: {reason}",
    },
    {
        "action": "take_message",
        "condition": "the caller disputes a charge, asks about a bill or a refund the cancellation policy does not cover",
        "handoff_summary": "Billing: {reason}",
    },
    {
        "action": "take_message",
        "condition": "the caller has lost an item or left something behind",
        "handoff_summary": "Lost property: {reason}",
    },
    {
        "action": "take_message",
        "condition": "the caller asks about a group of more than 8 guests, a wedding, a meeting or an event",
        "handoff_summary": "Groups and events: {reason}",
    },
]


def build_config(base: dict[str, Any]) -> dict[str, Any]:
    """The demo hotel agent, keeping the voice and runtime settings of ``base``."""
    cfg = copy.deepcopy(base)
    cfg["adapters"] = {"hotel": {"kind": "mock", "options": options()}}
    cfg["tools"] = copy.deepcopy(TOOLS)
    cfg["policy"] = {**cfg["policy"], "backend_flows": FLOWS, "speaking_rules": SPEAKING_RULES}
    cfg["guardrails"] = list(GUARDRAILS)
    cfg["escalation"] = copy.deepcopy(ESCALATION)
    cfg["web_search"] = {"enabled": True, "location": "Houston, Texas", "max_per_call": 3}
    cfg["persona"] = {
        **cfg["persona"],
        "business_description": "Holiday Hotel is a friendly 120-room hotel in Houston, Texas.",
        "bot_disclosure": "I'm {agent_name}, a virtual assistant for {business}. I can answer questions, check rooms and book your stay.",
    }
    return cfg
