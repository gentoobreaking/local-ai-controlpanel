// MCP Resource 模板（spec §18）：file://、git://、http://、memory://。
// Control Plane 的 workspace（file://）、git history（git://）、project_memory
// （memory://）以 Resource 暴露；http:// 為唯讀代理資源。

import { execFile } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  McpError,
  MCP_ERROR_CODES,
  type Resource,
  type ResourceContent,
  type ResourceReader,
  type ResourceTemplate,
} from "./types.js";

export interface McpResourcesOptions {
  /** Resource 根目錄（workspace） */
  workspace: string;
  /** project_memory 根目錄（缺省 workspace/.acp-memory） */
  memoryDir?: string;
}

/** memory:// 的可用命名空間（metadata 由 memory/ module 提供）。 */
export const MEMORY_NAMESPACES = ["tasks", "decisions", "patterns"] as const;

export class McpResources implements ResourceReader {
  private readonly readers: ResourceReader[];
  readonly workspace: string;
  readonly memoryDir: string;

  constructor(opts: McpResourcesOptions) {
    this.workspace = opts.workspace;
    this.memoryDir = opts.memoryDir ?? resolve(opts.workspace, ".acp-memory");
    this.readers = [
      new FileResourceReader(this.workspace),
      new GitResourceReader(this.workspace),
      new HttpResourceReader(),
      new MemoryResourceReader(this.memoryDir),
    ];
  }

  templates(): ResourceTemplate[] {
    return [
      {
        uriTemplate: "file://{path}",
        name: "workspace 檔案",
        description: "workspace 內的檔案內容（§18 Resource 掛載：workspace）",
        mimeType: "text/plain",
      },
      {
        uriTemplate: "git://{ref}/{path}",
        name: "git history",
        description: "git 內容（git show <ref>:<path>，§18 Resource 掛載：git history）",
        mimeType: "text/plain",
      },
      {
        uriTemplate: "http://{host}/{path}",
        name: "外部文件",
        description: "HTTP(S) 唯讀代理資源",
        mimeType: "text/plain",
      },
      {
        uriTemplate: "memory://{namespace}/{key}",
        name: "project_memory",
        description: "project memory 條目（§18 Resource 掛載：project_memory）",
        mimeType: "application/json",
      },
    ];
  }

  match(uri: string): boolean {
    return this.readers.some((r) => r.match(uri));
  }

  /** 靜態資源清單：memory 命名空間與 git HEAD 快照。 */
  listResources(): Resource[] {
    const resources: Resource[] = [
      { uri: `file://${this.workspace}`, name: "workspace root", mimeType: "inode/directory" },
      { uri: "git://HEAD", name: "git HEAD snapshot", mimeType: "text/plain" },
      ...MEMORY_NAMESPACES.map((ns) => ({
        uri: `memory://${ns}`,
        name: `project_memory: ${ns}`,
        mimeType: "application/json",
      })),
    ];
    if (this.memoryDir) {
      const mem = resolve(this.memoryDir);
      for (const ns of MEMORY_NAMESPACES) {
        const dir = resolve(mem, ns);
        try {
          readdirSync(dir).forEach((name) => {
            resources.push({ uri: `memory://${ns}/${name}`, name, mimeType: "application/json" });
          });
        } catch {
          // memory 命名空間尚未建立：跳過
        }
      }
    }
    return resources;
  }

  read(uri: string): Promise<ResourceContent[]> {
    const reader = this.readers.find((r) => r.match(uri));
    if (!reader) {
      return Promise.reject(new McpError(MCP_ERROR_CODES.RESOURCE_NOT_FOUND, `resource not found: ${uri}`));
    }
    return reader.read(uri);
  }
}

// ---- file:// ----

class FileResourceReader implements ResourceReader {
  constructor(private readonly root: string) {}

  match(uri: string): boolean {
    return uri.startsWith("file://");
  }

  async read(uri: string): Promise<ResourceContent[]> {
    const rel = decodeURIComponent(uri.replace(/^file:\/\//, ""));
    const target = resolve(this.root, rel);
    const root = resolve(this.root) + sep;
    if (target !== resolve(this.root) && !target.startsWith(root)) {
      throw new McpError(MCP_ERROR_CODES.RESOURCE_NOT_FOUND, "resource 超出 workspace 範圍", { uri });
    }
    if (statSync(target).isDirectory()) {
      const entries = readdirSync(target).map((n) => ({
        name: n,
        type: statSync(resolve(target, n)).isDirectory() ? "directory" : "file",
      }));
      return [{ uri, mimeType: "application/json", text: JSON.stringify({ path: rel, entries }) }];
    }
    return [{ uri, mimeType: "text/plain", text: readFileSync(target, "utf-8") }];
  }
}

// ---- git:// ----

class GitResourceReader implements ResourceReader {
  constructor(private readonly root: string) {}

  match(uri: string): boolean {
    return uri.startsWith("git://");
  }

  async read(uri: string): Promise<ResourceContent[]> {
    const spec = uri.replace(/^git:\/\//, "");
    const ref = spec.split("/")[0] ?? "HEAD";
    const path = spec.split("/").slice(1).join("/");
    const args = ["-C", this.root, "show", path ? `${ref}:${path}` : ref];
    return await new Promise((res, rej) => {
      execFile("git", args, { timeout: 15_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          rej(new McpError(MCP_ERROR_CODES.RESOURCE_NOT_FOUND, `git resource failed: ${stderr.trim() || (err as Error).message}`, { uri }));
          return;
        }
        res([{ uri, mimeType: "text/plain", text: stdout }]);
      });
    });
  }
}

// ---- http:// ----

class HttpResourceReader implements ResourceReader {
  match(uri: string): boolean {
    return /^https?:\/\//i.test(uri);
  }

  async read(uri: string): Promise<ResourceContent[]> {
    const res = await fetch(uri, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      throw new McpError(MCP_ERROR_CODES.RESOURCE_NOT_FOUND, `HTTP ${res.status}`, { uri });
    }
    const text = await res.text();
    const mime = res.headers.get("content-type")?.split(";")[0] ?? "text/plain";
    return [{ uri, mimeType: mime, text }];
  }
}

// ---- memory:// ----

class MemoryResourceReader implements ResourceReader {
  constructor(private readonly root: string) {}

  match(uri: string): boolean {
    return uri.startsWith("memory://");
  }

  async read(uri: string): Promise<ResourceContent[]> {
    const spec = uri.replace(/^memory:\/\//, "");
    const [ns, ...rest] = spec.split("/");
    if (!ns || !(MEMORY_NAMESPACES as readonly string[]).includes(ns)) {
      throw new McpError(MCP_ERROR_CODES.RESOURCE_NOT_FOUND, `unknown memory namespace: ${ns}`, { uri });
    }
    const key = rest.join("/");
    const dir = resolve(this.root, ns);
    if (!key) {
      let entries: Array<{ name: string }> = [];
      try {
        entries = readdirSync(dir).map((n) => ({ name: n }));
      } catch {
        // 命名空間尚未建立：空清單
      }
      return [{ uri, mimeType: "application/json", text: JSON.stringify({ namespace: ns, entries }) }];
    }
    const file = resolve(dir, key);
    const root = resolve(dir) + sep;
    if (!file.startsWith(root)) {
      throw new McpError(MCP_ERROR_CODES.RESOURCE_NOT_FOUND, "memory key 超出命名空間", { uri });
    }
    return [{ uri, mimeType: "application/json", text: readFileSync(file, "utf-8") }];
  }
}

// ---- helper（供記憶體式 memory:// 掛載）----

export type { ResourceReader as McpResourceReader } from "./types.js";