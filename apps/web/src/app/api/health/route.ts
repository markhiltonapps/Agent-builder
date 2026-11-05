import { NextResponse } from "next/server";

// For Railway's health check: "is this copy up and able to answer". Deliberately touches nothing
// else (no database, no builder API), so a problem elsewhere never takes a healthy copy out of service.
export function GET() {
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
