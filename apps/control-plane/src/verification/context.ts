// VerificationRepositoryContext 建構（spec §21）。
// 探測 workspace 內的語言/框架/建 tool；verifier 的 detect() 用此判斷適用性。

import { existsSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import type { VerificationRepositoryContext } from "./types.js";

export interface BuildContextOpts {
  /** 外部提供的語言/框架信號（Runner/T017 Research 可填）；預設自動探測 */
  languages?: string[];
  frameworks?: string[];
}

function readJSON(p: string): unknown {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
}

export function buildVerificationContext(
  workspaceDir: string,
  opts: BuildContextOpts = {},
): VerificationRepositoryContext {
  const path = normalize(workspaceDir);
  const pkg = readJSON(join(path, "package.json")) as
    | {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      }
    | undefined;
  const languages: string[] = [];
  const frameworks: string[] = [];

  if (pkg) {
    languages.push("node");
    if (existsSync(join(path, "tsconfig.json")) && !languages.includes("typescript")) {
      languages.push("typescript");
    }
    const names =
      Object.keys(pkg.dependencies ?? {})
        .concat(Object.keys(pkg.devDependencies ?? {}))
        .join(" ");
    const detect = (name: string, fw: string) => {
      if (names.includes(name) && !frameworks.includes(fw)) frameworks.push(fw);
    };
    detect("next", "next");
    detect("react", "react");
    detect("vue", "vue");
    detect("svelte", "svelte");
    detect("express", "express");
    detect("hono", "hono");
    detect("fastify", "fastify");
  }
  if (existsSync(join(path, "go.mod"))) {
    languages.push("go");
    frameworks.push("go");
  }
  if (existsSync(join(path, "Cargo.toml"))) frameworks.push("cargo");
  if (existsSync(join(path, "pyproject.toml")) || existsSync(join(path, "setup.py"))) {
    languages.push("python");
  }

  return {
    path,
    languages: opts.languages ?? languages,
    frameworks: opts.frameworks ?? frameworks,
    hasPackageJson: !!pkg,
    hasTsConfig: existsSync(join(path, "tsconfig.json")),
    hasGoMod: existsSync(join(path, "go.mod")),
    hasCargoToml: existsSync(join(path, "Cargo.toml")),
    hasPyProject: existsSync(join(path, "pyproject.toml")),
    packageScripts: Object.keys(pkg?.scripts ?? {}),
  };
}
