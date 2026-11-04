# Neato Agent Builder

Build, test and run LiveKit voice agents from config. See [docs/PLAN.md](docs/PLAN.md) for the
roadmap.

```
apps/agent/     Python LiveKit worker: config schema, compiler, adapters, GPT-Live runtime
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

## Tests

```bash
cd apps/agent && uv run pytest
```
