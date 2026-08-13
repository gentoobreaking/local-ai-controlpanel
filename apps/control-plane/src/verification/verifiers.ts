// 首批 verifier（spec §21）：GitDiff / UnitTest / Build / Lint / Type。
// detect 決定適用性；buildCommand 產出在 sandbox 內執行的實際指令。

import type { VerificationContext, VerificationPlugin } from "./types.js";

const NPM = /^npm(\.cmd)?$/.test(process.platform === "win32" ? "npm.cmd" : "npm")
  ? "npm"
  : "npm";

export const GitDiffVerifier: VerificationPlugin = {
  id: "git_diff",
  async detect() {
    return true;
  },
  buildCommand() {
    return ["git", "diff", "--check"];
  },
};

export const UnitTestVerifier: VerificationPlugin = {
  id: "unit_test",
  async detect(ctx) {
    if (ctx.repo.hasPackageJson) return true;
    if (ctx.repo.hasGoMod) return true;
    if (ctx.repo.hasPyProject) return true;
    return ctx.repo.hasCargoToml;
  },
  buildCommand(ctx) {
    if (ctx.repo.hasGoMod) return ["go", "test", "./..."];
    if (ctx.repo.hasPyProject) return ["python3", "-m", "pytest", "-q"];
    if (ctx.repo.hasCargoToml) return ["cargo", "test"];
    return [NPM, "test"];
  },
};

export const BuildVerifier: VerificationPlugin = {
  id: "build",
  async detect(ctx) {
    if (ctx.repo.hasPackageJson && ctx.repo.packageScripts.includes("build")) return true;
    if (ctx.repo.hasGoMod) return true;
    return ctx.repo.hasCargoToml;
  },
  buildCommand(ctx) {
    if (ctx.repo.hasGoMod) return ["go", "build", "./..."];
    if (ctx.repo.hasCargoToml) return ["cargo", "build"];
    return [NPM, "run", "build"];
  },
};

export const LintVerifier: VerificationPlugin = {
  id: "lint",
  async detect(ctx) {
    if (ctx.repo.hasPackageJson && ctx.repo.packageScripts.includes("lint")) return true;
    if (ctx.repo.hasPyProject) return true;
    if (ctx.repo.hasGoMod) return true;
    return ctx.repo.hasCargoToml;
  },
  buildCommand(ctx) {
    if (ctx.repo.hasGoMod) return ["go", "vet", "./..."];
    if (ctx.repo.hasCargoToml) return ["cargo", "clippy", "--", "-D", "warnings"];
    if (ctx.repo.hasPyProject) return ["python3", "-m", "ruff", "check", "."];
    return [NPM, "run", "lint"];
  },
};

export const TypeVerifier: VerificationPlugin = {
  id: "typecheck",
  async detect(ctx) {
    if (ctx.repo.hasPackageJson && ctx.repo.hasTsConfig) {
      // typescript 需已安裝（node_modules/.bin/tsc）才可執行
      try {
        const { access } = await import("node:fs/promises");
        const { join } = await import("node:path");
        await access(join(ctx.workspaceDir, "node_modules", ".bin", "tsc"));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  },
  buildCommand() {
    return ["node_modules/.bin/tsc", "--noEmit"];
  },
};

export const DEFAULT_VERIFIERS: VerificationPlugin[] = [
  GitDiffVerifier,
  UnitTestVerifier,
  BuildVerifier,
  LintVerifier,
  TypeVerifier,
];
