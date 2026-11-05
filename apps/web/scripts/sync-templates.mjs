// Templates live with the agent worker (apps/agent/templates) so there is one copy of each.
// Copy them next to the web app's sources before dev and build.
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, "..", "..", "agent", "templates");
const to = join(here, "..", "src", "lib", "templates");
mkdirSync(to, { recursive: true });
// Only the ready-made agent library is used by the web app.
for (const f of readdirSync(from).filter((f) => f === "library.json")) {
  cpSync(join(from, f), join(to, f));
}
