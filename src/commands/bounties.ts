import fs from "node:fs";
import path from "node:path";
import type { BountyListing } from "../types.js";
import { c, printHeader, printInfo, printWarn } from "../utils/format.js";

export interface BountiesOptions {
  source?: string;
  stack?: string;
  json: boolean;
}

const DEFAULT_BOUNTIES_URL =
  "https://raw.githubusercontent.com/abhilashi/evalkit/main/bounties.json";

async function loadBounties(source?: string): Promise<BountyListing[]> {
  if (source) {
    if (source.startsWith("http://") || source.startsWith("https://")) {
      const res = await fetch(source);
      if (!res.ok) throw new Error(`Failed to fetch bounties from ${source} (HTTP ${res.status})`);
      const data = (await res.json()) as { bounties?: BountyListing[] } | BountyListing[];
      return Array.isArray(data) ? data : (data.bounties ?? []);
    }
    const abs = path.resolve(source);
    const data = JSON.parse(fs.readFileSync(abs, "utf8")) as
      | { bounties?: BountyListing[] }
      | BountyListing[];
    return Array.isArray(data) ? data : (data.bounties ?? []);
  }

  // Prefer local bounties.json if running inside repo, otherwise fetch canonical feed
  const localFile = path.resolve(process.cwd(), "bounties.json");
  if (fs.existsSync(localFile)) {
    const data = JSON.parse(fs.readFileSync(localFile, "utf8")) as
      | { bounties?: BountyListing[] }
      | BountyListing[];
    return Array.isArray(data) ? data : (data.bounties ?? []);
  }

  const res = await fetch(DEFAULT_BOUNTIES_URL);
  if (!res.ok) {
    throw new Error(`Unable to fetch bounties feed (${DEFAULT_BOUNTIES_URL}): HTTP ${res.status}`);
  }
  const data = (await res.json()) as { bounties?: BountyListing[] } | BountyListing[];
  return Array.isArray(data) ? data : (data.bounties ?? []);
}

export async function runBounties(options: BountiesOptions): Promise<number> {
  let list = await loadBounties(options.source);
  if (options.stack) {
    const wanted = options.stack.toLowerCase();
    list = list.filter((b) => b.stack.some((s) => s.toLowerCase() === wanted));
  }

  if (options.json) {
    console.log(JSON.stringify({ bounties: list }, null, 2));
    return 0;
  }

  printHeader(`evalkit Challenges & Funded Bounties (${list.length})`);
  if (list.length === 0) {
    printWarn("No matching bounties or open challenges found.");
    return 0;
  }

  for (const b of list) {
    const badge =
      b.status === "funded"
        ? c.green(`[FUNDED · $${(b.net_payout_usd ?? 0).toLocaleString()} net to dev]`)
        : c.cyan("[OPEN FRONTIER CHALLENGE]");
    console.log(`\n  ${c.bold(b.id)}  ${badge}`);
    console.log(`  ${b.title}`);
    printInfo(
      `Sponsor: ${b.sponsor} | Stack: ${b.stack.join(", ")} | Sandbox: ${b.sandbox_required} | Max frontier pass: ${Math.round(b.max_frontier_pass_rate * 100)}%`
    );
    printInfo(b.description);
  }

  console.log("");
  printInfo("Match a challenge? Run `evalkit bench` then `evalkit publish ./evals/<slug> --board`.");
  console.log("");
  return 0;
}
