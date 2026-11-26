import path from "node:path";
import { assertGitRepo, mineCandidateCommits } from "../utils/git.js";
import { c, printHeader, printInfo, printWarn } from "../utils/format.js";

export interface MineOptions {
  repo: string;
  limit: number;
  top: number;
  json: boolean;
}

export function runMine(options: MineOptions): number {
  const repoRoot = assertGitRepo(path.resolve(options.repo));
  const candidates = mineCandidateCommits(repoRoot, options.limit, options.top);

  if (options.json) {
    console.log(JSON.stringify({ repo: repoRoot, candidates }, null, 2));
    return 0;
  }

  printHeader(`Candidate eval commits in ${path.basename(repoRoot)}`);

  if (candidates.length === 0) {
    printWarn(
      `No high-signal commits found in the last ${options.limit} commits. Try increasing --limit or pick refs manually with evalkit init.`
    );
    return 0;
  }

  for (let i = 0; i < candidates.length; i++) {
    const item = candidates[i];
    const badge = item.touchesTests ? c.green("[has tests]") : c.yellow("[needs tests]");
    console.log(
      `\n  ${c.bold(`${i + 1}.`)} ${c.cyan(item.shortHash)} ${c.bold(item.subject)} ${badge}`
    );
    printInfo(
      `Score: ${item.score} | ${item.date} | ${item.filesChanged} files (+${item.insertions}/-${item.deletions})`
    );
    printInfo(`Signals: ${item.reasons.join(", ")}`);
    printInfo(
      `Run: ${c.dim(`evalkit init --repo "${repoRoot}" --from ${item.parentHash.slice(0, 8)} --to ${item.shortHash}`)}`
    );
  }

  console.log("");
  return 0;
}
