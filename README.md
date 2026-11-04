# Neato Agent Builder

Build, test and run LiveKit voice agents from config. See [docs/PLAN.md](docs/PLAN.md) for the
roadmap.

```
apps/agent/     Python LiveKit worker: config schema, compiler, adapters, GPT-Live runtime,
                and the validate/compile API the editor calls
apps/web/       Next.js builder: sign-in, agents, editor with live prompt preview, version history
supabase/       migrations: live call memory; accounts, agents, versions, publish pointer
  templates/    agent templates (home_services.json is the first)
docs/           plan and design notes
```

## Run the agent (Step 1)

Needs a LiveKit Cloud project and an OpenAI key with GPT-Live access.

```bash
cd apps/agent
cp .env.example .env        # fill in the four keys (or set them as environment secrets)
uv sync
uv run agent-builder dev    # registers the worker with LiveKit Cloud
```

Then open the [LiveKit Agents Playground](https://agents-playground.livekit.io), connect to
your project, and talk to Riley. Each call writes a record (transcript, tool calls, goal
reached, transfer) to `apps/agent/call_logs/`.

To run a different agent, point `AGENT_CONFIG` at another JSON file, or pass
`{"config_path": "..."}` or `{"config": {...}}` as dispatch metadata.

## Run the builder (Step 2)

Needs a Supabase project with `supabase/migrations/*.sql` applied in order.

```bash
cd apps/agent && BUILDER_API_SECRET=<16+ chars> uv run agent-builder-api   # port 8081 (PORT to change)
cd apps/web && cp .env.example .env.local   # Supabase URL and publishable key, the same secret
npm install && npm run dev
```

Sign up, name a workspace, create an agent from a template, edit it, **Save version**, then
**Publish**. To run the published version on a call, set `SUPABASE_URL`, `SUPABASE_SECRET_KEY`
and `AGENT_ID` for the worker (or dispatch with `{"agent_id": "..."}`).

## Deployment (Railway)

Project `neato-agent-builder`, two services built from the repo root with the Dockerfiles in
`apps/agent` and `apps/web`:

| Service | Public | Notes |
|---|---|---|
| `web` | yes (`*.up.railway.app`) | Needs `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` at **build** time, plus `BUILDER_API_URL`, `BUILDER_API_SECRET`, `PORT=3000` |
| `builder-api` | no (private network only) | `BUILDER_API_SECRET` (same value as `web`), `PORT=8081`; web reaches it at `http://builder-api.railway.internal:8081` |

Sign-up is invite-only. `ALLOW_SIGNUP=true` on `web` shows the sign-up form (set it only while
inviting someone). Regardless, the database lets only emails in `public.signup_allowlist` create
a workspace. Add a person with
`insert into public.signup_allowlist (email) values ('name@company.com');`.

The LiveKit worker is the same image as the API with the start command
`uv run --no-sync agent-builder start` (needs the LiveKit, OpenAI and Supabase keys).

## Tests

```bash
cd apps/agent && uv run pytest
cd apps/web && npm test && npm run typecheck
```
