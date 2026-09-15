/**
 * 139OpenList — 移动云盘（139）API 客户端
 *
 * 原创实现。仅依据移动云盘公开的 HTTP 接口协议编写，
 * 不包含任何第三方项目的代码。
 *
 * 设计目标：
 *  1. 只读为主 —— 浏览、取直链、CAS 秒传恢复
 *  2. 零字节上传 —— 秒传恢复靠 SHA256，不传文件内容，天然适配 Serverless
 *  3. 内置限流韧性 —— 429/5xx 指数退避重试
 */

import { CasMeta } from "../core/cas"

/** 账号类型 */
export type DiskKind = "personal" | "family" | "group"

export interface Yun139Config {
  /** 登录后的鉴权串（Authorization） */
  authorization: string
  /** 账号（手机号），部分接口需要 */
  account?: string
  /** 个人云专属域名（不同区域不同） */
  host: string
  /** 盘类型 */
  kind: DiskKind
  /** 家庭云/群组 ID（kind 非 personal 时需要） */
  cloudId?: string
  /** 根目录 ID，默认取根 */
  rootFolderId?: string
}

/** 秒传是否命中 */
export interface RapidResult {
  /** 云端已存在同 hash 文件 */
  exist: boolean
  /** 秒传命中 */
  rapid: boolean
  /** 创建出的文件 ID */
  fileId: string
  /** 实际落盘文件名（可能被自动改名） */
  fileName: string
}

/** 目录项 */
export interface DiskEntry {
  id: string
  name: string
  isDir: boolean
  size: number
  modified: string
  /** 缩略图（文件才有） */
  thumb?: string
}

const KIND_PATH: Record<DiskKind, string> = {
  // 个人云新版接口
  personal: "personalCloud",
  family: "familyCloud",
  group: "groupCloud",
}

/** 秒传分片大小（与云端约定一致） */
const SLICE_SIZE = 10 * 1024 * 1024

/** 重试策略 */
const MAX_RETRY = 5
const RETRY_BASE_MS = 800
const RETRY_MAX_MS = 10_000

export class Yun139Client {
  private cfg: Yun139Config

  constructor(cfg: Yun139Config) {
    this.cfg = { ...cfg }
    if (!this.cfg.host) throw new Error("缺少 host（个人云域名）")
    // 统一去掉末尾斜杠
    this.cfg.host = this.cfg.host.replace(/\/+$/, "")
  }

  /** 当前盘类型 */
  get kind(): DiskKind {
    return this.cfg.kind
  }

  /** 根目录 ID */
  get rootId(): string {
    if (this.cfg.rootFolderId) return this.cfg.rootFolderId
    return this.cfg.kind === "personal" ? "/" : ""
  }

  /* ------------------------------ 底层请求 ------------------------------ */

  /**
   * 发送带重试的 POST 请求。
   *
   * 对以下情况自动重试（指数退避，最多 6 次尝试）：
   *  - 网络层异常
   *  - HTTP 429 限流
   *  - HTTP 5xx
   *  - 业务层返回限流特征文案（"状态码非 200" / "频繁" / "限流" 等）
   */
  private async post<T = any>(
    pathname: string,
    body: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const url = this.buildUrl(pathname)
    const payload = JSON.stringify(body)
    const headers: Record<string, string> = {
      Authorization: this.cfg.authorization,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      ...extraHeaders,
    }
    if (this.cfg.account) {
      headers["mcloud-account"] = this.cfg.account
    }

    let lastErr: unknown
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      if (attempt > 0) {
        const wait = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS)
        await sleep(wait)
      }
      try {
        const res = await fetch(url, { method: "POST", headers, body: payload })
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`HTTP ${res.status} @ ${pathname}`)
          continue
        }
        const text = await res.text()
        let json: any
        try {
          json = JSON.parse(text)
        } catch {
          throw new Error(`响应非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`)
        }
        if (json && json.success === false && isThrottleMsg(json.message)) {
          lastErr = new Error(`接口限流：${json.message}`)
          continue
        }
        return json as T
      } catch (e) {
        lastErr = e
        // 明确的数据格式错误不重试
        if (e instanceof Error && e.message.startsWith("响应非 JSON")) throw e
      }
    }
    throw new Error(
      `请求失败（已重试 ${MAX_RETRY} 次）：${pathname} — ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
    )
  }

  private buildUrl(pathname: string): string {
    if (/^https?:\/\//i.test(pathname)) return pathname
    return `${this.cfg.host}${pathname.startsWith("/") ? "" : "/"}${pathname}`
  }

  /* ------------------------------ 目录浏览 ------------------------------ */

  /** 列出某个目录下的内容 */
  async list(dirId: string): Promise<DiskEntry[]> {
    const entries: DiskEntry[] = []
    let cursor = ""

    // 分页拉取，最多 50 页防御性上限
    for (let page = 0; page < 50; page++) {
      const data: any = {
        parentFileId: dirId,
        imageThumbnail: 1,
        pageSize: 100,
        orderBy: "name",
        orderDirection: "asc",
        ...(cursor ? { cursor } : {}),
      }
      const res = await this.post<any>("/file/list", data)
      const body = res?.data ?? {}

      for (const f of body.items ?? []) {
        const isDir = String(f.type ?? "").toLowerCase() !== "file"
        entries.push({
          id: String(f.fileId ?? f.id ?? ""),
          name: String(f.name ?? f.fileName ?? ""),
          isDir,
          size: Number(f.size ?? 0) || 0,
          modified: String(f.updatedAt ?? f.createdAt ?? ""),
          thumb: f.thumbnail ?? f.bigThumbnail ?? undefined,
        })
      }

      cursor = String(body.nextCursor ?? "")
      if (!cursor) break
    }
    return entries
  }

  /** 用文件名逐层解析出目录 ID */
  async resolveDirId(segments: string[], fromId?: string): Promise<string> {
    let cur = fromId || this.rootId
    for (const seg of segments) {
      if (!seg) continue
      const list = await this.list(cur)
      const hit = list.find((e) => e.isDir && e.name === seg)
      if (!hit) throw new Error(`目录不存在：${seg}`)
      cur = hit.id
    }
    return cur
  }

  /* ------------------------------ 取直链 ------------------------------ */

  /** 取文件下载直链 */
  async getDownloadUrl(fileId: string): Promise<string> {
    const res = await this.post<any>("/file/getDownloadUrl", { fileId })
    const d = res?.data ?? {}
    const url = d.cdnUrl || d.url || ""
    if (!url) throw new Error("未能取得下载直链")
    return String(url)
  }

  /* --------------------------- CAS 秒传恢复 --------------------------- */

  /**
   * 用 SHA256 秒传创建文件（零字节传输）。
   *
   * 这是 CAS 播放的核心：CAS 元数据里存着真实文件的 SHA256，
   * 只要云端存在同 hash 的内容，就能"凭空"创建出该文件，
   * 无需上传任何字节 —— 完美适配 Cloudflare Workers。
   */
  async rapidCreate(
    parentId: string,
    name: string,
    size: number,
    sha256: string,
  ): Promise<RapidResult> {
    if (sha256.length !== 64) {
      throw new Error(`SHA256 长度非法（${sha256.length}，应为 64）`)
    }

    const partInfos = buildPartInfos(size)
    const data: Record<string, unknown> = {
      contentHash: sha256,
      contentHashAlgorithm: "SHA256",
      contentType: "application/octet-stream",
      parallelUpload: false,
      partInfos,
      size,
      parentFileId: parentId,
      name,
      type: "file",
      fileRenameMode: "auto_rename",
    }
    if (this.cfg.kind === "personal") {
      data.parentFileId = parentId
    }

    const res = await this.post<any>("/file/create", data)
    const d = res?.data ?? {}

    return {
      exist: Boolean(d.exist),
      rapid: Boolean(d.rapidUpload),
      fileId: String(d.fileId ?? ""),
      fileName: String(d.fileName ?? name),
    }
  }

  /**
   * 从 CAS 元数据恢复真实文件。
   *
   * @param tempPrefix 传入文件名前缀时会在云端创建临时副本（播放场景用）
   */
  async restoreFromCas(
    parentId: string,
    casName: string,
    meta: CasMeta,
    tempPrefix?: string,
  ): Promise<{ fileId: string; fileName: string }> {
    const realName = deriveName(casName, meta.name)
    const target = tempPrefix ? `${tempPrefix}${realName}` : realName

    if (!meta.sha256) {
      throw new Error("该 CAS 文件缺少 SHA256，无法秒传恢复")
    }

    const r = await this.rapidCreate(parentId, target, meta.size, meta.sha256)
    if (!r.exist && !r.rapid) {
      throw new Error("秒传未命中：云端不存在该文件内容")
    }
    return { fileId: r.fileId, fileName: r.fileName || target }
  }

  /* ------------------------------ 清理能力 ------------------------------ */

  /** 删除文件（用于清理临时恢复副本） */
  async deleteFile(fileId: string): Promise<void> {
    if (!fileId) return
    await this.post("/file/delete", { fileIds: [fileId] })
  }

  /** 在根目录确保存在指定名字的文件夹，返回其 ID */
  async ensureFolder(name: string): Promise<string> {
    const list = await this.list(this.rootId)
    const hit = list.find((e) => e.isDir && e.name === name)
    if (hit) return hit.id

    const res = await this.post<any>("/file/create", {
      parentFileId: this.rootId,
      name,
      description: "",
      type: "folder",
      fileRenameMode: "force_rename",
    })
    const id = String(res?.data?.fileId ?? "")
    if (!id) throw new Error(`创建文件夹失败：${name}`)
    return id
  }
}

/* ------------------------------ 辅助函数 ------------------------------ */

/** 按云端约定切分分片信息（仅用于秒传请求声明） */
function buildPartInfos(size: number): Array<{ partNumber: number; partSize: number }> {
  const partSize = size <= SLICE_SIZE ? size : SLICE_SIZE
  const count = size > 0 ? Math.ceil(size / partSize) : 1
  const list: Array<{ partNumber: number; partSize: number }> = []
  for (let i = 0; i < count && i < 100; i++) {
    const start = i * partSize
    const remain = size - start
    list.push({
      partNumber: i + 1,
      partSize: remain > partSize ? partSize : remain,
    })
  }
  return list
}

/** 从 CAS 文件名推导落盘文件名 */
function deriveName(casName: string, metaName: string): string {
  const base = casName.replace(/\.cas$/i, "")
  if (base.includes(".")) return base
  return metaName || base
}

/** 判断是否为限流类业务文案 */
function isThrottleMsg(msg: unknown): boolean {
  if (typeof msg !== "string") return false
  const m = msg.toLowerCase()
  return [
    "状态码非 200",
    "频繁",
    "限流",
    "too many",
    "rate limit",
    "try again",
    "busy",
    "稍后",
  ].some((k) => m.includes(k.toLowerCase()))
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
