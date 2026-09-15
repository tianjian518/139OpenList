/**
 * 139OpenList — WebDAV 只读服务
 *
 * 原创实现。为网易爆米花 / Infuse / VidHub 等播放器提供标准 WebDAV 接口。
 *
 * 支持的方法：
 *   OPTIONS  能力协商
 *   PROPFIND 列目录（播放器靠它扫描媒体库）
 *   GET/HEAD 读取（.cas 会被还原为真实视频流）
 *   PUT/DELETE/MKCOL/MOVE/COPY 明确返回 403（本服务定位为只读）
 *
 * 关键设计：目录里展示的 .cas 文件，会被"伪装"成真实视频文件名，
 * 播放器看到的就是 movie.mp4，直接点播即可，无需理解 CAS 概念。
 */

import { CasPlayEngine } from "../core/player"
import { Yun139Client } from "../api/yun139"
import { isCasName } from "../core/cas"

export interface WebdavOptions {
  client: Yun139Client
  engine: CasPlayEngine
  /** 是否把 .cas 显示为真实视频名（推荐 true，播放器体验最好） */
  virtualizeCas?: boolean
  /** 挂载点前缀，如 /dav */
  prefix?: string
}

/** 虚拟文件节点（对外暴露的视图） */
interface VNode {
  name: string
  isDir: boolean
  size: number
  modified: string
  /** 对应的 139 文件 ID */
  id: string
  /** 若该节点由 .cas 虚拟化而来，记录真实 .cas 的名字 */
  casSource?: string
}

export class WebdavHandler {
  private client: Yun139Client
  private engine: CasPlayEngine
  private virtualize: boolean
  private prefix: string

  constructor(opts: WebdavOptions) {
    this.client = opts.client
    this.engine = opts.engine
    this.virtualize = opts.virtualizeCas !== false
    this.prefix = opts.prefix ?? ""
  }

  /** 入口：处理一次 WebDAV 请求 */
  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const method = req.method.toUpperCase()
    const reqPath = this.normalizePath(url.pathname)

    if (method === "OPTIONS") return this.handleOptions()
    if (method === "PROPFIND") return this.handlePropfind(req, reqPath)
    if (method === "GET" || method === "HEAD") return this.handleGet(req, reqPath, method)

    // 其余方法一律只读
    return new Response("本服务为只读模式", {
      status: 403,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    })
  }

  private normalizePath(p: string): string {
    let s = decodeURIComponent(p)
    if (this.prefix && s.startsWith(this.prefix)) {
      s = s.slice(this.prefix.length)
    }
    const segs = s.split("/").filter(Boolean)
    return "/" + segs.join("/")
  }

  private handleOptions(): Response {
    return new Response(null, {
      status: 200,
      headers: {
        DAV: "1,2",
        Allow: "OPTIONS, GET, HEAD, PROPFIND",
        "MS-Author-Via": "DAV",
      },
    })
  }

  /** 解析路径为节点 */
  private async resolveNode(path: string): Promise<VNode | null> {
    const segs = path.split("/").filter(Boolean)

    if (segs.length === 0) {
      return {
        name: "root",
        isDir: true,
        size: 0,
        modified: new Date().toISOString(),
        id: this.client.rootId,
      }
    }

    let parentId: string = this.client.rootId
    let parentPath = "/"

    // CAS 虚拟名 → 真实名的映射，需要在每一层用上
    for (let i = 0; i < segs.length; i++) {
      const want = segs[i]
      const entries = await this.listView(parentId, parentPath)
      const hit = entries.find((e) => e.name === want)
      if (!hit) return null

      if (i === segs.length - 1) return hit
      if (!hit.isDir) return null

      parentId = hit.id
      parentPath = parentPath === "/" ? `/${want}` : `${parentPath}/${want}`
    }
    return null
  }

  /** 列出目录（含 CAS 虚拟化） */
  private async listView(dirId: string, parentPath: string): Promise<VNode[]> {
    const raw = await this.client.list(dirId)
    const out: VNode[] = []

    for (const e of raw) {
      if (!this.virtualize || e.isDir || !isCasName(e.name)) {
        out.push({
          name: e.name,
          isDir: e.isDir,
          size: e.size,
          modified: e.modified,
          id: e.id,
        })
        continue
      }

      // .cas 文件：展示为真实视频名，并预估大小
      let displayName = e.name.replace(/\.cas$/i, "")
      let displaySize = e.size

      try {
        // 仅当需要精确大小时才读取元数据；失败则回退原名
        if (!displayName.includes(".")) displayName = e.name.replace(/\.cas$/i, "")
      } catch {
        displayName = e.name
      }

      out.push({
        name: displayName,
        isDir: false,
        size: displaySize,
        modified: e.modified,
        id: e.id,
        casSource: e.name,
      })
    }

    // 目录在前，其余按名排序
    out.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name, "zh-CN")
    })
    return out
  }

  /* ------------------------------ PROPFIND ------------------------------ */

  private async handlePropfind(req: Request, reqPath: string): Promise<Response> {
    const depth = (req.headers.get("Depth") ?? "1").toLowerCase()
    const node = await this.resolveNode(reqPath)

    if (!node) {
      return new Response("资源不存在", { status: 404 })
    }

    const nodes: Array<{ path: string; node: VNode }> = [{ path: reqPath, node }]

    if (node.isDir && depth !== "0") {
      const children = await this.listView(
        node.id,
        reqPath === "/" ? "/" : reqPath,
      )
      for (const c of children) {
        nodes.push({
          path: joinUrlPath(reqPath, c.name),
          node: c,
        })
      }
    }

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
${nodes.map(({ path, node: n }) => this.renderPropResponse(path, n)).join("\n")}
</D:multistatus>`

    return new Response(xml, {
      status: 207,
      headers: { "Content-Type": 'application/xml; charset="utf-8"' },
    })
  }

  private renderPropResponse(path: string, n: VNode): string {
    const href = encodeHref(path, n.isDir)
    const ctype = n.isDir ? "httpd/unix-directory" : guessMime(n.name)
    return `  <D:response>
    <D:href>${href}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${escapeXml(n.name)}</D:displayname>
        <D:getcontentlength>${n.isDir ? 0 : n.size}</D:getcontentlength>
        <D:getlastmodified>${new Date(n.modified || Date.now()).toUTCString()}</D:getlastmodified>
        <D:resourcetype>${n.isDir ? "<D:collection/>" : ""}</D:resourcetype>
        <D:getcontenttype>${ctype}</D:getcontenttype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`
  }

  /* -------------------------------- GET -------------------------------- */

  private async handleGet(req: Request, reqPath: string, method: string): Promise<Response> {
    const node = await this.resolveNode(reqPath)
    if (!node) return new Response("资源不存在", { status: 404 })
    if (node.isDir) return new Response("这是一个目录", { status: 400 })

    // ① 普通文件：302 跳转到 139 直链
    if (!node.casSource) {
      const url = await this.client.getDownloadUrl(node.id)
      if (method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "Content-Length": String(node.size) },
        })
      }
      return Response.redirect(url, 302)
    }

    // ② CAS 文件：解析元数据 → 秒传恢复 → 取直链
    try {
      await this.engine.sweepTempFiles()
      const casContent = await this.readFileText(node.id)
      const play = await this.engine.resolvePlayLink(casContent, node.casSource)

      if (method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: {
            "Content-Length": String(play.size),
            "Content-Type": guessMime(play.name),
            "Accept-Ranges": "bytes",
          },
        })
      }

      // 302 到真实直链，播放器自行跟随
      return new Response(null, {
        status: 302,
        headers: {
          Location: play.url,
          "Content-Type": guessMime(play.name),
        },
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return new Response(`CAS 播放失败：${msg}`, {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      })
    }
  }

  /** 读取 139 文件为文本（.cas 内容很小，直接全量） */
  private async readFileText(fileId: string): Promise<string> {
    const url = await this.client.getDownloadUrl(fileId)
    const res = await fetch(url, {
      headers: { Referer: "https://yun.139.com/" },
    })
    if (!res.ok) throw new Error(`读取 CAS 文件失败（HTTP ${res.status}）`)
    const text = await res.text()
    if (text.length > 64 * 1024) {
      throw new Error("CAS 文件体积异常，疑似并非有效占位文件")
    }
    return text
  }
}

/* ------------------------------ 工具函数 ------------------------------ */

function joinUrlPath(base: string, name: string): string {
  const b = base === "/" ? "" : base.replace(/\/+$/, "")
  return `${b}/${name}`
}

function encodeHref(path: string, isDir: boolean): string {
  const segs = path.split("/").map((s) => encodeURIComponent(s)).join("/")
  const p = segs.startsWith("/") ? segs : `/${segs}`
  return isDir && !p.endsWith("/") ? `${p}/` : p
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

const MIME: Record<string, string> = {
  mp4: "video/mp4",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  mov: "video/quicktime",
  ts: "video/mp2t",
  m2ts: "video/mp2t",
  flv: "video/x-flv",
  wmv: "video/x-ms-wmv",
  webm: "video/webm",
  rmvb: "application/vnd.rn-realmedia-vbr",
  mp3: "audio/mpeg",
  flac: "audio/flac",
  aac: "audio/aac",
  wav: "audio/wav",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  cas: "text/plain",
}

function guessMime(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  return MIME[ext] ?? "application/octet-stream"
}
