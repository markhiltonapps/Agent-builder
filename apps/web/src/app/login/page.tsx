import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

// ALLOW_SIGNUP is read per request. Without this the page is prerendered at build time, before
// the deployment's runtime variables exist, and the sign-up form can never appear.
export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-16">
      <p className="mb-2 text-sm font-medium tracking-wide text-accent">Neato</p>
      <h1 className="mb-1 text-3xl font-semibold tracking-tight">Agent Builder</h1>
      <p className="mb-8 text-muted">Build, test and run AI phone agents.</p>
      <LoginForm allowSignup={process.env.ALLOW_SIGNUP === "true"} />
    </main>
  );
}
