# Neato Agent Builder: build plan

A builder for LiveKit voice agents on GPT-Live. It starts as a tool Neato operates, but every
choice keeps the path to customer and reseller self-serve open. This plan replaces the
13-week, three-hire plan (Oct 8, 2026) with small steps built by one person working with
Claude. It keeps that plan's best ideas: agents as versioned config, a deterministic
prompt compiler, tools as data bound to adapters, one provider layer, and evals as the
publish gate.

## Principles

- **Config is the product.** An agent is one validated JSON document (`AgentConfig`).
  The runtime, the editor and, later, the customer self-serve UI all edit the same document.
- **No model name in code.** Every model is named in config and built in `providers.py`.
  Phase 2's failover is a list in config, not a rewrite.
- **Tools are data.** Name, description, parameters and an adapter binding. A new vertical
  is a new template, not new code.
- **DIY-ready from day one.** Field ownership (Neato-only versus customer-editable) is part of
  the schema, so self-serve is UI work, not a migration.
- **Two kinds of dashboard, one design system.** The builder (for Neato, and later DIY
  customers) and a client-facing dashboard (calls, outcomes, usage) share the glass UI.

## Stack

| Layer | Choice |
|---|---|
| Media, SIP, numbers | LiveKit Cloud |
| Agent worker | Python, LiveKit Agents 1.8, GPT-Live (`gpt-live-1`) |
| Web app | Next.js (App Router), TypeScript, Tailwind; glass dashboard UI |
| Database and auth | Supabase (Postgres, Auth, row-level security per account) |
| Hosting | Railway (worker and web) |
| Later | Stripe billing, PostHog analytics, reseller tenancy, AWS if needed |

## Steps

| Step | Delivers | You test |
|---|---|---|
| **1. One working agent** (done) | Config schema, compiler, mock adapter, tool wiring, GPT-Live worker, home-services template, call records as JSON | Talk to it in the LiveKit Agents Playground |
| **2. Builder and DB** (done and live on Railway; first browser call verified) | Supabase schema (accounts, agents, versions, publish pointer); worker loads the published version; glass web editor for persona, greetings, guardrails, escalation, tools; compiled-prompt preview; version diff and rollback | Build a second agent without code |
| **3. Real calls** (next: call history in the DB, then a phone number) | LiveKit SIP number, `http` adapter to customer APIs with a test button, SIP transfer, call log and transcripts in the DB, recordings | Call it from your phone |
| **4. Evals** | Synthetic caller (LiveKit simulation or our own), three-scenario smoke set, assertions over the tool log, publish gate | A bad edit gets blocked |
| **5. Client dashboard** | Per-client login and dashboard: calls, goal rate, transfers, minutes, transcripts | A client logs in |
| **6. Failover (Phase 2)** | See below | Simulated outages |
| **7. Votel link** | See below | Build an agent here, see it in Votel; a call lands in the Votel CRM |
| **8. DIY** | Customer self-serve editing of customer-owned fields, approval before deploy, then reseller tenancy and billing | |

## Phase 2: redundancy

Order, all named in `runtime.fallbacks`:

1. GPT-Live on OpenAI (primary)
2. GPT-Live on Azure (same model, separate infrastructure)
3. Gemini Live (different speech-to-speech model)
4. Cascaded: STT, then Claude, then TTS (slower, but no shared dependency with the others)

Two layers, built in this order:

- **New-call failover.** Before a session starts, pick the first healthy provider. A health
  monitor tracks connect errors and latency per provider and opens a circuit after repeated
  failures. This covers most real outages and is low risk.
- **Mid-call recovery.** If the live session drops, rebuild it on the next provider and carry
  the transcript forward so the caller does not start over. LiveKit Agents 1.8 ships
  `RealtimeModelFallbackAdapter`, which seeds the new session with the conversation. Checked
  on 1.8.10: OpenAI and Azure GPT-Live combine in it, but GPT-Live and Gemini do not
  (`supports_overlapping_speech` differs), so a cross-family switch needs our own handoff via
  `session.update_agent()`.
- **Memory first.** The demo failure (agent came back with no memory, greeting again) is fixed
  by keeping the conversation in our worker, saved per room, and never replaying the greeting
  on recovery. Full design: the failover brief shared with the team.

Requirements that come with it:

- The compiler gets a target per model family, because prompting vocabulary differs.
- Every fallback path runs the eval smoke set before an agent version can be published.
- Fallback is per account: a compliance-bound customer can be limited to OpenAI and Azure only.
  Adding Google or Anthropic as subprocessors needs notice under the DPA.
- Every call record notes which provider served it and whether a failover happened.
- Later: LiveKit Cloud and SIP carrier redundancy (second trunk; self-hosted LiveKit as a cold
  standby).

## Votel link (Step 7)

Votel.ai stays the hub for CRM, websites and marketing; this builder is the voice engine
under it. Decided with Mark:

- **Directory, not copies.** A CMS collection in Votel ("Agent Builder OS") holds one row per agent:
  name, client, live version, fingerprint, link back to the builder. We do not mirror agents as
  Votel AI agents, because a copy would drift from what actually answers calls and could be
  switched on by mistake.
- **Calls flow into Votel.** After each call, upsert the contact by phone number, add the summary
  and transcript as a note, move the pipeline stage, and turn transfers and callbacks into Votel
  tasks. This is a `votel` adapter on Step 3's `http` machinery.
- **Import as templates.** Votel's agents are prompt sections (Personality, Tone, Goal,
  Guardrails, Business Facts, FAQs) that map onto our config; Magnolia Court Hotel can seed the
  hotel receptionist template.
- One Votel sub-account per builder workspace, so each client's calls reach that client's CRM.
- The deployed app cannot use the MCP connection (that is for Claude sessions). It needs Votel's
  REST API and one key per client, kept in Supabase Vault, never in an agent config. Confirm the
  endpoints with Votel's API reference before building.

## Still needed from Mark

- LiveKit Cloud and OpenAI keys as environment secrets (`LIVEKIT_URL`, `LIVEKIT_API_KEY`,
  `LIVEKIT_API_SECRET`, `OPENAI_API_KEY`)
- The hotel receptionist repo from the developer (becomes the second template)
- The new Supabase project's secret key and the web app's environment variables (see README)
- The `/impeccable` design skill added to the environment (the Step 2 UI was designed without it)
