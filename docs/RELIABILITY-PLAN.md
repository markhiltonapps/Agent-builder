# Reliability and scale plan

Goal: a phone and website agent service clients can depend on, that keeps answering when one
supplier has a bad day (OpenAI did this week, during a demo), and that grows from a handful of
clients to hundreds without a rewrite.

This plan is written for the owner, in plain words. Section 1 says honestly what exists today.
Items marked **done** are built and pushed; **ready** means built but waiting on something from
you; the rest are proposals, in the order I would do them.

---

## 1. Where we are today: every single point of failure

| Piece | What happens if it fails | Today's protection | Gap |
|---|---|---|---|
| **OpenAI voice (GPT-Live)** | Calls cannot be answered | **Done:** automatic switch to Google Gemini Live, a circuit breaker, mid-call move with the conversation carried over, a Voice status line, a manual override | **Ready:** needs a Google key on the server, and real test calls |
| **OpenAI text (chat, summaries, AI drafting)** | Chat stops; summaries missing; AI drafting fails | Summaries and Votel sync are best effort, so calls still work | No backup text provider yet (Phase 2) |
| **LiveKit Cloud** (rooms, SIP, phone numbers) | Everything voice stops, phone and web | None | One supplier for the whole voice path (Phase 2, partly accepted risk) |
| **Phone carrier** (numbers bought through LiveKit) | Inbound calls fail | None | No second carrier; no "ring the front desk" fallback (Phase 2) |
| **Voice worker** (Railway) | Calls dropped, new calls unanswered | A crashed model session restarts and resumes the call; restarts are automatic | As far as I can see, one copy runs. One crash or deploy = a gap (Phase 1) |
| **Builder API** (Railway) | Chat stops, embeds cannot start, Votel sync stops | Calls themselves do not depend on it. **Done:** open chats are kept in the database, so a restart or a second copy loses nothing | One copy still (a second is item 6 in Phase 1, waiting on your OK) |
| **Web app** (Railway) | Nobody can use the dashboard or the embed | None beyond Railway restarts. **Done:** per-visitor limits are counted in the database, so they hold across copies | One copy |
| **Supabase** (database, sign-in) | Dashboard, billing, loading agents for new calls fail | Calls already in progress keep going | No tested restore, no replica (Phase 1 and 3) |
| **Votel** (CRM) | Contacts and tasks not created | Best effort: a failed sync is recorded on the call and the call is never affected | Failed syncs are not retried later (Phase 1) |
| **DNS and domain** (GoDaddy to Railway) | Site unreachable | None | Low risk, easy to improve (Phase 3) |
| **Finished-call work** (summary, save, Votel) | A call could go unrecorded | **Done:** the work is queued in the database first, then done; anything that fails or is cut off is retried (30 seconds, 2 minutes, 10 minutes, then longer, eight tries) | A queue is only picked up while the builder API is running |

## 2. Targets

| Measure | Target | How we know |
|---|---|---|
| New calls answered | 99.9% a month (about 43 minutes of trouble allowed) | The checks in Phase 1 |
| Time to move new calls to the backup voice | under 10 seconds after the first failures | Circuit breaker (done) |
| Call in progress when the voice fails | back in the conversation in 2 to 5 seconds | Restart backoff is 0.5 to 2 seconds (done); verify with a drill |
| Call records lost | none | Outbox and retries (Phase 1) |
| Database loss | no more than a few minutes of data | Point-in-time recovery (Phase 1) |
| Finding out something is wrong | before the client does | Alerts to your phone (Phase 1) |

## 3. What each failure looks like, and the response

| Situation | What the caller experiences | What the system does | What you do |
|---|---|---|---|
| OpenAI voice down | New calls: a different voice, still answered. Mid-call: a 2 to 5 second pause, then the same conversation | Moves to Gemini; remembers OpenAI is down for about a minute, then retests | Nothing. The Voice status line shows it |
| Both voices down | Ring, then a polite "we can't take your call, please try again" | Logs and alerts | Phase 2 adds forwarding to the client's own phone |
| LiveKit down | Phone does not connect; website call box says it cannot connect | Alerts | Phase 2: carrier-level forwarding to the client's number |
| Worker crashes mid-call | A 2 to 5 second gap, then the call continues | Restart with the saved conversation (done) | Nothing |
| Chat provider down | Chat says it is busy; Talk still works | Phase 2: second text provider | |
| Bad deploy | Possibly everything | Phase 1: health checks stop a broken deploy from going live; roll back in one click | Roll back |
| Traffic spike or abuse | Slower, then limited | Daily caps per agent (done), per-visitor limits (done, in memory); Phase 3: edge rate limiting | Watch the cost alerts |

## 4. The plan

### Phase 0: this week, finish the backup voice (mostly done)

Built and pushed:
- Gemini Live as an automatic backup for every agent, added whenever a Google key exists.
- Circuit breaker: three failures in two minutes mark a provider down; new calls start on the working one; after a minute one call retests it.
- A call already in progress moves to the backup with the conversation and tool results carried over.
- **Voice status** line on the Agents page: is OpenAI answering, is the backup ready.
- Manual override: set `VOICE_PREFER=google` on the worker and the next calls use Gemini first. Set `VOICE_FAILOVER=off` to turn the backup off.
- Each call records which voice it used and whether it moved (`failover_path`).

Needs you:
1. Create a Google AI Studio key (a Google account with billing turned on, so the key is not on a free quota) and give it to me as the `GEMINI_API_KEY` variable for the **voice-worker** and **builder-api** services on Railway. Do not paste it in chat; add it in Railway.
2. Make 10 test calls on a Gemini-first setting (`VOICE_PREFER=google`) and judge the sound, spelling of emails and numbers, and the message-taking.
3. Run a failure drill: with a call going, set a wrong OpenAI key on a test worker and confirm the call continues.

Known limits, stated plainly:
- Gemini's live model is labelled **preview** by Google, meaning its behavior or name can change with little notice. This is the backup, not the primary, and the Voice status line shows if it stops answering.
- The backup sounds different, and handles pauses and interruptions differently.
- I have not been able to test Gemini on real audio from here; the logic is tested with stand-ins and nothing changes until a key is added.

### Phase 1: remove single points and see problems first (next 2 weeks)

1. **Two copies of everything on Railway** (waiting on your OK for about $13 a month; items 2 to 4 below are done first because a second builder-api copy needs them). Worker, builder API and web each run at least 2 replicas, so one crash or deploy never means an outage. Add Railway health checks so a broken release never takes traffic.
2. **Move chat out of memory. Done.** Open chats are stored in the database (the voice path already does this with `live_calls`), so any copy can serve any chat and a restart loses nothing.
3. **A durable outbox for finished-call work. Done.** The call record is written to the database first; summary, Votel sync and client notes become retried jobs. If Votel is down for an hour, everything catches up afterwards.
4. **Shared limits. Done** (per-visitor limits; the per-agent daily caps were already in the database). Move per-visitor and per-agent limits from memory to the database, so they hold across copies.
5. **Alerts that reach your phone.** An uptime monitor on the site and the call box; a small scheduled **canary** that runs a real chat every 5 minutes and a real voice session every hour and alerts if either fails; error tracking (for example Sentry); a status line you can send clients.
6. **Database safety.** Turn on point-in-time recovery in Supabase, and do one real restore into a scratch project to prove it works.
7. **Spend guards.** OpenAI and Google monthly spend limits and an alert at 50, 80 and 100 percent.
8. **A one-page runbook. Done: `docs/RUNBOOK.md`.** for 2 a.m. and for demos (what to check, what to flip, who to call), plus a demo checklist: look at Voice status, place a test call, have a second device ready.

### Phase 2: depth (month 1 to 2)

1. **Backup for text.** Chat, call summaries and AI drafting get a second provider (Gemini text, or another) behind one switch, with the same tools.
2. **Telephony redundancy.** Two ways in for phone: a second SIP carrier (for example Telnyx or Twilio) so a carrier problem does not mean silence; and per-client **"if the AI is down, ring this number"** forwarding, so a client's phone never goes dead. For many clients this single feature is worth more than a second AI.
3. **Graceful degradation.** If voice is fully down, callers hear a short message and can leave a voicemail that is transcribed and filed like any other message.
4. **Second voice route.** Add OpenAI's other voice models as a third backup in the same chain.

### Phase 3: scale (month 2 to 4)

Where the ceilings are today (from the providers' published limits):
- **OpenAI GPT-Live concurrent sessions: 50 on the Build tier, 300 on Launch, 500 on Grow.** That is the biggest cap. 50 simultaneous calls is plenty now, and a real limit if several clients get busy at once. We should request a higher tier before we need it, and the backup spreads load across providers too.
- **Each worker copy** can run a limited number of calls. We need a load test to learn the number, then autoscale copies by active calls.
- **LiveKit plan limits** on agent sessions and phone minutes; check the plan.
- **Supabase**: connection pooling, an index review, and moving old call transcripts to cheaper storage as the calls table grows.

Work:
1. **Load test.** Simulate 25, 50 and 100 simultaneous chats and calls; record where it bends.
2. **Autoscaling and capacity alarms** on active calls, with an alert at 70 percent of the OpenAI tier limit.
3. **Edge protection** (for example Cloudflare in front of the site): rate limiting, bot filtering and a firewall for the public embed endpoints.
4. **A second region** for the voice worker and builder API, once there is client traffic that justifies it.
5. **Per-client limits and billing-grade usage** (the Usage page is the start).

### Phase 4: trust (as clients ask for it)

Audit log, secrets rotation schedule, tested backups, data retention settings, call-recording consent wording by state, written incident response, and a data-processing agreement for clients. Some industries (dental, medical, legal) have privacy rules (for example HIPAA); I can describe what the system does with data, but a lawyer should confirm what each client needs, and some providers do not sign the required agreements for every product.

## 5. Costs

I have not priced these, and prices change, so I would rather quote you real ones than guess. What drives cost:
- More Railway copies: a small monthly amount per extra copy.
- Monitoring, error tracking and a status page: free tiers exist; paid plans are modest monthly fees.
- Supabase point-in-time recovery: a monthly add-on.
- A second SIP carrier: per-minute and per-number charges, only when used.
- The backup voice itself costs nothing until it is used. When it is used, it costs per minute like any voice model.

I will put exact numbers beside each item before we commit to it.

## 6. What I recommend you decide

1. Give me the Google key (Phase 0) so we can test the backup properly.
2. Who gets the alerts (your mobile number or email), and what counts as urgent.
3. Whether to pursue the "ring the client's phone if the AI is down" feature early (my recommendation: yes, Phase 2, first).
4. Your target: is 99.9 percent the right promise to make to clients?

## 7. Demo-day checklist (use today)

1. Open **Agents** and read the **Voice status** line: both services answering.
2. Place one real test call and one chat.
3. If OpenAI looks unwell, set `VOICE_PREFER=google` on the worker so calls go to the backup first.
4. Keep a phone and a laptop ready as a plain backup if the room Wi-Fi is bad.
5. After the demo, check **Calls**: the call shows which voice it used.
