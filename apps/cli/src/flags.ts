// CLI 參數解析（T033）：string flags（--config <v> / --config=<v>）與 bool flags（--watch / -w）。

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | undefined>;
  bools: Set<string>;
}

const ALIASES: Record<string, string> = {
  "-w": "--watch",
  "-h": "--help",
  "-v": "--version",
  "-f": "--format",
  "-j": "--json",
};

/**
 * 解析 argv 片段：
 * - stringFlags 需要值（`--format json` 或 `--format=json`）
 * - boolFlags 無需值（`--watch`）
 * - `--json` 視為 bool（語意上等同 --format json，由呼叫端轉換）
 * - 位置參數收集至 positionals
 */
export function parseArgs(
  args: string[],
  stringFlags: string[],
  boolFlags: string[],
): ParsedArgs {
  const flags = new Map<string, string | undefined>();
  const bools = new Set<string>();
  const positionals: string[] = [];
  const strSet = new Set(stringFlags);
  const boolSet = new Set(boolFlags);

  for (let i = 0; i < args.length; i++) {
    let a = args[i]!;
    if (a in ALIASES) a = ALIASES[a]!;
    if (boolSet.has(a)) {
      bools.add(a);
      continue;
    }
    if (strSet.has(a)) {
      const value = args[i + 1];
      if (value === undefined) throw new CliUsageError(`缺少 ${a} 的參數值`);
      flags.set(a, value);
      i++;
      continue;
    }
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq > 0 && strSet.has(a.slice(0, eq))) {
      flags.set(a.slice(0, eq), a.slice(eq + 1));
      continue;
    }
    if (a.startsWith("-") && a !== "-") throw new CliUsageError(`未知選項: ${a}`);
    positionals.push(a);
  }
  return { positionals, flags, bools };
}