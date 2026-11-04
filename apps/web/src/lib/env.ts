// Read configuration once and fail with a message that says what to set.
function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. See apps/web/.env.example.`);
  return v;
}

export const env = {
  get supabaseUrl() {
    return need("NEXT_PUBLIC_SUPABASE_URL");
  },
  get supabaseKey() {
    return need("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  },
  get builderApiUrl() {
    return need("BUILDER_API_URL").replace(/\/$/, "");
  },
  get builderApiSecret() {
    return need("BUILDER_API_SECRET");
  },
};
