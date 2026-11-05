import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isUuid } from "@/lib/embed-code";
import { embedInfo } from "@/lib/embed-info";
import { EmbedPanel } from "./embed-panel";

export const metadata: Metadata = { title: "Talk to our AI assistant", robots: { index: false } };

export default async function EmbedPage({ params }: PageProps<"/embed/[agent]">) {
  const { agent } = await params;
  if (!isUuid(agent)) notFound();
  const info = await embedInfo(agent);
  if (!info || info === "error" || !info.enabled) notFound();
  return <EmbedPanel agentId={agent} title={info.business || info.name} voice={info.voice !== false} chat={info.chat !== false} />;
}
