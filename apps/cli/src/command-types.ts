// 指令輸出契約：每支指令回傳 exit code + 輸出行（main.ts 統一印出）。

export interface CommandResult {
  code: number;
  lines: string[];
}