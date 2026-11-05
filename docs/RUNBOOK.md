# Runbook: when something is wrong, and before a demo

For the owner, in plain words. Start at "First five minutes". Nothing here needs you to write code.

## First five minutes

1. Open the app, go to **Agents**, read the **Voice status** line under "Send agents to Votel".
   Two green dots (OpenAI answering, backup ready) means the voice side is healthy.
2. Open **Calls**. Is the most recent call there, with a summary? New calls appear within a few seconds.
3. Open Railway, the Neato project, and look at the three services: **web**, **builder-api**, **voice-worker**.
   Each should say "Active" with a recent green deploy. A red or crashed one is your first clue.
4. Check the providers' own status pages (search "<name> status" if a link has moved):
   OpenAI (status.openai.com), Supabase (status.supabase.com), LiveKit (status.livekit.io),
   Railway (status.railway.com), Google AI (aistudio.google.com/status).

## What to do, by what you see

| What you see | What to do |
|---|---|
| Voice status says OpenAI is **not answering** | Nothing: new calls already go to the Gemini backup, and a call in progress moves over. To force it, in Railway open **voice-worker**, **Variables**, add `VOICE_PREFER` = `google`, **Deploy**. Remove it when OpenAI is back. |
| Voice status says the backup is **not answering** | OpenAI still answers. Tell me; it is usually the Google key or a Google outage. |
| Both voices not answering | Callers hear "we can't take your call". Check the OpenAI and Google status pages. Nothing to fix on our side until one returns. |
| A call is missing from **Calls** | Wait two minutes (work after a call is retried automatically). If still missing, see "Unfinished work" below. |
| Call is in **Calls** but "Votel sync failed" | Retried automatically, up to eight times over about a day. It almost always means Votel was down or the key changed. |
| Website chat says it is busy or cannot connect | Check **builder-api** in Railway. Chats are kept in the database, so a restart loses nothing; the visitor just retries. |
| Dashboard or embed will not load | Check **web** in Railway. |
| Everything broke right after a deploy | Railway, the broken service, **Deployments**, find the last good one, **Rollback**. One click. |
| Sign-in or sign-up emails not arriving | Check Resend (resend.com, Emails) for the send, and Supabase, Authentication, Emails. See "Email safety" in CLAUDE.md before testing anything. |

## Unfinished work (calls and chats not fully saved or sent)

Supabase, **SQL Editor**, run:

```sql
-- Work after calls that is waiting or gave up (state 'failed' means it tried eight times)
select state, attempts, last_error, created_at, run_after
from public.finish_jobs
where state <> 'done'
order by created_at desc;

-- Website chats still open right now
select id, agent_id, last_at from public.chat_sessions where not ended order by last_at desc;
```

Rows here are normal for a minute or two. Rows that stay for hours point at a cause in `last_error`
(for example "Votel: ..." means Votel is the problem). Tell me what it says.

## Before a demo (two minutes)

1. **Agents**: both Voice status dots green.
2. Place one real test call and send one chat message on the website.
3. **Calls**: the call is there and shows which voice it used.
4. Have a second device ready (phone and laptop) in case the room Wi-Fi is bad.
5. If OpenAI looks unwell, set `VOICE_PREFER=google` first (table above) and test again.

## Who to call

Fill these in so a stranger could act at 2 a.m.:

| Thing | Where to look or who to contact |
|---|---|
| Railway (hosting) | Account: markallenhilton@gmail.com. Support from the dashboard. |
| Supabase (database, sign-in) | Same account. Project `neato-agent-builder`. |
| LiveKit (voice rooms, phone numbers) | Their dashboard; email support comes with the Ship plan. |
| OpenAI and Google (voices) | Status pages above. |
| Votel (CRM) | Votel support. |
| Domain (GoDaddy) | GoDaddy account. |
| The person who can fix the app | Add name and phone here. |
