/**
 * 139OpenList — CAS 播放引擎
 *
 * 原创实现。负责把「CAS 占位文件」变成「可播放的直链」。
 *
 * 完整链路：
 *   ① 读取 .cas 文件内容 → base64 解码 → 得到 CasMeta
 *   ② 在云端临时目录用 SHA256 秒传恢复真实文件（零字节传输）
 *   ③ 取该文件的下载直链
 *   ④ 返回直链给播放器
 *   ⑤ 延迟清理临时副本（用 waitUntil 或惰性清理）
 *
 * 与"下载到本地再播"不同，这里全程不搬运字节，
 * 因此非常适合 Cloudflare Workers 这类 Serverless 运行时。
 */

import { CasMeta, decodeCas, isCasName } from "./cas"
import { Yun139Client } from "../api/yun139"

/** 播放直链结果 */
export interface PlayLink {
  /** 可播放的直链 */
  url: string
  /** 真实文件字节数，供播放器显示/拖动进度 */
  size: number
  /** 真实文件名 */
  name: string
  /** 需不需要带 Referer 头（移动云盘会校验） */
  headers: Record<string, string>
  /** 本次恢复出的临时文件 ID（供后续清理） */
  tempFileId?: string
}

/** 临时副本命名前缀，便于识别与批量清理 */
const TEMP_PREFIX = "TEMP_139OL_"

/** 临时目录名 */
const TEMP_DIR = "TEMP"

export interface PlayEngineOptions {
  client: Yun139Client
  /** 是否在播放后自动清理临时文件，默认 true */
  autoCleanup?: boolean
  /** 允许直接播放的扩展名白名单，空表示不限制 */
  allowExt?: string[]
}

export class CasPlayEngine {
  private client: Yun139Client
  private autoCleanup: boolean
  private allowExt: string[]

  constructor(opts: PlayEngineOptions) {
    this.client = opts.client
    this.autoCleanup = opts.autoCleanup !== false
    this.allowExt = opts.allowExt ?? []
  }

  /** 判断某个文件名是否应当走 CAS 播放流程 */
  shouldHandle(name: string): boolean {
    return isCasName(name)
  }

  /** 扩展名是否在允许列表内 */
  private extAllowed(name: string): boolean {
    if (this.allowExt.length === 0) return true
    const idx = name.lastIndexOf(".")
    if (idx < 0) return false
    const ext = name.slice(idx + 1).toLowerCase()
    return this.allowExt.includes(ext)
  }

  /**
   * 把 CAS 内容解析为元数据，并做可播性校验。
   * 失败时抛出可直接展示给用户的中文错误。
   */
  parseMeta(casContent: string | Uint8Array): CasMeta {
    const meta = decodeCas(casContent)

    if (!meta.sha256) {
      throw new Error(
        "该 CAS 文件未记录 SHA256，无法在云端秒传恢复（可能是旧版工具生成）",
      )
    }

    const realName = this.resolveRealName(meta)
    if (!this.extAllowed(realName)) {
      throw new Error(`扩展名不在播放白名单内：${realName}`)
    }

    return meta
  }

  /** 从元数据推导真实文件名 */
  resolveRealName(meta: CasMeta): string {
    return meta.name || "unknown"
  }

  /**
   * 核心方法：由 CAS 文件内容换取播放直链。
   *
   * @param casContent .cas 文件的原始文本内容
   * @param casFileName .cas 文件名（用于推导真实文件名）
   */
  async resolvePlayLink(casContent: string, casFileName: string): Promise<PlayLink> {
    const meta = this.parseMeta(casContent)
    const realName = deriveRealName(casFileName, meta)

    // 临时目录（不存在则创建）
    const tempDirId = await this.client.ensureFolder(TEMP_DIR)

    // 用 SHA256 秒传恢复出真实文件（零字节传输）
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const restored = await this.client.restoreFromCas(
      tempDirId,
      casFileName,
      meta,
      `${TEMP_PREFIX}${stamp}_`,
    )

    // 取直链
    let url: string
    try {
      url = await this.client.getDownloadUrl(restored.fileId)
    } catch (e) {
      // 取直链失败则清理，避免留下垃圾
      await this.safeDelete(restored.fileId)
      throw e
    }

    // 播放后清理
    if (this.autoCleanup) {
      this.scheduleCleanup(restored.fileId)
    }

    return {
      url,
      size: meta.size,
      name: realName,
      headers: {
        // 移动云盘直链会校验来源
        Referer: "https://yun.139.com/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      },
      tempFileId: restored.fileId,
    }
  }

  /**
   * 安排临时副本清理。
   *
   * Serverless 无法可靠跑后台定时任务，因此这里做两件事：
   *  1. 若运行时有 waitUntil（Workers），挂一个延时删除
   *  2. 否则留给"惰性清理"——下次播放时先清掉过期的临时文件
   */
  private scheduleCleanup(fileId: string): void {
    const task = (async () => {
      // 给播放器留出建立连接的时间
      await sleep(120_000)
      await this.safeDelete(fileId)
    })()

    // Cloudflare Workers: 用 waitUntil 延长生命周期
    const ctx = (globalThis as any).__ol_ctx__
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(task)
    } else {
      // 其他环境：不阻塞主流程
      task.catch(() => {})
    }
  }

  /**
   * 惰性清理：删除临时目录中遗留下来的过期副本。
   * 应在每次播放前"顺手"调用，作为 waitUntil 的兜底。
   */
  async sweepTempFiles(olderThanMs = 30 * 60 * 1000): Promise<number> {
    let removed = 0
    try {
      const tempDirId = await this.client.ensureFolder(TEMP_DIR)
      const entries = await this.client.list(tempDirId)
      const now = Date.now()

      for (const e of entries) {
        if (e.isDir) continue
        if (!e.name.startsWith(TEMP_PREFIX)) continue
        const ts = Number(e.name.slice(TEMP_PREFIX.length).split("_")[0])
        if (!Number.isFinite(ts)) continue
        if (now - ts < olderThanMs) continue
        await this.safeDelete(e.id)
        removed++
      }
    } catch {
      // 清理失败不影响播放
    }
    return removed
  }

  private async safeDelete(fileId: string): Promise<void> {
    try {
      await this.client.deleteFile(fileId)
    } catch {
      // 忽略：留给惰性清理
    }
  }
}

/** 由 CAS 文件名推导真实文件名（带元数据兜底） */
function deriveRealName(casName: string, meta: CasMeta): string {
  const base = casName.replace(/\.cas$/i, "")
  // 正常情况：movie.mp4.cas → movie.mp4
  if (base.includes(".")) return base
  return meta.name || base
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
