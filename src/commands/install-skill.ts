import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { printFail, printHeader, printInfo, printPass } from "../utils/format.js";

export interface InstallSkillOptions {
  target: string;
  project: boolean;
}

function getBundledSkillPath(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  // dist/commands -> package root -> skill/evalkit/SKILL.md
  const candidates = [
    path.resolve(__dirname, "..", "..", "skill", "evalkit", "SKILL.md"),
    path.resolve(__dirname, "..", "skill", "evalkit", "SKILL.md"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not locate bundled SKILL.md (checked: ${candidates.join(", ")})`);
}

function resolveTargets(target: string, project: boolean): Array<{ label: string; destDir: string }> {
  const home = os.homedir();
  const cwd = process.cwd();

  const knownGlobal: Record<string, string> = {
    antigravity: path.join(home, ".gemini", "antigravity", "skills", "evalkit"),
    claude: path.join(home, ".claude", "skills", "evalkit"),
    cursor: path.join(home, ".cursor", "skills", "evalkit"),
    codex: path.join(home, ".codex", "skills", "evalkit"),
  };

  const knownProject: Record<string, string> = {
    antigravity: path.join(cwd, ".agent", "skills", "evalkit"),
    claude: path.join(cwd, ".claude", "skills", "evalkit"),
    cursor: path.join(cwd, ".cursor", "skills", "evalkit"),
    codex: path.join(cwd, ".codex", "skills", "evalkit"),
  };

  const map = project ? knownProject : knownGlobal;

  if (target === "all") {
    return Object.entries(map).map(([label, destDir]) => ({ label, destDir }));
  }

  if (target === "auto") {
    const detected: Array<{ label: string; destDir: string }> = [];
    const checks: Array<[string, string]> = [
      ["antigravity", path.join(home, ".gemini", "antigravity")],
      ["claude", path.join(home, ".claude")],
      ["cursor", path.join(home, ".cursor")],
      ["codex", path.join(home, ".codex")],
    ];
    for (const [label, rootDir] of checks) {
      if (project || fs.existsSync(rootDir)) {
        detected.push({ label, destDir: map[label] });
      }
    }
    if (detected.length === 0) {
      detected.push({ label: "claude", destDir: map.claude });
    }
    return detected;
  }

  if (map[target]) {
    return [{ label: target, destDir: map[target] }];
  }

  // Treat as custom directory path
  return [{ label: "custom", destDir: path.resolve(target) }];
}

export function runInstallSkill(options: InstallSkillOptions): number {
  const skillSrc = getBundledSkillPath();
  const targets = resolveTargets(options.target, options.project);

  printHeader("Installing evalkit Agent Skill");

  let installed = 0;
  for (const t of targets) {
    try {
      fs.mkdirSync(t.destDir, { recursive: true });
      const destFile = path.join(t.destDir, "SKILL.md");
      fs.copyFileSync(skillSrc, destFile);
      printPass(`[${t.label}] Installed → ${destFile}`);
      installed++;
    } catch (err) {
      printFail(`[${t.label}] Failed: ${(err as Error).message}`);
    }
  }

  if (installed > 0) {
    printInfo(
      'Now open your AI coding agent in any repo and say: "Turn the bug I just fixed into an eval using evalkit."'
    );
  }
  console.log("");
  return installed > 0 ? 0 : 1;
}
