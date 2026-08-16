// 資料庫匯出指令（T033 §36.4）：cp db export [--db <path>] [--table <name>] [--format csv|json|...]
// --db 指定時直接讀本地 SQLite 檔；否則走 Control Plane REST（GET /api/v1/db/export）。

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, CliUsageError } from "../flags.js";
import { renderRows, renderJson, type OutputFormat } from "../format.js";
import { errMessage, type CliContext } from "../context.js";
import type { CommandResult } from "../command-types.js";

function usage(msg: string): CommandResult {
  return { code: 2, lines: [msg] };
}

function tableNamesOf(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  )
    .map((r) => r.name)
    .filter((n) => n !== "evidence_fts");
}

function dumpLocal(dbPath: string, only?: string): Record<string, Array<Record<string, unknown>>> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const dump: Record<string, Array<Record<string, unknown>>> = {};
    for (const name of tableNamesOf(db)) {
      if (only && name !== only) continue;
      dump[name] = db.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>;
    }
    return dump;
  } finally {
    db.close();
  }
}

function renderDump(dump: Record<string, Array<Record<string, unknown>>>, fmt: OutputFormat): string[] {
  if (fmt === "json") return renderJson(dump);
  const lines: string[] = [];
  for (const [name, rows] of Object.entries(dump)) {
    lines.push(`== table: ${name} (${rows.length} rows) ==`);
    if (rows.length === 0) continue;
    const keys = Object.keys(rows[0]!);
    lines.push(
      ...renderRows(fmt === "csv" ? "csv" : "table", keys, rows.map((r) => keys.map((k) => String(r[k] ?? "")))),
    );
    lines.push("");
  }
  return lines;
}

export async function dbExport(ctx: CliContext, args: string[]): Promise<CommandResult> {
  const { flags, bools } = parseArgs(
    args,
    ["--db", "--table", "--format"],
    ["--json"],
  );
  const fmt: OutputFormat = bools.has("--json")
    ? "json"
    : ((flags.get("--format") ?? "json") as OutputFormat);
  if (!["json", "csv", "table", "markdown"].includes(fmt)) {
    throw new CliUsageError(`不支援的格式: ${fmt}。可用: json, csv, table, markdown`);
  }
  const dbPath = flags.get("--db");
  const table = flags.get("--table");
  try {
    let dump: Record<string, Array<Record<string, unknown>>>;
    if (dbPath) {
      const abs = resolve(dbPath);
      if (!existsSync(abs)) {
        return { code: 1, lines: [`錯誤: 找不到資料庫 ${dbPath}`] };
      }
      dump = dumpLocal(abs, table);
    } else {
      const res = await ctx.client.dbExport(table);
      dump = res.tables;
    }
    const lines = renderDump(dump, fmt);
    if (fmt !== "json") {
      lines.unshift(`匯出 ${Object.keys(dump).length} 個 table（format: ${fmt}）`);
      if (dbPath) lines.unshift(`database: ${dbPath}`);
    }
    return { code: 0, lines };
  } catch (err) {
    return { code: 1, lines: [`錯誤: ${errMessage(err)}`] };
  }
}