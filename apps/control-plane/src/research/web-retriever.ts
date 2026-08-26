// Web Research Retriever（研究層外部知識檢索）：
// ① GitHub 官方 MCP（repo search、README、code search）
// ② PyPI JSON API（Python 套件官方說明，純 fetch 免爬蟲）
// ③ Scrapling MCP（一般網頁 → Markdown，反反爬、prompt injection 防護）
//
// 安全邊界：本模組只在 RESEARCHING 阶段（Control Plane 側）執行，
// Worker 沙箱內 deny network——模型只消費淨化後的證據文字。
//
// 防卡死三層防護：
//   a. 缺 GITHUB_TOKEN → 不嘗試連線（server 無 token 必退出，initialize 永不回應）
//   b. 每次連線/初始化 bounded timeout（預設 15s）
//   c. 各來源 best-effort：單一失敗不影響其他，pipeline 永不因檢索阻塞

import type { EvidenceSource } from "./types.js";
import { McpClient } from "../mcp/client.js";

export interface WebRetrieverOptions {
  /** GitHub MCP client（stdio/remote；未提供 → 跳過 GitHub 檢索） */
  github?: McpClient | null;
  /** Scrapling MCP client（未提供 → 跳過一般網頁抓取） */
  scrapling?: McpClient | null;
  /** 單次檢索各來源上限 */
  maxPerSource?: number;
}

/** 已知熱門套件白名單：避免一般英文字誤觸 PyPI 查詢 */
const KNOWN_PACKAGES: Record<string, true> = {
  requests: true,
  httpx: true,
  fastapi: true,
  flask: true,
  sqlalchemy: true,
  pydantic: true,
  numpy: true,
  pandas: true,
  pytest: true,
  click: true,
  rich: true,
  yaml: true,
  redis: true,
  beautifulsoup4: true,
  bs4: true,
  scrapy: true,
  aiohttp: true,
  celery: true,
  alembic: true,
};

interface McpTextContent {
  content?: Array<{ text?: string }>;
}

function mcpText(res: unknown): string {
  const typed = res as McpTextContent | undefined;
  return typed?.content?.map((c) => c.text ?? "").join("\n") ?? "";
}

/** 從查詢文字抽取候選套件名（供 PyPI 精確查詢）：已知名詞優先 */
function extractPackageNames(query: string): string[] {
  const candidates: string[] = [];
  for (const word of query.split(/[^A-Za-z0-9_.-]+/)) {
    const lower = word.toLowerCase();
    if (KNOWN_PACKAGES[lower] && !candidates.includes(lower)) candidates.push(lower);
  }
  return candidates.slice(0, 2);
}

/** PyPI JSON API：套件官方描述（免 MCP，純 fetch） */
async function fetchPyPISummary(pkg: string): Promise<EvidenceSource[]> {
  try {
    const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      info?: { summary?: string; description?: string; project_urls?: Record<string, string> };
    };
    const info = data.info;
    if (!info?.summary && !info?.description) return [];
    const desc = (info.description ?? "").slice(0, 1200);
    const docUrl =
      info.project_urls?.Documentation ??
      info.project_urls?.Homepage ??
      `https://pypi.org/project/${pkg}/`;
    const snippet = [info.summary, desc].filter(Boolean).join("\n\n").slice(0, 1500);
    return [
      {
        type: "external",
        id: `pypi:${pkg}`,
        title: `PyPI: ${pkg} — ${info.summary ?? ""}`,
        snippet,
        confidence: 0.75,
        createdAt: new Date().toISOString(),
        metadata: { origin: "pypi", url: docUrl, package: pkg },
      } satisfies EvidenceSource,
    ];
  } catch {
    return [];
  }
}

/** GitHub MCP：search_repositories → 取 top repo README */
async function fetchGithubRepoContext(
  client: McpClient,
  query: string,
  language: string | undefined,
  limit: number,
): Promise<EvidenceSource[]> {
  const out: EvidenceSource[] = [];
  try {
    const q = language ? `${query} language:${language}` : query;
    const searchText = mcpText(await client.callTool("search_repositories", { query: q, pageSize: limit }));
    // 解析 full_name（owner/repo）— MCP 回傳為文字區塊，取前 N 個匹配
    const repos = [...searchText.matchAll(/([\w.-]+\/[\w.-]+)/g)]
      .map((m) => m[1]!)
      .filter((r) => !r.startsWith("http"))
      .slice(0, limit);
    for (const repo of repos) {
      try {
        const [owner, name] = repo.split("/");
        if (!owner || !name) continue;
        const readme = mcpText(
          await client.callTool("get_file_contents", { owner, path: "README.md", repo: name }),
        ).slice(0, 1500);
        if (readme.length < 100) continue;
        out.push({
          type: "external",
          id: `github:${repo}`,
          title: `GitHub: ${repo}`,
          snippet: readme,
          confidence: 0.7,
          createdAt: new Date().toISOString(),
          metadata: { origin: "github", url: `https://github.com/${repo}` },
        } satisfies EvidenceSource);
      } catch {
        // README 取得失敗 → 跳過該 repo
      }
    }
  } catch {
    // GitHub MCP 整體失敗 → 靜默降級（其他來源仍可用）
  }
  return out;
}

/** Scrapling MCP：make_request 抓頁面轉 Markdown（官方文檔站 / 泛用網頁） */
async function fetchViaScrapling(
  client: McpClient,
  url: string,
  title: string,
): Promise<EvidenceSource[]> {
  try {
    const text = mcpText(await client.callTool("make_request", { url, markdown: true })).slice(0, 1500);
    if (text.length < 100) return [];
    return [
      {
        type: "external",
        id: `web:${url}`,
        title,
        snippet: text,
        confidence: 0.65,
        createdAt: new Date().toISOString(),
        metadata: { origin: "scrapling", url },
      } satisfies EvidenceSource,
    ];
  } catch {
    return [];
  }
}

/**
 * 統一入口：依查詢與語言路由到各來源，回傳合併後的證據。
 * 全部 best-effort：單一來源失敗不影響其他。
 */
export async function retrieveWebEvidence(
  query: string,
  opts: WebRetrieverOptions & { language?: string } = {},
): Promise<EvidenceSource[]> {
  const { github, scrapling, language, maxPerSource = 2 } = opts;
  const tasks: Promise<EvidenceSource[]>[] = [];

  // ① PyPI：從查詢抽套件名精確查詢（最快、最可靠）
  for (const pkg of extractPackageNames(query).slice(0, maxPerSource)) {
    tasks.push(fetchPyPISummary(pkg));
  }

  // ② GitHub MCP：repo 搜尋 + README
  if (github) tasks.push(fetchGithubRepoContext(github, query, language, maxPerSource));

  // ③ Scrapling：已知文檔站模式（readthedocs）；泛用搜尋頁留待需要時啟用
  if (scrapling) {
    const pkg = extractPackageNames(query)[0];
    if (pkg) {
      tasks.push(fetchViaScrapling(scrapling, `https://${pkg}.readthedocs.io/en/stable/`, `Docs: ${pkg}`));
    }
  }

  const settled = await Promise.allSettled(tasks);
  const all: EvidenceSource[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") all.push(...r.value);
  }
  return all;
}

// ── Facade：server 接線用（延遲建立/重用 McpClient 連線）──────────────

export interface WebRetrieverServerConfig {
  github?: { enabled: boolean; transport: "docker" | "binary" | "remote"; remoteUrl?: string };
  scrapling?: { enabled: boolean; command: string };
}

export interface WebRetriever {
  retrieve(query: string, language?: string): Promise<EvidenceSource[]>;
}

/** bounded timeout：promise 超時即放棄（連不上就降級，絕不卡 pipeline） */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms),
    ),
  ]);
}

export function createWebRetriever(opts: {
  config: WebRetrieverServerConfig;
  githubToken?: string;
}): WebRetriever {
  let githubClient: McpClient | null = null;
  let scraplingClient: McpClient | null = null;
  let connectAttempted = false;

  async function ensureClients(): Promise<{ github: McpClient | null; scrapling: McpClient | null }> {
    if (connectAttempted) return { github: githubClient, scrapling: scraplingClient };
    connectAttempted = true;

    const CONNECT_TIMEOUT_MS = 15_000;
    const gh = opts.config.github;
    if (gh?.enabled) {
      // a. 防 卡死：無 token 不嘗試——github-mcp-server 缺 token 會直接退出，
      //    initialize() 的回應永遠不會到達
      if (!opts.githubToken && gh.transport !== "remote") {
        console.error("[web-retriever] GitHub MCP 已啟用但缺 GITHUB_TOKEN → 跳過");
      } else {
        try {
          if (gh.transport === "remote" && gh.remoteUrl) {
            githubClient = new McpClient({
              transport: {
                kind: "http",
                url: gh.remoteUrl,
                headers: opts.githubToken ? { Authorization: `Bearer ${opts.githubToken}` } : undefined,
              },
              clientName: "acp-research",
            });
          } else if (gh.transport === "docker") {
            githubClient = new McpClient({
              transport: {
                kind: "stdio",
                command: "docker",
                args: [
                  "run", "-i", "--rm",
                  "-e", "GITHUB_PERSONAL_ACCESS_TOKEN",
                  "ghcr.io/github/github-mcp-server",
                ],
              },
              clientName: "acp-research",
              requestTimeoutMs: 30_000,
            });
          } else {
            githubClient = new McpClient({
              transport: { kind: "stdio", command: "github-mcp-server", args: ["stdio"] },
              clientName: "acp-research",
              requestTimeoutMs: 30_000,
            });
          }
          await withTimeout(
            (async () => {
              await githubClient!.connect();
              await githubClient!.initialize();
            })(),
            CONNECT_TIMEOUT_MS,
            "github mcp connect",
          );
        } catch (err) {
          console.error(`[web-retriever] GitHub MCP 不可用：${(err as Error).message}`);
          githubClient = null;
        }
      }
    }

    const sc = opts.config.scrapling;
    if (sc?.enabled) {
      try {
        scraplingClient = new McpClient({
          transport: { kind: "stdio", command: sc.command },
          clientName: "acp-research",
          requestTimeoutMs: 60_000,
        });
        await withTimeout(
          (async () => {
            await scraplingClient!.connect();
            await scraplingClient!.initialize();
          })(),
          CONNECT_TIMEOUT_MS,
          "scrapling mcp connect",
        );
      } catch (err) {
        console.error(`[web-retriever] Scrapling MCP 不可用：${(err as Error).message}`);
        scraplingClient = null;
      }
    }

    return { github: githubClient, scrapling: scraplingClient };
  }

  return {
    async retrieve(query: string, language?: string): Promise<EvidenceSource[]> {
      const clients = await withTimeout(
        ensureClients(),
        20_000,
        "web retriever init",
      ).catch(() => ({ github: null, scrapling: null }));
      return retrieveWebEvidence(query, {
        github: clients.github,
        scrapling: clients.scrapling,
        language,
      });
    },
  };
}
