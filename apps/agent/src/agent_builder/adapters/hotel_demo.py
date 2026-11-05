"""A pretend hotel for demonstrations: rooms, rates, availability by date, a card payment, bookings, changes.

Nothing here is real. It answers the way a hotel's booking system would, so an agent can be shown taking a
reservation from the first question to a confirmation number:

  check_room_availability   rooms for the dates and party size, each with its rate, tax, total and the deposit
  charge_card               takes the deposit with a TEST card only (anything else is refused, so a real card
                            can never be used by accident); one test card is declined, to show that too
  book_room                 books the room once its deposit has been charged, and returns a confirmation number
  lookup_reservation        finds a booking by confirmation number, or by last name and phone number
  modify_reservation        moves the dates or changes the room
  cancel_reservation        cancels, with the refund the cancellation policy gives
  request_service           early check-in, late check-out, airport shuttle, a crib, an extra bed, a dinner
                            table, a celebration package

Availability and rates are worked out here, not by the language model: the same dates always give the same
answer, weekends cost more, holidays and events change the rate or sell the hotel out, and the arithmetic is
exact. Bookings are remembered between calls (so a person can ring back and ask about theirs) when the
database is reachable, and for the length of the call when it is not.

Enabled by ``"engine": "hotel"`` in a mock adapter's options (see ``demo_hotel.py`` for the settings).
"""

from __future__ import annotations

import copy
import hashlib
import json
import logging
import re
import time
from datetime import UTC, date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Protocol
from zoneinfo import ZoneInfo

import aiohttp

from .. import supabase
from . import ToolFailed

log = logging.getLogger("agent_builder.hotel_demo")

MAX_NIGHTS = 14
MAX_GUESTS = 8
CENT = Decimal("0.01")


def _money(value: Decimal | float) -> Decimal:
    return Decimal(str(value)).quantize(CENT, rounding=ROUND_HALF_UP)


def _text(value: Decimal) -> str:
    return f"${value:,.2f}"


def _parse_date(raw: Any, field: str) -> date:
    try:
        return date.fromisoformat(str(raw).strip()[:10])
    except ValueError:
        raise ToolFailed(f"{field} must be a date written YYYY-MM-DD") from None


def _hour(text: str) -> float | None:
    """The clock time in a phrase such as "2 pm", "2:30" or "14:00", as hours since midnight (None if there is none).
    A bare 1 to 6 means the afternoon."""
    m = re.search(r"\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?", text.lower())
    if not m:
        return None
    hour, minute, mer = int(m.group(1)), int(m.group(2) or 0), (m.group(3) or "").replace(".", "")
    if hour > 24 or minute > 59:
        return None
    if mer == "pm" and hour < 12:
        hour += 12
    elif mer == "am" and hour == 12:
        hour = 0
    elif not mer and 1 <= hour <= 6:
        hour += 12
    return hour + minute / 60


def _digits(raw: Any) -> str:
    return re.sub(r"\D", "", str(raw or ""))


class ReservationStore(Protocol):
    """Where bookings live between calls."""

    async def get(self, scope: str, confirmation: str) -> dict[str, Any] | None: ...
    async def find(self, scope: str, last_name: str, phone_digits: str) -> list[dict[str, Any]]: ...
    async def put(self, scope: str, confirmation: str, data: dict[str, Any]) -> None: ...


class MemoryStore:
    def __init__(self) -> None:
        self.rows: dict[tuple[str, str], dict[str, Any]] = {}

    async def get(self, scope: str, confirmation: str) -> dict[str, Any] | None:
        row = self.rows.get((scope, confirmation))
        return copy.deepcopy(row) if row else None

    async def find(self, scope: str, last_name: str, phone_digits: str) -> list[dict[str, Any]]:
        return [
            copy.deepcopy(r)
            for (s, _), r in self.rows.items()
            if s == scope and _matches_guest(r, last_name, phone_digits)
        ]

    async def put(self, scope: str, confirmation: str, data: dict[str, Any]) -> None:
        self.rows[(scope, confirmation)] = copy.deepcopy(data)


class SupabaseStore:
    """Rows in ``public.demo_reservations`` (the secret key only). Every failure is swallowed: a booking is
    still made for the length of the call if the database cannot be reached."""

    def __init__(self, url: str, key: str, *, timeout_s: float = 4.0) -> None:
        self._base = f"{url.rstrip('/')}/rest/v1/demo_reservations"
        self._headers = supabase.headers(key)
        self._timeout = aiohttp.ClientTimeout(total=timeout_s)

    async def get(self, scope: str, confirmation: str) -> dict[str, Any] | None:
        try:
            async with (
                aiohttp.ClientSession(timeout=self._timeout) as http,
                http.get(
                    self._base,
                    params={
                        "scope": f"eq.{scope}",
                        "confirmation": f"eq.{confirmation}",
                        "select": "data",
                    },
                    headers=self._headers,
                ) as r,
            ):
                if r.status >= 300:
                    return None
                rows = await r.json()
            return rows[0]["data"] if rows else None
        except (aiohttp.ClientError, TimeoutError, ValueError):
            log.warning("could not read a demo reservation", exc_info=True)
            return None

    async def find(self, scope: str, last_name: str, phone_digits: str) -> list[dict[str, Any]]:
        try:
            async with (
                aiohttp.ClientSession(timeout=self._timeout) as http,
                http.get(
                    self._base,
                    params={
                        "scope": f"eq.{scope}",
                        "select": "data",
                        "order": "updated_at.desc",
                        "limit": "200",
                    },
                    headers=self._headers,
                ) as r,
            ):
                if r.status >= 300:
                    return []
                rows = await r.json()
        except (aiohttp.ClientError, TimeoutError, ValueError):
            log.warning("could not search demo reservations", exc_info=True)
            return []
        return [row["data"] for row in rows if _matches_guest(row["data"], last_name, phone_digits)]

    async def put(self, scope: str, confirmation: str, data: dict[str, Any]) -> None:
        try:
            async with (
                aiohttp.ClientSession(timeout=self._timeout) as http,
                http.post(
                    self._base,
                    params={"on_conflict": "scope,confirmation"},
                    data=json.dumps(
                        {
                            "scope": scope,
                            "confirmation": confirmation,
                            "data": data,
                            "updated_at": datetime.now(UTC).isoformat(),
                        },
                        default=str,
                    ),
                    headers={
                        **self._headers,
                        "Prefer": "resolution=merge-duplicates,return=minimal",
                    },
                ) as r,
            ):
                if r.status >= 300:
                    log.warning("could not save a demo reservation: HTTP %s", r.status)
        except (aiohttp.ClientError, TimeoutError):
            log.warning("could not save a demo reservation", exc_info=True)


def _matches_guest(record: dict[str, Any], last_name: str, phone_digits: str) -> bool:
    guest = record.get("guest", {})
    if last_name and guest.get("last_name", "").strip().lower() != last_name.strip().lower():
        return False
    if phone_digits and not _digits(guest.get("phone")).endswith(phone_digits[-10:]):
        return False
    return bool(last_name or phone_digits)


def default_store() -> ReservationStore:
    creds = supabase.credentials()
    return SupabaseStore(*creds) if creds else MemoryStore()


class HotelDemoAdapter:
    def __init__(
        self, name: str, options: dict[str, Any], store: ReservationStore | None = None
    ) -> None:
        self.name = name
        self.o = options
        self.scope = str(options.get("scope", name))
        self.prefix = str(options.get("prefix", "HH"))
        self.rooms: list[dict[str, Any]] = options["rooms"]
        self.tax = Decimal(str(options.get("tax_rate", 0.12)))
        self.tz = ZoneInfo(str(options.get("timezone", "America/Chicago")))
        self.store = store if store is not None else default_store()
        self.state: dict[str, Any] = {
            "reservations": {
                r["confirmation"]: copy.deepcopy(r) for r in options.get("reservations", [])
            },
            "charges": [],
        }

    # --- time -------------------------------------------------------------------------------

    def _now(self) -> datetime:
        fixed = self.o.get("now")  # tests and rehearsals can pin the clock
        if fixed:
            return datetime.fromisoformat(str(fixed)).replace(tzinfo=self.tz)
        return datetime.now(self.tz)

    # --- the calendar: who is in the hotel on a night ------------------------------------------

    def _sold_out(self, night: date) -> str | None:
        for rule in self.o.get("sold_out", []):
            if date.fromisoformat(rule["from"]) <= night <= date.fromisoformat(rule["to"]):
                return str(rule.get("reason", "a big local event"))
        return None

    @staticmethod
    def _busy(room: dict[str, Any], night: date) -> float:
        """How full this kind of room is on a night, 0 to 0.85: the same answer every time, fuller at weekends."""
        h = (
            int(hashlib.sha256(f"{room['type']}|{night.isoformat()}".encode()).hexdigest()[:8], 16)
            / 0xFFFFFFFF
        )
        low, high = (0.35, 0.85) if night.weekday() in (4, 5) else (0.10, 0.55)
        return low + (high - low) * h

    def _left(self, room: dict[str, Any], night: date) -> int:
        if self._sold_out(night):
            return 0
        taken = round(int(room["count"]) * self._busy(room, night))
        return max(int(room["count"]) - taken, 0)

    def _rate(self, room: dict[str, Any], night: date) -> Decimal:
        rate = Decimal(str(room["base_rate"]))
        if night.weekday() in (4, 5):
            rate += Decimal(str(room.get("weekend_surcharge", self.o.get("weekend_surcharge", 0))))
        for h in self.o.get("holiday_surcharges", []):
            if date.fromisoformat(h["from"]) <= night <= date.fromisoformat(h["to"]):
                rate += Decimal(str(h["amount"]))
        return rate

    # --- a quote -----------------------------------------------------------------------------

    def _dates(self, args: dict[str, Any]) -> tuple[date, date, int]:
        check_in = _parse_date(args.get("check_in"), "check_in")
        check_out = _parse_date(args.get("check_out"), "check_out")
        today = self._now().date()
        if check_in < today:
            raise ToolFailed(
                f"check_in is in the past (today is {today.isoformat()}); ask for a date from today on"
            )
        if check_out <= check_in:
            raise ToolFailed("check_out must be after check_in")
        nights = (check_out - check_in).days
        if nights > MAX_NIGHTS:
            raise ToolFailed(
                f"stays are booked up to {MAX_NIGHTS} nights; for longer, take a message for the team"
            )
        return check_in, check_out, nights

    def _promo(self, code: Any) -> tuple[str, Decimal, str] | None:
        key = str(code or "").strip().upper()
        if not key:
            return None
        promo = self.o.get("promos", {}).get(key)
        if promo is None:
            raise ToolFailed(f"the promo code {key} is not valid")
        return key, Decimal(str(promo["percent"])), str(promo.get("label", key))

    def _quote(
        self,
        room: dict[str, Any],
        check_in: date,
        nights: int,
        promo: tuple[str, Decimal, str] | None,
    ) -> dict[str, Any]:
        rates = [self._rate(room, check_in + timedelta(days=i)) for i in range(nights)]
        subtotal = sum(rates, Decimal(0))
        pct = promo[1] if promo else Decimal(0)
        discount = _money(subtotal * pct / 100)
        after = subtotal - discount
        tax = _money(after * self.tax)
        total = after + tax
        first = _money(rates[0] - rates[0] * pct / 100)
        deposit = first + _money(first * self.tax)
        return {
            "nightly_rates": [_text(r) for r in rates],
            "room_total_before_tax": _text(_money(subtotal)),
            "promo_discount": _text(discount) if promo else None,
            "tax": _text(tax),
            "total_with_tax": _text(total),
            "deposit_due_now": _text(deposit),
            "balance_due_at_check_in": _text(total - deposit),
            "_total": total,
            "_deposit": deposit,
        }

    def _stay_left(self, room: dict[str, Any], check_in: date, nights: int) -> int:
        return min(self._left(room, check_in + timedelta(days=i)) for i in range(nights))

    def _find_room(self, name: Any) -> dict[str, Any]:
        wanted = str(name or "").strip().lower()
        for r in self.rooms:
            if r["type"].lower() == wanted:
                return r
        hits = [r for r in self.rooms if wanted and wanted in r["type"].lower()]
        if len(hits) == 1:
            return hits[0]
        raise ToolFailed(
            f"there is no room type called {name!r}; the types are: {', '.join(r['type'] for r in self.rooms)}"
        )

    def _min_stay(self, check_in: date, check_out: date, nights: int) -> str | None:
        for rule in self.o.get("min_stay", []):
            day = date.fromisoformat(rule["includes"])
            if check_in <= day < check_out and nights < int(rule["nights"]):
                return f"{rule['reason']}: a minimum stay of {rule['nights']} nights applies to these dates"
        return None

    # --- tools -------------------------------------------------------------------------------

    async def call(self, tool: str, args: dict[str, Any]) -> dict[str, Any]:
        handler = getattr(self, f"_t_{tool}", None)
        if handler is None:
            raise ToolFailed(f"the hotel system has no tool called {tool!r}")
        return await handler(args)

    async def _t_check_room_availability(self, a: dict[str, Any]) -> dict[str, Any]:
        check_in, check_out, nights = self._dates(a)
        try:
            guests = int(a.get("guests", 0))
        except (TypeError, ValueError):
            raise ToolFailed("guests must be a number") from None
        if not 1 <= guests <= MAX_GUESTS:
            raise ToolFailed(
                f"guests must be from 1 to {MAX_GUESTS}; for a bigger group take a message for the team"
            )
        promo = self._promo(a.get("promo_code"))
        rooms = [self._find_room(a["room_type"])] if a.get("room_type") else self.rooms
        offered, not_offered = [], []
        for r in rooms:
            if guests > int(r["max_guests"]):
                not_offered.append(f"{r['type']} (sleeps {r['max_guests']})")
                continue
            left = self._stay_left(r, check_in, nights)
            entry: dict[str, Any] = {
                "room_type": r["type"],
                "beds": r["beds"],
                "sleeps": r["max_guests"],
                "details": r.get("details", ""),
                "availability": "sold out"
                if left == 0
                else (f"only {left} left" if left <= 2 else "available"),
            }
            if left:
                q = self._quote(r, check_in, nights, promo)
                entry |= {k: v for k, v in q.items() if not k.startswith("_")}
            offered.append(entry)
        notices = []
        if event := next(
            (
                self._sold_out(check_in + timedelta(days=i))
                for i in range(nights)
                if self._sold_out(check_in + timedelta(days=i))
            ),
            None,
        ):
            notices.append(
                f"The hotel is sold out on some of these nights because of {event}. Suggest other dates."
            )
        if minimum := self._min_stay(check_in, check_out, nights):
            notices.append(minimum)
        result: dict[str, Any] = {
            "check_in": check_in.isoformat(),
            "check_out": check_out.isoformat(),
            "nights": nights,
            "guests": guests,
            "check_in_day": check_in.strftime("%A"),
            "check_out_day": check_out.strftime("%A"),
            "rooms": offered,
            "notices": notices,
            "payment": "A deposit of the first night plus tax is charged now to guarantee the room; the balance is paid at check-in.",
            "cancellation": f"Free to cancel until {self.o.get('free_cancel_hours', 48)} hours before check-in; after that the deposit is kept.",
        }
        if promo:
            result["promo_applied"] = f"{promo[2]}: {promo[1]}% off the room rate"
        if not_offered:
            result["too_small_for_this_party"] = not_offered
        if all(e["availability"] == "sold out" for e in offered) or minimum:
            result["bookable"] = False
        else:
            result["bookable"] = True
        return result

    async def _t_charge_card(self, a: dict[str, Any]) -> dict[str, Any]:
        number = _digits(a.get("card_number"))
        cards = {c["number"]: c for c in self.o.get("test_cards", [])}
        try:
            amount = _money(Decimal(str(a.get("amount"))))
        except (ArithmeticError, ValueError):
            raise ToolFailed("amount must be a number of dollars") from None
        if not Decimal(1) <= amount <= Decimal(5000):
            raise ToolFailed("amount must be between $1 and $5,000")
        if number not in cards:
            return {
                "approved": False,
                "reason": "not_a_test_card",
                "message": "This is a demonstration line and it can only take the published test cards, never a real card. "
                "Ask the caller to use a test card, for example 4242 4242 4242 4242 (Visa) with any future expiry and any 3-digit code.",
            }
        card = cards[number]
        brand = str(card["brand"])
        exp = _digits(a.get("expiry"))
        if len(exp) not in (4, 6):
            return {
                "approved": False,
                "reason": "invalid_expiry",
                "message": "The expiry date must be a month and year, like 08/28.",
            }
        month, year = int(exp[:2]), int(exp[2:]) + (2000 if len(exp) == 4 else 0)
        today = self._now().date()
        if not 1 <= month <= 12 or (year, month) < (today.year, today.month):
            return {
                "approved": False,
                "reason": "card_expired",
                "message": "That card's expiry date has passed or is not valid.",
            }
        cvv = _digits(a.get("cvv"))
        if len(cvv) != (4 if brand.lower() == "amex" else 3):
            return {
                "approved": False,
                "reason": "invalid_security_code",
                "message": f"The security code should be {4 if brand.lower() == 'amex' else 3} digits.",
            }
        if len(_digits(a.get("billing_zip"))) != 5:
            return {
                "approved": False,
                "reason": "invalid_zip",
                "message": "The billing ZIP code should be 5 digits.",
            }
        last4 = number[-4:]
        if card.get("result") != "approved":
            return {
                "approved": False,
                "reason": "declined",
                "last4": last4,
                "brand": brand,
                "message": str(card.get("message", "The card was declined by the bank."))
                + " Offer to try another card.",
            }
        n = len(self.state["charges"])
        auth = (
            "A"
            + hashlib.sha256(f"{last4}|{amount}|{n}|{self.scope}".encode()).hexdigest()[:6].upper()
        )
        self.state["charges"].append(
            {
                "auth_code": auth,
                "last4": last4,
                "brand": brand,
                "amount": str(amount),
                "used": False,
            }
        )
        return {
            "approved": True,
            "authorization_code": auth,
            "brand": brand,
            "last4": last4,
            "amount_charged": _text(amount),
            "receipt": "The charge is the deposit; the balance is due at check-in.",
        }

    def _new_confirmation(self) -> str:
        base = int(time.time()) % 90000 + 10000
        while f"{self.prefix}-{base}" in self.state["reservations"]:
            base += 1
        return f"{self.prefix}-{base}"

    async def _t_book_room(self, a: dict[str, Any]) -> dict[str, Any]:
        check_in, check_out, nights = self._dates(a)
        room = self._find_room(a.get("room_type"))
        try:
            guests = int(a.get("guests", 0))
        except (TypeError, ValueError):
            raise ToolFailed("guests must be a number") from None
        if not 1 <= guests <= int(room["max_guests"]):
            raise ToolFailed(f"the {room['type']} sleeps up to {room['max_guests']} guests")
        first, last = str(a.get("first_name", "")).strip(), str(a.get("last_name", "")).strip()
        phone = _digits(a.get("phone"))
        if not first or not last:
            raise ToolFailed("both the first and last name are needed")
        if len(phone) < 10:
            raise ToolFailed("a full phone number is needed")
        if minimum := self._min_stay(check_in, check_out, nights):
            raise ToolFailed(minimum)
        if self._stay_left(room, check_in, nights) == 0:
            raise ToolFailed(
                f"the {room['type']} is sold out for these dates; offer another room or other dates"
            )
        promo = self._promo(a.get("promo_code"))
        q = self._quote(room, check_in, nights, promo)
        auth = str(a.get("payment_authorization", "")).strip().upper()
        charge = next(
            (c for c in self.state["charges"] if c["auth_code"] == auth and not c["used"]), None
        )
        if charge is None:
            raise ToolFailed(
                f"the deposit of {_text(q['_deposit'])} has not been charged yet: take the card with charge_card first, then pass its authorization code"
            )
        if abs(Decimal(charge["amount"]) - q["_deposit"]) > CENT:
            raise ToolFailed(
                f"the amount charged ({_text(Decimal(charge['amount']))}) is not the deposit due ({_text(q['_deposit'])})"
            )
        charge["used"] = True
        confirmation = self._new_confirmation()
        deadline = datetime.combine(check_in, datetime.min.time()).replace(
            hour=15, tzinfo=self.tz
        ) - timedelta(hours=int(self.o.get("free_cancel_hours", 48)))
        record = {
            "confirmation": confirmation,
            "status": "confirmed",
            "guest": {
                "first_name": first,
                "last_name": last,
                "phone": phone,
                "email": str(a.get("email", "")).strip(),
            },
            "room_type": room["type"],
            "check_in": check_in.isoformat(),
            "check_out": check_out.isoformat(),
            "nights": nights,
            "guests": guests,
            "special_requests": str(a.get("special_requests", "")).strip(),
            "promo": promo[0] if promo else None,
            "total_with_tax": q["total_with_tax"],
            "deposit_paid": q["deposit_due_now"],
            "balance_due_at_check_in": q["balance_due_at_check_in"],
            "paid_with": f"{charge['brand']} ending {charge['last4']}",
            "authorization_code": charge["auth_code"],
            "free_cancellation_until": deadline.isoformat(),
            "services": [],
            "booked_at": self._now().isoformat(),
        }
        self.state["reservations"][confirmation] = record
        await self.store.put(self.scope, confirmation, record)
        return {
            "booked": True,
            **self._view(record),
            "check_in_time": self.o.get("check_in_time", "3 pm"),
            "check_out_time": self.o.get("check_out_time", "11 am"),
        }

    @staticmethod
    def _view(r: dict[str, Any]) -> dict[str, Any]:
        return {
            "confirmation_number": r["confirmation"],
            "status": r["status"],
            "guest": f"{r['guest']['first_name']} {r['guest']['last_name']}",
            "room_type": r["room_type"],
            "check_in": r["check_in"],
            "check_out": r["check_out"],
            "nights": r["nights"],
            "guests": r["guests"],
            "special_requests": r.get("special_requests", ""),
            "total_with_tax": r["total_with_tax"],
            "deposit_paid": r["deposit_paid"],
            "balance_due_at_check_in": r["balance_due_at_check_in"],
            "paid_with": r.get("paid_with", ""),
            "free_cancellation_until": r.get("free_cancellation_until", ""),
            "extras": [s["service"] for s in r.get("services", [])],
        }

    async def _load(self, args: dict[str, Any]) -> dict[str, Any] | None:
        raw = str(args.get("confirmation_number", "")).upper()
        if raw:
            digits = _digits(raw)
            key = f"{self.prefix}-{digits}" if digits else raw.strip()
            found = self.state["reservations"].get(key) or await self.store.get(self.scope, key)
            if found:
                self.state["reservations"][key] = found
            last = str(args.get("last_name", "")).strip().lower()
            if not last:
                raise ToolFailed("also ask for the last name on the reservation, then try again")
            if found and found["guest"]["last_name"].strip().lower() != last:
                return None  # a confirmation number with the wrong name is not a match
            return found
        last, phone = str(args.get("last_name", "")).strip(), _digits(args.get("phone"))
        if not last and not phone:
            return None
        hits = [r for r in self.state["reservations"].values() if _matches_guest(r, last, phone)]
        hits += [
            r
            for r in await self.store.find(self.scope, last, phone)
            if r["confirmation"] not in {h["confirmation"] for h in hits}
        ]
        upcoming = sorted(
            (h for h in hits if h["status"] == "confirmed"), key=lambda h: h["check_in"]
        )
        return (upcoming or hits or [None])[0]

    async def _t_lookup_reservation(self, a: dict[str, Any]) -> dict[str, Any]:
        found = await self._load(a)
        if found is None:
            return {
                "found": False,
                "message": "No reservation matches. Check the confirmation number and the last name, or search by last name and phone number.",
            }
        return {"found": True, **self._view(found)}

    def _need(self, record: dict[str, Any] | None) -> dict[str, Any]:
        if record is None:
            raise ToolFailed("no reservation matches that confirmation number and last name")
        if record["status"] != "confirmed":
            raise ToolFailed(f"that reservation is {record['status']}")
        return record

    async def _t_cancel_reservation(self, a: dict[str, Any]) -> dict[str, Any]:
        r = self._need(await self._load(a))
        free_until = datetime.fromisoformat(r["free_cancellation_until"])
        free = self._now() <= free_until
        r["status"] = "cancelled"
        r["cancelled_at"] = self._now().isoformat()
        r["refund"] = r["deposit_paid"] if free else "$0.00"
        await self.store.put(self.scope, r["confirmation"], r)
        return {
            "cancelled": True,
            "confirmation_number": r["confirmation"],
            "refund_amount": r["refund"],
            "refund_note": (
                "The deposit goes back to the card, ending "
                + r.get("paid_with", "").split()[-1]
                + ", in 3 to 5 business days."
            )
            if free
            else f"This is inside the free-cancellation window, so the deposit of {r['deposit_paid']} (the first night) is kept.",
        }

    async def _t_modify_reservation(self, a: dict[str, Any]) -> dict[str, Any]:
        r = self._need(await self._load(a))
        check_in = _parse_date(a.get("new_check_in") or r["check_in"], "new_check_in")
        check_out = _parse_date(a.get("new_check_out") or r["check_out"], "new_check_out")
        room = self._find_room(a.get("new_room_type") or r["room_type"])
        args = {"check_in": check_in.isoformat(), "check_out": check_out.isoformat()}
        _, _, nights = self._dates(args)
        if int(r["guests"]) > int(room["max_guests"]):
            raise ToolFailed(f"the {room['type']} sleeps up to {room['max_guests']} guests")
        if minimum := self._min_stay(check_in, check_out, nights):
            raise ToolFailed(minimum)
        if self._stay_left(room, check_in, nights) == 0:
            raise ToolFailed(
                f"the {room['type']} is not available for those dates; offer other dates or another room"
            )
        q = self._quote(room, check_in, nights, self._promo(r.get("promo")))
        r.update(
            {
                "room_type": room["type"],
                "check_in": check_in.isoformat(),
                "check_out": check_out.isoformat(),
                "nights": nights,
                "total_with_tax": _text(q["_total"]),
                "balance_due_at_check_in": _text(
                    q["_total"] - Decimal(r["deposit_paid"].replace("$", "").replace(",", ""))
                ),
            }
        )
        r["free_cancellation_until"] = (
            datetime.combine(check_in, datetime.min.time()).replace(hour=15, tzinfo=self.tz)
            - timedelta(hours=int(self.o.get("free_cancel_hours", 48)))
        ).isoformat()
        await self.store.put(self.scope, r["confirmation"], r)
        return {
            "modified": True,
            **self._view(r),
            "note": "The deposit already paid stays on the reservation; the new balance is due at check-in.",
        }

    async def _t_request_service(self, a: dict[str, Any]) -> dict[str, Any]:
        r = self._need(await self._load(a))
        service = str(a.get("service", "")).strip().lower()
        services = self.o.get("services", {})
        spec = services.get(service)
        if spec is None:
            raise ToolFailed(f"the services are: {', '.join(services)}")
        detail = str(a.get("details", "")).strip()
        fee = Decimal(str(spec.get("fee", 0)))
        per = spec.get("per")
        if per == "guest":
            fee *= int(r["guests"])
        elif per == "night":
            fee *= int(r["nights"])
        if spec.get("needs") and not detail:
            raise ToolFailed(f"ask the guest for: {spec['needs']}")
        if service == "late_check_out":
            hour = _hour(detail)
            if hour is None:
                raise ToolFailed(
                    "ask for the time they would like to leave, such as 1 pm or 2:30 pm"
                )
            if hour > float(spec.get("fee_until", 15)):
                return {
                    "requested": False,
                    "service": service,
                    "status": "not available",
                    "fee": "no charge",
                    "note": "The latest late check-out is 3 pm. Offer 3 pm or earlier.",
                }
            fee = (
                Decimal(str(spec.get("fee_amount", 30)))
                if hour > float(spec.get("free_until", 13))
                else Decimal(0)
            )
        entry = {
            "service": service,
            "details": detail,
            "fee": _text(fee),
            "requested_at": self._now().isoformat(),
        }
        r.setdefault("services", []).append(entry)
        await self.store.put(self.scope, r["confirmation"], r)
        return {
            "requested": True,
            "service": service,
            "status": spec.get("status", "confirmed"),
            "fee": _text(fee) if fee else "no charge",
            "fee_is_added_to": "the balance paid at check-in" if fee else None,
            "note": spec.get("note", ""),
            "reference": f"{self.prefix}-S{int(hashlib.sha256(f'{r["confirmation"]}|{service}|{detail}'.encode()).hexdigest()[:6], 16) % 9000 + 1000}",
        }

    # --- carrying the call across a restart -----------------------------------------------------

    def snapshot(self) -> dict[str, Any]:
        return {"state": copy.deepcopy(self.state)}

    def restore(self, snap: dict[str, Any]) -> None:
        self.state = copy.deepcopy(snap.get("state", self.state))
