// Seatbelt（sandbox-exec）adapter（spec §21.2 macOS 預設 / §28.1 default-deny）。
// 以 `sandbox-exec -f <profile> <cmd>` 執行；profile 依 §28.1 範本：
// deny default、workspace + /tmp 可寫、系統目錄唯讀、deny network*。

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import type { Sandbox, SandboxRunContext, SandboxRunResult } from "./types.js";

function hasBinary(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    spawn("which", [name], { stdio: "ignore" })
      .on("error", () => resolve(false))
      .on("exit", (code) => resolve(code === 0));
  });
}

/** 在 §28.1 profile 上動態加入 workspace 可讀寫路徑（profile 檔案本身保留靜態版本） */
export function buildSeatbeltProfile(
  baseProfile: string,
  workspaceDir: string,
  opts: { network?: boolean } = {},
): string {
  const ws = normalize(workspaceDir);
  const writable = [`(allow file-write* (subpath ${JSON.stringify(ws)}))`];
  try {
    const real = realpathSync(ws);
    if (real !== ws) writable.push(`(allow file-write* (subpath ${JSON.stringify(real)}))`);
  } catch {
    // workspace 不存在時只允許字面路徑（套用前應已建立）
  }
  // macOS /tmp 是 /private/tmp 的 symlink：sandbox-exec 的 subpath 比對用真實路徑，
  // 需同時放行（T023 實測：pytest 的 tempfile 找不到可寫目錄）。
  try {
    const realTmp = realpathSync("/tmp");
    if (!writable.some((w) => w.includes(JSON.stringify(realTmp)))) {
      writable.push(`(allow file-write* (subpath ${JSON.stringify(realTmp)}))`);
    }
  } catch {
    // /tmp 不存在於本平台時忽略
  }
  // /dev/null：pytest logging 層會開檔（T023 實測）——寫入 /dev/null 無害且常見。
  writable.push(`(allow file-write* (literal "/dev/null"))`);
  writable.push(`(allow file-read* (literal "/dev/null"))`);
  const writeRule = writable.join("\n");
  // 附加於 profile 尾端（SBPL 規則順序無關；default-deny 下顯式 allow 即放行）
  let profile = `${baseProfile.trimEnd()}\n${writeRule}\n`;
  if (opts.network === true) {
    profile = profile.replace("(deny network*)", "(allow network*)");
  }
  return profile;
}

export interface SeatbeltSandboxConfig {
  profilePath: string;
  executable?: string;
}

export class SeatbeltSandbox implements Sandbox {
  readonly name = "seatbelt" as const;
  private readonly executable: string;

  constructor(private readonly config: SeatbeltSandboxConfig) {
    this.executable = config.executable ?? "sandbox-exec";
  }

  async isAvailable(): Promise<boolean> {
    if (process.platform !== "darwin") return false;
    try {
      readFileSync(this.config.profilePath);
    } catch {
      return false;
    }
    return hasBinary(this.executable);
  }

  async run(context: SandboxRunContext): Promise<SandboxRunResult> {
    // 動態產生 profile：加入 workspace 寫入權限（及選擇性網路）
    const base = readFileSync(this.config.profilePath, "utf8");
    const profile = buildSeatbeltProfile(base, context.cwd, {
      network: context.network === true,
    });
    const tmpDir = mkdtempSync(join(tmpdir(), "acp-seatbelt-"));
    const tmpProfile = join(tmpDir, "profile.sb");
    writeFileSync(tmpProfile, profile);

    const timeoutMs = (context.timeout ?? 120) * 1000;
    const started = Date.now();
    try {
      const result = await new Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
        timedOut: boolean;
      }>((resolve) => {
        const child = spawn(
          this.executable,
          ["-f", tmpProfile, ...context.command],
          {
            cwd: context.cwd,
            // §28.1：HOME 重導 workspace（default-deny 下 npm 需寫 ~/.npm）；
            // TMP/TEMP/TMPDIR 重導 /tmp——sandbox 只放行 /tmp 與 workspace，避免
            // python/pytest 因 TMPDIR 指向 /var/folders 而無可用 temp dir（T023 實測）。
            env: {
              ...(context.env ?? process.env),
              HOME: context.cwd,
              TMP: "/tmp",
              TEMP: "/tmp",
              TMPDIR: "/tmp",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);
        child.stdout.on("data", (d) => {
          stdout += d;
        });
        child.stderr.on("data", (d) => {
          stderr += d;
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          resolve({ exitCode: -1, stdout, stderr: String(err.message), timedOut });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ exitCode: code ?? -1, stdout, stderr, timedOut });
        });
      });
      return {
        ...result,
        stdout: String(result.stdout).slice(0, 100_000),
        stderr: String(result.stderr).slice(0, 100_000),
        durationMs: Date.now() - started,
      };
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

export function createSeatbeltSandbox(profilePath: string): SeatbeltSandbox {
  return new SeatbeltSandbox({ profilePath });
}
