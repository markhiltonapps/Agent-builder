import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { currentClient } from "@/lib/client";
import { supabaseServer } from "@/lib/supabase/server";
import { clientVotelStatus } from "@/lib/votel-import";
import { RemoveClient, RenameClient, ShareControl, VotelConnection, VotelLink } from "../clients/client-forms";

export const metadata: Metadata = { title: "Client settings" };

export default async function SettingsPage() {
  const supabase = await supabaseServer();
  const { clients, current } = await currentClient(supabase);
  if (!current) redirect("/clients");
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "https";
  const appUrl = (process.env.APP_URL || `${proto}://${h.get("x-forwarded-host") ?? h.get("host")}`).replace(/\/$/, "");

  const [{ data: row }, { data: me }, votelKey] = await Promise.all([
    supabase.from("accounts").select("share_token, votel_contact_id").eq("id", current.id).maybeSingle(),
    supabase.from("account_members").select("role").eq("account_id", current.id),
    clientVotelStatus(current.id),
  ]);
  const owner = (me ?? []).some((m) => m.role === "owner");
  const linked = Boolean(row?.votel_contact_id);

  return (
    <section aria-labelledby="settings-h" className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 id="settings-h" className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted">Settings for {current.name}.</p>
      </div>

      {owner ? (
        <>
          <div className="glass space-y-2 p-5">
            <h2 className="font-medium">Name</h2>
            <RenameClient key={current.name} accountId={current.id} name={current.name} />
          </div>
          <div className="glass space-y-2 p-5">
            <h2 className="font-medium">Votel</h2>
            <VotelLink accountId={current.id} linked={linked} />
          </div>
          <div className="glass space-y-2 p-5">
            <h2 className="font-medium">Votel sub-account</h2>
            <VotelConnection accountId={current.id} connected={votelKey.connected} accountName={votelKey.accountName} />
          </div>
          <div className="glass space-y-2 p-5">
            <h2 className="font-medium">Share a dashboard with {current.name}</h2>
            <ShareControl accountId={current.id} initialToken={(row?.share_token as string | null) ?? null} appUrl={appUrl} />
          </div>
          {clients.length > 1 && (
            <div className="glass space-y-2 p-5">
              <h2 className="font-medium">Remove this client</h2>
              <RemoveClient accountId={current.id} name={current.name} linked={linked} />
            </div>
          )}
        </>
      ) : (
        <p className="glass p-5 text-sm text-muted">Only the owner of a client can rename it, change its Votel link, share its dashboard or remove it.</p>
      )}
    </section>
  );
}
