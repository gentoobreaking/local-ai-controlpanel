// 輸出格式（T033）：table（預設）/ json / csv / markdown。

export type OutputFormat = "table" | "json" | "csv" | "markdown";

const VALID: readonly OutputFormat[] = ["table", "json", "csv", "markdown"];

export function parseFormat(v: string | undefined): OutputFormat {
  const f = (v ?? "table").toLowerCase();
  return (VALID as readonly string[]).includes(f) ? (f as OutputFormat) : "table";
}

function cell(v: unknown): string {
  return String(v ?? "");
}

function tableWidths(headers: string[], rows: string[][]): number[] {
  return headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
}

function csvField(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function renderRows(fmt: OutputFormat, headers: string[], rows: string[][]): string[] {
  switch (fmt) {
    case "json":
      return renderJson(
        rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""]))),
      );
    case "csv":
      return [headers.map(csvField).join(","), ...rows.map((r) => r.map(csvField).join(","))];
    case "markdown":
      return [
        `| ${headers.join(" | ")} |`,
        `| ${headers.map(() => "---").join(" | ")} |`,
        ...rows.map((r) => `| ${(r as string[]).join(" | ")} |`),
      ];
    case "table":
    default: {
      const widths = tableWidths(headers, rows);
      const fmtRow = (cells: string[]) =>
        cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
      return [fmtRow(headers), ...rows.map((r) => fmtRow(r))];
    }
  }
}

export function renderJson(data: unknown): string[] {
  return JSON.stringify(data, null, 2).split("\n");
}