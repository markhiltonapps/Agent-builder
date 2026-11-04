# Build context is the repository root (Railway: Dockerfile path apps/web/Dockerfile).
# Templates live with the worker; the web build copies them in (scripts/sync-templates.mjs).
FROM node:22-slim
WORKDIR /repo
COPY apps/agent/templates apps/agent/templates
WORKDIR /repo/apps/web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web ./
# NEXT_PUBLIC_* values are compiled into the bundle, so they are needed at build time.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build
ENV NODE_ENV=production
CMD ["sh", "-c", "exec npx next start -H 0.0.0.0 -p ${PORT:-3000}"]
