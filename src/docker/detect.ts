import fs from "node:fs";
import path from "node:path";

export interface StackDetection {
  primary: "node" | "python" | "go" | "rust" | "unknown";
  tags: string[];
  packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  hasPlaywright: boolean;
  hasVitest: boolean;
  hasJest: boolean;
  hasNextJs: boolean;
  hasPostgresHint: boolean;
  externalServices: string[];
  defaultTestCommand: string;
}

export function detectStack(repoDir: string): StackDetection {
  const tags = new Set<string>();
  const externalServices: string[] = [];

  const pkgPath = path.join(repoDir, "package.json");
  const pyProjectPath = path.join(repoDir, "pyproject.toml");
  const reqPath = path.join(repoDir, "requirements.txt");
  const goModPath = path.join(repoDir, "go.mod");
  const cargoPath = path.join(repoDir, "Cargo.toml");

  let primary: StackDetection["primary"] = "unknown";
  let packageManager: StackDetection["packageManager"];
  let hasPlaywright = false;
  let hasVitest = false;
  let hasJest = false;
  let hasNextJs = false;
  let hasPostgresHint = false;
  let defaultTestCommand = "echo 'Configure grading/verify.sh for your stack' && exit 1";

  if (fs.existsSync(pkgPath)) {
    primary = "node";
    tags.add("node");

    let pkg: Record<string, unknown> = {};
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
    } catch {
      pkg = {};
    }

    const deps = {
      ...((pkg.dependencies as Record<string, string>) ?? {}),
      ...((pkg.devDependencies as Record<string, string>) ?? {}),
    };
    const depNames = Object.keys(deps);
    const scripts = (pkg.scripts as Record<string, string>) ?? {};

    if (fs.existsSync(path.join(repoDir, "pnpm-lock.yaml"))) {
      packageManager = "pnpm";
    } else if (fs.existsSync(path.join(repoDir, "yarn.lock"))) {
      packageManager = "yarn";
    } else if (fs.existsSync(path.join(repoDir, "bun.lockb")) || fs.existsSync(path.join(repoDir, "bun.lock"))) {
      packageManager = "bun";
    } else {
      packageManager = "npm";
    }

    if (depNames.includes("typescript") || fs.existsSync(path.join(repoDir, "tsconfig.json"))) {
      tags.add("typescript");
    } else {
      tags.add("javascript");
    }

    if (depNames.includes("next")) {
      hasNextJs = true;
      tags.add("nextjs");
    }
    if (depNames.includes("react")) tags.add("react");
    if (depNames.includes("@playwright/test") || depNames.includes("playwright")) {
      hasPlaywright = true;
      tags.add("playwright");
    }
    if (depNames.includes("vitest")) {
      hasVitest = true;
      tags.add("vitest");
    }
    if (depNames.includes("jest")) {
      hasJest = true;
      tags.add("jest");
    }
    if (
      depNames.some((d) => ["pg", "postgres", "drizzle-orm", "prisma", "@prisma/client"].includes(d))
    ) {
      hasPostgresHint = true;
      tags.add("postgres");
    }

    // Detect external SaaS APIs that must be mocked for --network=none verification
    const saasMap: Array<[string[], string]> = [
      [["stripe"], "stripe"],
      [["@supabase/supabase-js", "@supabase/ssr"], "supabase"],
      [["@clerk/nextjs", "@clerk/clerk-sdk-node"], "clerk"],
      [["openai", "@anthropic-ai/sdk", "@google/genai"], "llm-api"],
      [["resend", "@sendgrid/mail", "postmark"], "email-api"],
      [["@aws-sdk/client-s3"], "s3"],
      [["firebase", "firebase-admin"], "firebase"],
    ];
    for (const [pkgs, label] of saasMap) {
      if (pkgs.some((p) => depNames.includes(p))) {
        externalServices.push(label);
      }
    }

    if (scripts.test) {
      defaultTestCommand =
        packageManager === "pnpm"
          ? "pnpm test"
          : packageManager === "yarn"
            ? "yarn test"
            : "npm test";
    } else if (hasVitest) {
      defaultTestCommand = "npx vitest run";
    } else if (hasJest) {
      defaultTestCommand = "npx jest";
    } else {
      defaultTestCommand = "node --test";
    }
  } else if (fs.existsSync(pyProjectPath) || fs.existsSync(reqPath)) {
    primary = "python";
    tags.add("python");
    defaultTestCommand = "pytest";
  } else if (fs.existsSync(goModPath)) {
    primary = "go";
    tags.add("go");
    defaultTestCommand = "go test ./...";
  } else if (fs.existsSync(cargoPath)) {
    primary = "rust";
    tags.add("rust");
    defaultTestCommand = "cargo test";
  }

  if (tags.size === 0) tags.add("general");

  return {
    primary,
    tags: Array.from(tags),
    packageManager,
    hasPlaywright,
    hasVitest,
    hasJest,
    hasNextJs,
    hasPostgresHint,
    externalServices,
    defaultTestCommand,
  };
}

export function generateDockerfile(stack: StackDetection): string {
  if (stack.primary === "node") {
    const baseImage = stack.hasPlaywright
      ? "mcr.microsoft.com/playwright:v1.50.0-noble"
      : "node:22-bookworm-slim";

    const installCmd =
      stack.packageManager === "pnpm"
        ? "corepack enable && pnpm install --frozen-lockfile || pnpm install"
        : stack.packageManager === "yarn"
          ? "corepack enable && yarn install --frozen-lockfile || yarn install"
          : "npm ci || npm install";

    return `# Auto-generated by evalkit — bake ALL dependencies here so grading runs under --network=none
FROM ${baseImage}

RUN apt-get update && apt-get install -y --no-install-recommends git patch ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Copy repo snapshot pinned at base_commit
COPY repo/ /workspace/

# Install dependencies during build so runtime is 100% offline
RUN ${installCmd}

CMD ["/bin/bash"]
`;
  }

  if (stack.primary === "python") {
    return `# Auto-generated by evalkit — bake ALL dependencies here so grading runs under --network=none
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends git patch build-essential && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY repo/ /workspace/

RUN pip install --no-cache-dir pytest && \\
    if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi && \\
    if [ -f pyproject.toml ]; then pip install --no-cache-dir -e .; fi

CMD ["/bin/bash"]
`;
  }

  if (stack.primary === "go") {
    return `# Auto-generated by evalkit — bake ALL dependencies here so grading runs under --network=none
FROM golang:1.23-bookworm

WORKDIR /workspace
COPY repo/ /workspace/
RUN go mod download

CMD ["/bin/bash"]
`;
  }

  if (stack.primary === "rust") {
    return `# Auto-generated by evalkit — bake ALL dependencies here so grading runs under --network=none
FROM rust:1.83-bookworm

WORKDIR /workspace
COPY repo/ /workspace/
RUN cargo fetch

CMD ["/bin/bash"]
`;
  }

  return `# Auto-generated by evalkit — customize base image and bake dependencies for --network=none execution
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends git patch ca-certificates curl && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY repo/ /workspace/

CMD ["/bin/bash"]
`;
}

export function generateVerifyScript(
  stack: StackDetection,
  extractedTestFiles: string[]
): string {
  const copyExtractedBlock =
    extractedTestFiles.length > 0
      ? `# Copy hidden fail-to-pass tests into workspace at grading time
if [ -d "$GRADING_DIR/tests" ]; then
  cp -R "$GRADING_DIR/tests/." "$WORKSPACE_DIR/"
fi
`
      : `# Inject any hidden tests from grading/tests/ into the workspace before running
if [ -d "$GRADING_DIR/tests" ] && [ "$(ls -A "$GRADING_DIR/tests" 2>/dev/null)" ]; then
  cp -R "$GRADING_DIR/tests/." "$WORKSPACE_DIR/"
fi
`;

  return `#!/usr/bin/env bash
set -euo pipefail

# evalkit deterministic grading entrypoint
# Must exit 0 on pass and non-zero on failure.
# Expected environment:
#   WORKSPACE_DIR - repo working directory (defaults to current working directory)
#   GRADING_DIR   - read-only grading directory containing tests/ and verify.sh

WORKSPACE_DIR="\${WORKSPACE_DIR:-$(pwd)}"
GRADING_DIR="\${GRADING_DIR:-$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)}"

cd "$WORKSPACE_DIR"

${copyExtractedBlock}
# Run deterministic verification suite
${stack.defaultTestCommand}
`;
}
