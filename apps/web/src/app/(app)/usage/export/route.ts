import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { safeTimeZone } from "@/lib/dashboard";
import { isUuid } from "@/lib/embed-code";
import { supabaseServer } from "@/lib/supabase/server";
import { type UsageDetail, type UsageRow, currentMonth, detailCsv, monthRange, parseMonth, summaryCsv } from "@/lib/usage";

/** A spreadsheet of the month: every client, or (with ?client=) the calls behind one client's total. */
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const tz = safeTimeZone((await cookies()).get("tz")?.value);
  const month = parseMonth(url.searchParams.get("month")) ?? currentMonth(new Date(), tz);
  const range = monthRange(month);
  const customersOnly = url.searchParams.get("tests") !== "1";
  const client = url.searchParams.get("client");

  const supabase = await supabaseServer();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims) return new NextResponse("Sign in first.", { status: 401 });

  const headers = (name: string) => ({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${name}.csv"`,
    "Cache-Control": "no-store",
  });

  if (client) {
    if (!isUuid(client)) return new NextResponse("Not a client.", { status: 400 });
    const { data, error } = await supabase.rpc("client_usage_detail", { p_account: client, p_from: range.from, p_to: range.to, p_tz: tz, p_customers_only: customersOnly });
    if (error) return new NextResponse("Only the owner of a client can download its calls.", { status: 403 });
    const { data: usage } = await supabase.rpc("client_usage", { p_from: range.from, p_to: range.to, p_tz: tz, p_customers_only: customersOnly });
    const name = ((usage ?? []) as UsageRow[]).find((r) => r.account_id === client)?.name ?? "client";
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "client";
    return new NextResponse(detailCsv((data ?? []) as UsageDetail[], tz), { headers: headers(`calls-${slug}-${month}`) });
  }

  const { data } = await supabase.rpc("client_usage", { p_from: range.from, p_to: range.to, p_tz: tz, p_customers_only: customersOnly });
  return new NextResponse(summaryCsv((data ?? []) as UsageRow[], month), { headers: headers(`usage-${month}`) });
}
