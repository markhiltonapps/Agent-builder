// The two levels of the app. "All clients" is the admin level: every client, all calls, usage and billing.
// Inside a client is everything about one client: its dashboard, agents, knowledge, calls, numbers and settings.
// The same address always means the same level, so the menu and the bar can follow the address alone.

export interface NavItem { href: string; label: string; back?: boolean }

export const ADMIN_LINKS: readonly NavItem[] = [
  { href: "/clients", label: "All clients" },
  { href: "/all-calls", label: "All calls" },
  { href: "/usage", label: "Usage and billing" },
  { href: "/help", label: "Help" },
];

/** The top bar while you are inside a client: a way back up, and Help. */
export const CLIENT_TOP_LINKS: readonly NavItem[] = [
  { href: "/clients", label: "All clients", back: true },
  { href: "/help", label: "Help" },
];

export const CLIENT_TABS: readonly NavItem[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/agents", label: "Agents" },
  { href: "/knowledge", label: "Knowledge" },
  { href: "/calls", label: "Calls" },
  { href: "/numbers", label: "Phone numbers" },
  { href: "/settings", label: "Settings" },
];

const INSIDE_A_CLIENT = new RegExp(`^/(${CLIENT_TABS.map((t) => t.href.slice(1)).join("|")})(/|$)`);

/** "client" for the pages that belong to the client you have open; "all" for everything else. */
export function levelOf(path: string): "client" | "all" {
  return INSIDE_A_CLIENT.test(path) ? "client" : "all";
}

export const isActive = (path: string, href: string) => path === href || path.startsWith(`${href}/`);
