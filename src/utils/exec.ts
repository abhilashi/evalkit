import { spawn, spawnSync } from "node:child_process";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
}

export function execSyncSafe(
  cmd: string,
  args: string[],
  options: ExecOptions = {}
): ExecResult {
  const start = Date.now();
  const result = spawnSync(cmd, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 60_000,
    input: options.input,
    maxBuffer: 25 * 1024 * 1024,
  });

  const timedOut = result.error?.message?.includes("ETIMEDOUT") ?? false;
  return {
    exitCode: result.status ?? (timedOut ? 124 : 1),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? result.error.message : ""),
    durationMs: Date.now() - start,
    timedOut,
  };
}

export function execAsyncSafe(
  cmd: string,
  args: string[],
  options: ExecOptions = {}
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs)
        : undefined;

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    if (options.input !== undefined) {
      child.stdin.write(options.input);
    }
    child.stdin.end();

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout,
        stderr: stderr || err.message,
        durationMs: Date.now() - start,
        timedOut,
      });
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: timedOut ? 124 : (code ?? 1),
        stdout,
        stderr,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
  });
}

export function isDockerAvailable(): boolean {
  const res = execSyncSafe("docker", ["info", "--format", "{{.ServerVersion}}"], {
    timeoutMs: 5_000,
  });
  return res.exitCode === 0 && res.stdout.trim().length > 0;
}

export function tailOutput(stdout: string, stderr: string, maxLines = 25): string {
  const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  if (!combined) return "";
  const lines = combined.split("\n");
  return lines.slice(-maxLines).join("\n");
}
