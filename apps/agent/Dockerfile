# Build context is the repository root (Railway: Dockerfile path apps/agent/Dockerfile).
# Default command runs the validate/compile API. The LiveKit worker is the same image with the
# start command `uv run --no-sync agent-builder start`.
FROM python:3.12-slim
RUN pip install --no-cache-dir uv==0.11.32
WORKDIR /app
ENV UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1 PYTHONUNBUFFERED=1
COPY apps/agent/pyproject.toml apps/agent/uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev
COPY apps/agent/src ./src
COPY apps/agent/templates ./templates
RUN uv sync --frozen --no-dev
CMD ["uv", "run", "--no-sync", "agent-builder-api"]
