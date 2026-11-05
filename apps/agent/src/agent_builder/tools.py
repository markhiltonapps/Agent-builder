"""Turn data-defined tools into LiveKit function tools bound to adapters."""

from __future__ import annotations

import json
import logging
import re
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from livekit.agents import RunContext, ToolError, function_tool
from livekit.agents.llm import RawFunctionTool

from .adapters import Adapter, ToolFailed, build_adapter
from .compiler import CompiledAgent
from .config import AgentConfig, BookingLink, CalendarBooking, ToolDefinition
from .redact import redact_data
from .votel import VotelError, call_tool, votel_config
from .votel_sync import normalize_phone

log = logging.getLogger("agent_builder.tools")

SLOW_TOOL_SECONDS = 2.0
"""A tool slower than this stalls the caller audibly; the call log flags it."""


@dataclass
class ToolCallRecord:
    tool: str
    args: dict[str, Any]
    ok: bool
    result: Any
    latency_ms: int
    goal: bool

    def __post_init__(self) -> None:
        # What a tool was given and answered is recorded on the call; card details never are.
        self.args = redact_data(self.args)
        self.result = redact_data(self.result)


@dataclass
class CallRecorder:
    """Everything the call record needs from tool use: what ran, how fast, goal reached."""

    calls: list[ToolCallRecord] = field(default_factory=list)
    transferred: bool = False
    transfer_reason: str | None = None

    @property
    def goal_reached(self) -> bool:
        return any(c.goal and c.ok for c in self.calls)

    def to_json(self) -> list[dict[str, Any]]:
        return [asdict(c) for c in self.calls]

    def restore(self, calls: list[dict[str, Any]], transferred: bool, reason: str | None) -> None:
        self.calls = [ToolCallRecord(**c) for c in calls]
        self.transferred = transferred
        self.transfer_reason = reason

    def completed_summary(self, limit: int = 10) -> str:
        """What already happened on this call, in plain lines, for a resumed session.

        The transcript carries this too, but a long call can outgrow what a new session
        accepts, and these are the facts the agent must never redo or contradict.
        """
        lines = []
        for c in [c for c in self.calls if c.ok][-limit:]:
            result = c.result
            ref = result.get("id") if isinstance(result, dict) else None
            args = ", ".join(f"{k}={v}" for k, v in c.args.items())
            lines.append(f"- {c.tool}({args})" + (f" -> {ref}" if ref else ""))
        if self.transferred:
            lines.append(f"- transfer requested: {self.transfer_reason}")
        return "\n".join(lines)


def _make_tool(defn: ToolDefinition, adapter: Adapter, recorder: CallRecorder) -> RawFunctionTool:
    async def handler(raw_arguments: dict[str, object], context: RunContext) -> str:
        args = dict(raw_arguments)
        started = time.perf_counter()
        try:
            result = await adapter.call(defn.name, args)
            ok = True
        except ToolFailed as e:
            result, ok = {"error": str(e)}, False
        except Exception:  # an adapter bug must not kill the call
            log.exception("tool %s crashed", defn.name)
            result, ok = {"error": "internal error"}, False
        latency_ms = int((time.perf_counter() - started) * 1000)
        if latency_ms > SLOW_TOOL_SECONDS * 1000:
            log.warning("tool %s took %d ms", defn.name, latency_ms)
        recorder.calls.append(ToolCallRecord(defn.name, args, ok, result, latency_ms, defn.goal))
        if not ok:
            raise ToolError(f"{defn.name} failed: {result['error']}")
        return json.dumps(result)

    return function_tool(
        handler,
        raw_schema={
            "name": defn.name,
            "description": defn.description,
            "parameters": defn.json_schema(),
        },
    )


def _transfer_tool(cfg: AgentConfig, recorder: CallRecorder) -> RawFunctionTool:
    rules = "; ".join(r.condition for r in cfg.escalation if r.action == "transfer")
    description = "Transfer the caller to a human team member."
    if rules:
        description += f" Use when: {rules}."

    async def handler(raw_arguments: dict[str, object], context: RunContext) -> str:
        recorder.transferred = True
        recorder.transfer_reason = str(raw_arguments.get("reason", ""))
        # A live hand-off needs the phone line set up (a SIP transfer). Until then this only
        # records the request, so the agent must not promise a connection it cannot make: it
        # tells the caller someone will call back and takes their details.
        log.info("transfer requested: %s", recorder.transfer_reason)
        return json.dumps(
            {
                "status": "transfer_requested",
                "connected": False,
                "say": (
                    "I can't put you straight through right now, but I've marked this as "
                    "urgent and someone will call you back."
                ),
                "next": (
                    "Do not say you are connecting or transferring the caller. Say the line "
                    "above, then call take_message with request_type 'urgent' so the team has "
                    "their name and number."
                ),
            }
        )

    return function_tool(
        handler,
        raw_schema={
            "name": "transfer_to_human",
            "description": description,
            "parameters": {
                "type": "object",
                "properties": {
                    "reason": {
                        "type": "string",
                        "description": "One sentence on why the caller needs a person.",
                    }
                },
                "required": ["reason"],
                "additionalProperties": False,
            },
        },
    )


def _message_tool(recorder: CallRecorder) -> RawFunctionTool:
    """Built in: take a message for the team. Recorded on the call, so it is never lost."""

    async def handler(raw_arguments: dict[str, object], context: RunContext) -> str:
        args = {k: str(v).strip() for k, v in raw_arguments.items() if str(v).strip()}
        recorder.calls.append(
            ToolCallRecord("take_message", args, True, {"status": "recorded"}, 0, False)
        )
        return json.dumps({"status": "recorded", "say": "I have that and will pass it on."})

    return function_tool(
        handler,
        raw_schema={
            "name": "take_message",
            "description": (
                "Record a message or request for the team: a callback, an appointment request, "
                "a quote request or an urgent matter. Use it when you cannot finish something "
                "yourself. Read the phone number back to the caller before you call this."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "first_name": {"type": "string", "description": "Caller's first name."},
                    "last_name": {"type": "string", "description": "Caller's last name."},
                    "phone": {"type": "string", "description": "Callback number."},
                    "email": {
                        "type": "string",
                        "description": "Email address, if the caller gave one.",
                    },
                    "reason": {
                        "type": "string",
                        "description": "Why they are calling, in one or two sentences.",
                    },
                    "request_type": {
                        "type": "string",
                        "enum": ["message", "callback", "appointment", "quote", "urgent"],
                        "description": (
                            "What the caller wants: 'appointment' to book a visit, 'quote' for "
                            "a price, 'urgent' when it cannot wait, 'callback' to be called "
                            "back, otherwise 'message'."
                        ),
                    },
                    "best_time": {
                        "type": "string",
                        "description": "Preferred day and time to be called or seen, if said.",
                    },
                    "details": {
                        "type": "string",
                        "description": (
                            "Anything else the team needs, such as the vehicle, the property or "
                            "the service asked about."
                        ),
                    },
                },
                "required": ["first_name", "last_name", "phone", "reason"],
                "additionalProperties": False,
            },
        },
    )


def _booking_tool(
    booking: BookingLink, cfg: AgentConfig, recorder: CallRecorder, caller: Callable[[], str | None]
) -> RawFunctionTool:
    """Send the caller a link to book online, by text or email, through Votel.

    On a phone call the number is already known, so nothing is asked for. If Votel cannot send
    (texting not registered, no email sender), the tool fails and the agent is told to take a
    message instead, so a caller is never promised something that did not happen.
    """
    sms = booking.channel == "sms"
    business = cfg.persona.business_name

    async def handler(raw_arguments: dict[str, object], context: RunContext) -> str:
        args = {k: str(v).strip() for k, v in raw_arguments.items() if str(v).strip()}
        started = time.perf_counter()
        try:
            votel = votel_config()
            if votel is None:
                raise VotelError("Votel is not connected")
            if sms:
                phone = normalize_phone(caller()) or normalize_phone(args.get("phone"))
                if not phone:
                    raise ToolFailed("I need the caller's mobile number first")
                body = f"Thanks for calling {business}. Book a time here: {booking.url}"
                await call_tool(votel, "send_sms", {"to": phone, "body": body})
                sent_to = phone
            else:
                email = args.get("email", "")
                if "@" not in email:
                    raise ToolFailed("I need the caller's email address first")
                body = f"Thanks for calling {business}.\n\nBook a time here: {booking.url}"
                await call_tool(
                    votel,
                    "send_email",
                    {"to": email, "subject": f"Book with {business}", "body": body},
                )
                sent_to = email
            result, ok = {"status": "sent", "sent_to": sent_to, "say": "I've sent that over."}, True
        except ToolFailed as e:
            result, ok = {"error": str(e)}, False
        except VotelError as e:
            log.warning("booking link not sent: %s", e)
            result, ok = {"error": "the message could not be sent right now"}, False
        latency_ms = int((time.perf_counter() - started) * 1000)
        recorder.calls.append(ToolCallRecord("send_booking_link", args, ok, result, latency_ms, ok))
        if not ok:
            raise ToolError(
                f"send_booking_link failed: {result['error']}. Apologize, say a team member will "
                "follow up, and take a message with take_message."
            )
        return json.dumps(result)

    how = "text message" if sms else "email"
    ask = (
        {
            "phone": {
                "type": "string",
                "description": "Mobile number, only if the caller's own number is not known.",
            }
        }
        if sms
        else {
            "email": {
                "type": "string",
                "description": "Email address, read back to the caller first.",
            }
        }
    )
    return function_tool(
        handler,
        raw_schema={
            "name": "send_booking_link",
            "description": f"Send the caller a {how} with a link to book an appointment online themselves. Use when they want to schedule something.",
            "parameters": {
                "type": "object",
                "properties": ask,
                "required": [] if sms else ["email"],
                "additionalProperties": False,
            },
        },
    )


_CLOCK = re.compile(r"^\s*(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?\s*$", re.IGNORECASE)
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_TAKEN = re.compile(
    r"conflict|unavailable|not available|already booked|overlap|taken", re.IGNORECASE
)


def parse_when(date_text: str, time_text: str, tz: str, now: datetime | None = None) -> datetime:
    """The requested start as a timezone-aware time. Raises ToolFailed with a plain reason."""
    zone = ZoneInfo(tz)
    now = now or datetime.now(zone)
    try:
        day = datetime.strptime(date_text.strip(), "%Y-%m-%d").date()
    except ValueError:
        raise ToolFailed("the date must be a real day written as YYYY-MM-DD") from None
    m = _CLOCK.match(time_text)
    if not m:
        raise ToolFailed("the time must be a clock time such as 14:30")
    hour, minute, meridiem = int(m[1]), int(m[2] or 0), (m[3] or "").lower().replace(".", "")
    if meridiem == "pm" and hour < 12:
        hour += 12
    if meridiem == "am" and hour == 12:
        hour = 0
    if hour > 23 or minute > 59:
        raise ToolFailed("the time must be a clock time such as 14:30")
    start = datetime(day.year, day.month, day.day, hour, minute, tzinfo=zone)
    if start <= now:
        raise ToolFailed("that time has already passed; ask for a day and time in the future")
    if start > now + timedelta(days=366):
        raise ToolFailed("that is too far ahead; ask for a date within the next year")
    return start


def _appointment_tool(
    calendar: CalendarBooking,
    cfg: AgentConfig,
    recorder: CallRecorder,
    caller: Callable[[], str | None],
) -> RawFunctionTool:
    """Ask the team's Votel calendar for an appointment. Saved as pending: a person confirms.

    If the calendar cannot take it, the tool fails and the agent is told to take a message, so a
    caller is never promised a slot that was not requested.
    """

    async def handler(raw_arguments: dict[str, object], context: RunContext) -> str:
        args = {k: str(v).strip() for k, v in raw_arguments.items() if str(v).strip()}
        started = time.perf_counter()
        try:
            votel = votel_config()
            if votel is None:
                raise VotelError("Votel is not connected")
            phone = normalize_phone(args.get("phone")) or normalize_phone(caller())
            if not phone:
                raise ToolFailed("I need a phone number for the caller first")
            if not (args.get("first_name") and args.get("last_name")):
                raise ToolFailed("I need the caller's first and last name first")
            tz = cfg.persona.timezone
            start = parse_when(args.get("date", ""), args.get("time", ""), tz)
            end = start + timedelta(minutes=calendar.duration_minutes)
            booking: dict[str, Any] = {
                "booking_config_id": calendar.service_id,
                "starts_at": start.strftime("%Y-%m-%dT%H:%M:%S"),
                "ends_at": end.strftime("%Y-%m-%dT%H:%M:%S"),
                "duration_minutes": calendar.duration_minutes,
                "timezone": tz,
                "client_name": f"{args['first_name']} {args['last_name']}",
                "client_phone": phone,
                "client_notes": args.get("reason", "")[:500],
                "status": "pending",
                "internal_notes": (
                    f"Requested on a call with {cfg.persona.agent_name}, the phone agent. "
                    "Not confirmed: please confirm the time with the caller."
                ),
            }
            if _EMAIL.match(args.get("email", "")):
                booking["client_email"] = args["email"]
            await call_tool(votel, "create_booking", booking)
            when = f"{start.strftime('%A, %B')} {start.day} at {start.strftime('%I:%M %p').lstrip('0')}"
            result, ok = (
                {
                    "status": "requested",
                    "when": when,
                    "say": f"I've put in a request for {when}. The team will confirm it with you.",
                },
                True,
            )
        except ToolFailed as e:
            result, ok = {"error": str(e)}, False
        except VotelError as e:
            log.warning("appointment not requested: %s", e)
            taken = bool(_TAKEN.search(str(e)))
            result, ok = (
                (
                    {"error": "that time is not available", "taken": True}
                    if taken
                    else {"error": "the calendar could not take the request right now"}
                ),
                False,
            )
        latency_ms = int((time.perf_counter() - started) * 1000)
        recorder.calls.append(
            ToolCallRecord("request_appointment", args, ok, result, latency_ms, ok)
        )
        if not ok:
            hint = (
                "Offer a different day or time."
                if result.get("taken")
                or "ask for" in result["error"]
                or "must be" in result["error"]
                else "Apologize, and take the details with take_message using request_type 'appointment'."
            )
            raise ToolError(f"request_appointment failed: {result['error']}. {hint}")
        return json.dumps(result)

    return function_tool(
        handler,
        raw_schema={
            "name": "request_appointment",
            "description": (
                f'Request an appointment for "{calendar.service_name}" on the team\'s calendar. It is '
                "only a request: the team confirms it, so never say it is booked. Read the day, time "
                "and phone number back to the caller before you call this."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "first_name": {"type": "string", "description": "Caller's first name."},
                    "last_name": {"type": "string", "description": "Caller's last name."},
                    "phone": {
                        "type": "string",
                        "description": "Callback number, if different from the number they are calling from.",
                    },
                    "email": {"type": "string", "description": "Email address, if given."},
                    "reason": {"type": "string", "description": "What the appointment is for."},
                    "date": {"type": "string", "description": "The day, as YYYY-MM-DD."},
                    "time": {
                        "type": "string",
                        "description": "The start time, 24-hour, like 14:30.",
                    },
                },
                "required": ["first_name", "last_name", "reason", "date", "time"],
                "additionalProperties": False,
            },
        },
    )


def build_tools(
    cfg: AgentConfig,
    compiled: CompiledAgent,
    recorder: CallRecorder,
    caller: Callable[[], str | None] | None = None,
) -> tuple[list[Any], dict[str, Adapter]]:
    """Return the LiveKit tools for one call and the adapters backing them.

    Adapters are built per call so mock state never leaks between calls.
    """
    adapters = {
        name: build_adapter(name, a)
        for name, a in cfg.adapters.items()
        if a.kind != "disabled" and any(t.adapter == name for t in compiled.tools)
    }
    tools: list[Any] = [_make_tool(t, adapters[t.adapter], recorder) for t in compiled.tools]
    tools.append(_transfer_tool(cfg, recorder))
    tools.append(_message_tool(recorder))
    if cfg.booking:
        tools.append(_booking_tool(cfg.booking, cfg, recorder, caller or (lambda: None)))
    if cfg.calendar:
        tools.append(_appointment_tool(cfg.calendar, cfg, recorder, caller or (lambda: None)))
    return tools, adapters
