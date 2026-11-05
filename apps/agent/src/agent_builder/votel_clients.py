"""Clients, two ways, between this app and Votel's contacts.

A client here (a workspace) is linked to one Votel contact. The contact carries the tag
``agent-builder-client``, which is how Votel says "this one is a client of the builder".

* Votel to here: list the tagged contacts, read one, so the app can add it as a client.
* Here to Votel: create (or find) the contact for a client, tag it, and remember its id.
* After a call: a one-line note on the client's contact (never the caller's details).

Nothing here deletes anything in Votel. Removing a client here leaves its contact alone.
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass

from .votel import UUID, VotelConfig, VotelError, call_tool, first_id
from .votel_sync import normalize_phone

TAG = "agent-builder-client"
PAGE = 100

# "- Name | email: a@b.c | phone: None | stage: lead | tags: x, y | created: 2026-11-05 | id: <uuid>"
_LINE = re.compile(
    rf"^-\s+(?P<name>.+?)\s+\|(?P<rest>.*\|)?\s*id:\s*(?P<id>{UUID.pattern})\s*$", re.IGNORECASE
)
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


@dataclass(frozen=True)
class VotelClient:
    id: str
    name: str
    email: str = ""
    phone: str = ""

    def to_json(self) -> dict[str, str]:
        return {"id": self.id, "name": self.name, "email": self.email, "phone": self.phone}


def _field(rest: str, key: str) -> str:
    m = re.search(rf"(?:^|\|)\s*{key}:\s*([^|]*)", rest)
    value = m.group(1).strip() if m else ""
    return "" if value.lower() in ("none", "—", "-") else value


def parse_clients(text: str) -> list[VotelClient]:
    """Votel lists contacts as text, one per line; names arrive HTML-escaped."""
    found = []
    for line in text.splitlines():
        m = _LINE.match(line.strip())
        if m:
            rest = m["rest"] or ""
            found.append(
                VotelClient(
                    id=m["id"].lower(),
                    name=html.unescape(m["name"]).strip(),
                    email=_field(rest, "email"),
                    phone=_field(rest, "phone"),
                )
            )
    return found


async def list_clients(cfg: VotelConfig) -> list[VotelClient]:
    """Every contact in Votel that carries the client tag."""
    text = await call_tool(cfg, "list_contacts", {"tags": [TAG], "limit": PAGE})
    return parse_clients(text)


def parse_contact(text: str) -> tuple[VotelClient, bool]:
    """(client, has the tag) from get_contact's text. A company name, if any, is the client's name."""
    lines = {}
    for raw in text.splitlines():
        key, sep, value = raw.strip().partition(":")
        if sep:
            lines.setdefault(key.strip().lower(), value.strip())
    head = html.unescape(lines.get("contact", "")).strip()
    company = html.unescape(lines.get("company", "")).strip()
    cid = (lines.get("id") or first_id(text) or "").lower()
    tags = [t.strip().lower() for t in lines.get("tags", "").split(",") if t.strip()]
    email = lines.get("email", "")
    phone = lines.get("phone", "")
    return (
        VotelClient(
            id=cid,
            name=company or head,
            email="" if email.lower() == "none" else email,
            phone="" if phone.lower() == "none" else phone,
        ),
        TAG in tags,
    )


async def fetch_client(cfg: VotelConfig, contact_id: str) -> VotelClient:
    """Read one tagged contact. A contact without the tag is refused: it is not a client."""
    if not UUID.fullmatch(contact_id.strip()):
        raise VotelError("not a Votel contact id")
    client, tagged = parse_contact(await call_tool(cfg, "get_contact", {"contact_id": contact_id}))
    if not client.id or not client.name:
        raise VotelError("Votel did not return that contact")
    if not tagged:
        raise VotelError(f"that contact does not have the {TAG} tag")
    return client


async def push_client(
    cfg: VotelConfig,
    *,
    name: str,
    email: str | None = None,
    phone: str | None = None,
    contact_id: str | None = None,
    app_url: str | None = None,
) -> str:
    """Make sure this client has a tagged contact in Votel, and return its id.

    An existing link is kept (and re-tagged if the tag was removed). A new one is created, or an
    existing contact with the same email or phone is found and tagged; Votel does not duplicate.
    """
    if contact_id:
        try:
            await call_tool(cfg, "add_contact_tags", {"contact_id": contact_id, "tags": [TAG]})
            return contact_id
        except VotelError:
            pass  # the contact was deleted in Votel: make a new one below
    fields: dict[str, object] = {"first_name": name[:120], "company": name[:200], "tags": [TAG]}
    if email and _EMAIL.match(email.strip()):
        fields["email"] = email.strip()
    if phone and (p := normalize_phone(phone)):
        fields["phone"] = p
    made = first_id(await call_tool(cfg, "create_contact", fields))
    if not made:
        raise VotelError("Votel did not return a contact id")
    # An existing contact (same email or phone) comes back untouched: make sure it is tagged.
    await call_tool(cfg, "add_contact_tags", {"contact_id": made, "tags": [TAG]})
    if app_url:
        await call_tool(
            cfg,
            "add_note",
            {
                "contact_id": made,
                "subject": "Agent Builder client",
                "note": f"This client has its own workspace in Agent Builder: {name}.\n"
                f"Agents, calls and numbers: {app_url.rstrip('/')}/clients",
            },
        )
    return made


async def note_call(
    cfg: VotelConfig, contact_id: str, *, agent: str, outcome: str, link: str
) -> None:
    """A one-line note on the client's contact for a finished call. Never raises."""
    try:
        await call_tool(
            cfg,
            "add_note",
            {
                "contact_id": contact_id,
                "subject": f"Call: {agent}",
                "note": f"{agent} took a call. {outcome}\n{link}".strip(),
            },
        )
    except VotelError:
        pass
