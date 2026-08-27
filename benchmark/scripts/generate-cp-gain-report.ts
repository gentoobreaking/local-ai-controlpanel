#!/usr/bin/env tsx
/**
 * CP Gain 報告產生器
 * 
 * 比較 Baseline (webResearch=off) vs Treatment (webResearch=on) 的能力增益
 * 輸出：benchmark/reports/cp-gain-<timestamp>.md
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RESULTS_DIR = resolve(__dirname, "..", "results", "l1l2");
const REPORTS_DIR = resolve(__dirname, "..", "reports");
const TASKSET_FILE = resolve(__dirname, "..", "taskset-l1l2", "tasks.json");

interface TaskDef {
  id: string;
  level: "L0" | "L1" | "L2";
  workspace: string;
  request: string;
  knowledge_points: string[];
  expected_model_capability?: string;
  expected_evidence_queries?: string[];
  hypothesis?: string;
}

interface RunResult {
  taskId: string;
  fixtureId: string;
  level: "L0" | "L1" | "L2";
  mode: "off" | "on";
  run: number;
  status: string;
  success: boolean;
  attempts: number;
  durationSec: number;
  verifications: Array<{ verifier: string; status: "PASS" | "FAIL" }>;
}

interface AggregatedMetrics {
  taskId: string;
  level: string;
  mode: "off" | "on";
  runs: number;
  successRate: number;
  avgAttempts: number;
  avgDurationSec: number;
  verifierPassRate: Record<string, number>;
  finalVerifierPassRate: Record<string, number>;
}

interface CPGain {
  taskId: string;
  level: string;
  successRateDelta: number;
  avgAttemptsDelta: number;
  avgDurationDelta: number;
  verifierDelta: Record<string, number>;
}

function loadTaskset(): TaskDef[] {
  return JSON.parse(readFileSync(TASKSET_FILE, "utf8")).tasks as TaskDef[];
}

function loadAllResults(): RunResult[] {
  const files = readdirSync(RESULTS_DIR).filter(f => f.endsWith(".json"));
  const results: RunResult[] = [];
  
  for (const file of files) {
    try {
      const content = readFileSync(join(RESULTS_DIR, file), "utf8");
      const result = JSON.parse(content) as RunResult;
      if (!result.mode) {
        result.mode = file.startsWith("off-") ? "off" : "on";
      }
      results.push(result);
    } catch (e) {
      console.error(`Failed to parse ${file}:`, e);
    }
  }
  return results;
}

function aggregate(results: RunResult[]): AggregatedMetrics[] {
  const grouped = new Map<string, RunResult[]>();
  
  for (const r of results) {
    const key = `${r.mode}|${r.fixtureId}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(r);
  }

  const metrics: AggregatedMetrics[] = [];
  
  for (const [key, runs] of grouped) {
    const [mode, fixtureId] = key.split("|");
    const level = runs[0].level;
    
    const successCount = runs.filter(r => r.success).length;
    const successRate = successCount / runs.length;
    const avgAttempts = runs.reduce((s, r) => s + r.attempts, 0) / runs.length;
    const avgDurationSec = runs.reduce((s, r) => s + r.durationSec, 0) / runs.length;
    
    const verifierStats = new Map<string, { pass: number; total: number }>();
    const finalVerifierStats = new Map<string, { pass: number; total: number }>();
    
    for (const r of runs) {
      for (const v of r.verifications) {
        const k = v.verifier;
        if (!verifierStats.has(k)) verifierStats.set(k, { pass: 0, total: 0 });
        const s = verifierStats.get(k)!;
        s.total++;
        if (v.status === "PASS") s.pass++;
      }
      
      const lastV = r.verifications.slice(-1)[0];
      if (lastV) {
        const k = lastV.verifier;
        if (!finalVerifierStats.has(k)) finalVerifierStats.set(k, { pass: 0, total: 0 });
        const s = finalVerifierStats.get(k)!;
        s.total++;
        if (lastV.status === "PASS") s.pass++;
      }
    }
    
    const verifierPassRate: Record<string, number> = {};
    for (const [k, s] of verifierStats) verifierPassRate[k] = s.pass / s.total;
    
    const finalVerifierPassRate: Record<string, number> = {};
    for (const [k, s] of finalVerifierStats) finalVerifierPassRate[k] = s.pass / s.total;
    
    metrics.push({
      taskId: fixtureId,
      level,
      mode: mode as "off" | "on",
      runs: runs.length,
      successRate,
      avgAttempts,
      avgDurationSec,
      verifierPassRate,
      finalVerifierPassRate,
    });
  }
  
  return metrics;
}

function computeCPGain(metrics: AggregatedMetrics[]): CPGain[] {
  const byTask = new Map<string, { off?: AggregatedMetrics; on?: AggregatedMetrics }>();
  
  for (const m of metrics) {
    const entry = byTask.get(m.taskId) || { off: undefined, on: undefined };
    entry[m.mode] = m;
    byTask.set(m.taskId, entry);
  }
  
  const gains: CPGain[] = [];
  
  for (const [taskId, { off, on }] of byTask) {
    if (!off || !on) continue;
    
    const level = off.level;
    const verifierDelta: Record<string, number> = {};
    const allVerifiers = new Set([...Object.keys(off.finalVerifierPassRate), ...Object.keys(on.finalVerifierPassRate)]);
    
    for (const v of allVerifiers) {
      const offRate = off.finalVerifierPassRate[v] ?? 0;
      const onRate = on.finalVerifierPassRate[v] ?? 0;
      verifierDelta[v] = onRate - offRate;
    }
    
    gains.push({
      taskId,
      level,
      successRateDelta: (on.successRate - off.successRate) * 100,
      avgAttemptsDelta: on.avgAttempts - off.avgAttempts,
      avgDurationDelta: on.avgDurationSec - off.avgDurationSec,
      verifierDelta,
    });
  }
  
  return gains;
}

function formatPercent(p: number): string {
  if (!isFinite(p)) return "N/A";
  return `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
}

function formatNumber(n: number): string {
  if (!isFinite(n)) return "N/A";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
}

function generateReport(metrics: AggregatedMetrics[], gains: CPGain[], taskset: TaskDef[]): string {
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const taskMap = new Map(taskset.map(t => [t.id, t]));
  
  let md = `# CP Gain 報告\n\n`;
  md += `**生成時間**：${now}\n`;
  md += `**對照組**：webResearch=off (純本地證據)\n`;
  md += `**實驗組**：webResearch=on (啟用 agentic search + web search)\n\n`;
  
  const totalOff = metrics.filter(m => m.mode === "off");
  const totalOn = metrics.filter(m => m.mode === "on");
  const avgOffSuccess = totalOff.length ? totalOff.reduce((s, m) => s + m.successRate, 0) / totalOff.length * 100 : 0;
  const avgOnSuccess = totalOn.length ? totalOn.reduce((s, m) => s + m.successRate, 0) / totalOn.length * 100 : NaN;
  const overallGain = isFinite(avgOnSuccess) ? avgOnSuccess - avgOffSuccess : NaN;
  
  md += `## 執行摘要\n\n`;
  md += `| 指標 | Baseline (off) | Treatment (on) | Gain |\n`;
  md += `|------|----------------|----------------|------|\n`;
  md += `| 平均成功率 | ${avgOffSuccess.toFixed(1)}% | ${isFinite(avgOnSuccess) ? avgOnSuccess.toFixed(1) + "%" : "N/A"} | ${formatPercent(overallGain)} |\n`;
  md += `| 任務總數 | ${new Set(totalOff.map(m => m.taskId)).size} | ${new Set(totalOn.map(m => m.taskId)).size} | - |\n`;
  md += `| 總執行次數 | ${totalOff.length} | ${totalOn.length} | - |\n\n`;
  
  if (gains.length === 0) {
    md += `> ⚠️ 尚無 'on' 模式結果，無法計算 CP Gain。請執行 \`--mode on\` 後重新產出報告。\n\n`;
  } else {
    md += `## 分級別 CP Gain\n\n`;
    for (const level of ["L0", "L1", "L2"] as const) {
      const levelGains = gains.filter(g => g.level === level);
      if (levelGains.length === 0) continue;
      
      const avgSuccessDelta = levelGains.reduce((s, g) => s + g.successRateDelta, 0) / levelGains.length;
      const avgAttemptsDelta = levelGains.reduce((s, g) => s + g.avgAttemptsDelta, 0) / levelGains.length;
      const avgDurationDelta = levelGains.reduce((s, g) => s + g.avgDurationDelta, 0) / levelGains.length;
      
      md += `### ${level} (${levelGains.length} 題)\n\n`;
      md += `| 任務 | 成功率增益 | 嘗試次數變化 | 耗時變化 (s) |\n`;
      md += `|------|------------|--------------|--------------|\n`;
      
      for (const g of levelGains) {
        md += `| ${g.taskId} | ${formatPercent(g.successRateDelta)} | ${formatNumber(g.avgAttemptsDelta)} | ${formatNumber(g.avgDurationDelta)} |\n`;
      }
      
      md += `| **${level} 平均** | **${formatPercent(avgSuccessDelta)}** | **${formatNumber(avgAttemptsDelta)}** | **${formatNumber(avgDurationDelta)}** |\n\n`;
    }
  }
  
  md += `## 詳細指標對照表\n\n`;
  md += `| 任務 | 階層 | 模式 | 成功率 | 平均嘗試 | 平均耗時(s) | git_diff | unit_test | lint |\n`;
  md += `|------|------|------|--------|----------|-------------|----------|-----------|------|\n`;
  
  for (const m of metrics.sort((a, b) => a.taskId.localeCompare(b.taskId))) {
    const gd = m.finalVerifierPassRate["git_diff"] ?? 0;
    const ut = m.finalVerifierPassRate["unit_test"] ?? 0;
    const lt = m.finalVerifierPassRate["lint"] ?? 0;
    const modeLabel = m.mode === "off" ? "🔴 off" : "🟢 on";
    
    md += `| ${m.taskId} | ${m.level} | ${modeLabel} | ${(m.successRate*100).toFixed(1)}% | ${m.avgAttempts.toFixed(2)} | ${m.avgDurationSec.toFixed(1)} | ${(gd*100).toFixed(1)}% | ${(ut*100).toFixed(1)}% | ${(lt*100).toFixed(1)}% |\n`;
  }
  
  if (gains.length > 0) {
    md += `\n## 驗證器層級 CP Gain (最終嘗試通過率增益)\n\n`;
    md += `| 任務 | 階層 | git_diff | unit_test | lint |\n`;
    md += `|------|------|----------|-----------|------|\n`;
    
    for (const g of gains) {
      const gd = g.verifierDelta["git_diff"] ?? 0;
      const ut = g.verifierDelta["unit_test"] ?? 0;
      const lt = g.verifierDelta["lint"] ?? 0;
      md += `| ${g.taskId} | ${g.level} | ${formatPercent(gd*100)} | ${formatPercent(ut*100)} | ${formatPercent(lt*100)} |\n`;
    }
  }
  
  md += `\n## 解讀與建議\n\n`;
  
  const l2Gains = gains.filter(g => g.level === "L2");
  const l1Gains = gains.filter(g => g.level === "L1");
  const l0Gains = gains.filter(g => g.level === "L0");
  
  if (l2Gains.length > 0) {
    const avgL2 = l2Gains.reduce((s, g) => s + g.successRateDelta, 0) / l2Gains.length;
    md += `- **L2 (版本特定知識)**：平均成功率增益 **${formatPercent(avgL2)}**。`;
    md += `L2 題目需查詢官方遷移指南/棄用文檔，是 **CP Gain 最強訊號區**。`;
    md += `若增益顯著 (>20pp)，證實「小模型 + 網頁研究」能補足訓練資料缺口。\n\n`;
  }
  
  if (l1Gains.length > 0) {
    const avgL1 = l1Gains.reduce((s, g) => s + g.successRateDelta, 0) / l1Gains.length;
    md += `- **L1 (API 用法知識)**：平均成功率增益 **${formatPercent(avgL1)}**。`;
    md += `需查詢第三方庫語法 (requests、SQLAlchemy)，研究能力直接轉化為通過率。\n\n`;
  }
  
  if (l0Gains.length > 0) {
    const avgL0 = l0Gains.reduce((s, g) => s + g.successRateDelta, 0) / l0Gains.length;
    md += `- **L0 (原生能力控制組)**：平均成功率增益 **${formatPercent(avgL0)}**。`;
    md += `理論上不需查詢即可完成，增益應接近 0。若有負增益，可能是「過度搜尋」干擾了原生推理。\n\n`;
  }
  
  md += `---\n*報告由 generate-cp-gain-report.ts 自動產生*\n`;
  
  return md;
}

function main() {
  console.log("📊 載入任務定義...");
  const taskset = loadTaskset();
  
  console.log("📂 載入執行結果...");
  const results = loadAllResults();
  console.log(`   找到 ${results.length} 筆結果`);
  
  const offCount = results.filter(r => r.mode === "off").length;
  const onCount = results.filter(r => r.mode === "on").length;
  console.log(`   off: ${offCount}, on: ${onCount}`);
  
  if (onCount === 0) {
    console.log("⚠️ 尚無 'on' 模式結果，報告將只含 baseline 數據");
  }
  
  console.log("📈 聚合指標...");
  const metrics = aggregate(results);
  
  console.log("🧮 計算 CP Gain...");
  const gains = computeCPGain(metrics);
  
  console.log("📝 產出報告...");
  const report = generateReport(metrics, gains, taskset);
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outputFile = join(REPORTS_DIR, `cp-gain-${timestamp}.md`);
  
  if (!existsSync(REPORTS_DIR)) {
    mkdirSync(REPORTS_DIR, { recursive: true });
  }
  
  writeFileSync(outputFile, report, "utf8");
  console.log(`✅ 報告已寫入：${outputFile}`);
  
  const jsonFile = join(REPORTS_DIR, `cp-gain-${timestamp}.json`);
  writeFileSync(jsonFile, JSON.stringify({ metrics, gains, generatedAt: timestamp }, null, 2), "utf8");
  console.log(`✅ JSON 已寫入：${jsonFile}`);
}

main();