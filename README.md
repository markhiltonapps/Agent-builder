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
cd apps/agent && BUILDER_API_SECRET=<16+ chars> uv run agent-builder-api   # port 8081
cd apps/web && cp .env.example .env.local   # Supabase URL and publishable key, the same secret
npm install && npm run dev
```

Sign up, name a workspace, create an agent from a template, edit it, **Save version**, then
**Publish**. To run the published version on a call, set `SUPABASE_URL`, `SUPABASE_SECRET_KEY`
and `AGENT_ID` for the worker (or dispatch with `{"agent_id": "..."}`).

## Tests

```bash
cd apps/agent && uv run pytest
cd apps/web && npm test && npm run typecheck
```
