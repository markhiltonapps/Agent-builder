# Demo hotel: how to run it

Holiday Hotel in Houston is a made-up hotel with a made-up booking system, to show an agent taking a
reservation from the first question to a confirmation number. Nothing is real: no room is held, no card is
charged, no email is sent.

## Before the demo (10 minutes)

1. In the app, open the **Test Hotel** client, then **Agents**, then **Hospitality receptionist**, and check it says
   Live. Press **Test call** and run through one booking by voice, start to finish.
2. Open **Knowledge** and check the six hotel documents are there (overview, rooms and rates, policies, dining and
   amenities, location, common questions). In the agent's **Actions**, check **Let the agent look things up on the web** is on, with Houston, Texas.
3. For a real phone call: **Phone numbers**, rent a number and give it to the agent. (The free LiveKit plan has one
   number and 50 phone minutes a month: upgrade to Ship before a customer demo.)
4. Have a second device ready in case the phone line or the room Wi-Fi misbehaves.

## Cards: test cards only

The agent takes the deposit through a pretend payment step that accepts **only the published test cards**. Anything
else, such as a real card, is refused and never kept. Say any future expiry and any 3 digits (4 for Amex):

| Card | Number | Result |
|---|---|---|
| Visa | 4242 4242 4242 4242 | approved |
| Mastercard | 5555 5555 5555 4444 | approved |
| American Express | 3782 822463 10005 | approved (4-digit code) |
| Discover | 6011 1111 1111 1117 | approved |
| Visa | 4000 0000 0000 0002 | declined (shows how it handles a decline) |
| Visa | 4000 0000 0000 9995 | declined, insufficient funds |

Card numbers and security codes are removed from transcripts, call records and saved conversations. The agent says
back only the last four digits.

## A call that shows everything

1. "Hi, I'd like to book a room for next weekend." (the agent asks the dates and guests)
2. Ask about the area: "I want to play some golf while I'm there. What's good nearby?" The agent says "let me look that
   up", searches the web like Google, and answers with where it found it. Try restaurants, things to do, or "how do I
   get there from the airport?" too.
3. Pick a room, give a name and phone number, mention an anniversary.
4. Give a test card and a billing ZIP. It repeats only the last four digits, confirms the deposit and gives the
   confirmation number.
5. Ask for a late check-out, an airport shuttle (give a flight number) or a dinner table at the Holiday Grill.
6. Hang up, ring back and ask about the booking by name and phone number: it finds it.

## Other things worth showing

- **Sold out:** ask for November 20 to 22 (a large convention). It explains and suggests other dates.
- **Minimum stay:** ask for one night on December 31.
- **Promo codes:** WELCOME10 (10 percent), MILITARY (15 percent), AAA (10 percent).
- **Weekend and holiday rates:** weekends add $30 a night; Christmas and Thanksgiving week cost more.
- **Declined card:** use 4000 0000 0000 0002.
- **Existing reservations** to look up, change or cancel: confirmation HH-48213, last name Johnson (Deluxe King,
  November 14 to 16, free to cancel); and HH-47790, last name Patel (Family Suite, December 2 to 6).
- **Cancellation:** it tells the caller whether the deposit is refunded or kept, by the 48-hour rule.

## What is pretend

Room availability is worked out by date from a fixed pattern (the same dates always give the same answer;
weekends fill faster). Bookings are saved so a second call can find them. Dates for the convention, holidays and New
Year's Eve are in 2026; after those pass, the agent still works but those examples will no longer be sold out.

## Rebuilding it

The settings, tools and conversation rules are in `apps/agent/src/agent_builder/demo_hotel.py` and the booking
system in `apps/agent/src/agent_builder/adapters/hotel_demo.py`. The six documents the agent answers from are in
`apps/agent/demo/hotel/`: upload them under **Knowledge** for the client.
