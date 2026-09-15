/**
 * 139OpenList — Cloudflare Workers 主入口
 *
 * 原创实现。一个专注的只读网关：
 * 把移动云盘（139）上的 CAS 占位文件，变成网易爆米花等播放器
 * 可直接点播的媒体库。
 *
 * 路由：
 *   /                → 状态页
 *   /dav/*           → WebDAV（推荐挂载这个到爆米花）
 *   /strm/*          → 列出 .strm 直链文件
 *   /play/*          → 直接播放（返回 302 到真实视频直链）
 *   /api/health      → 健康检查
 */

import { CasPlayEngine } from "./core/player"
import { Yun139Client, Yun139Config, DiskKind } from "./api/yun139"
import { WebdavHandler } from "./webdav/handler"

export interface Env {
  /** 139 鉴权串（敏感，用 Secret 存储） */
  YUN139_AUTH: string
  /** 139 账号（手机号） */
  YUN139_ACCOUNT?: string
  /** 个人云域名，如 https://personal-kd-njs.yun.139.com */
  YUN139_HOST: string
  /** 盘类型：personal / family / group */
  YUN139_KIND?: string
  /** 家庭云或群组 ID */
  YUN139_CLOUD_ID?: string
  /** 根目录 ID，留空用根 */
  YUN139_ROOT_ID?: string
  /** 是否把 .cas 虚拟化成真实视频名，默认 true */
  VIRTUALIZE_CAS?: string
  /** 播放后是否自动清理临时副本，默认 true */
  AUTO_CLEANUP?: string
  /** 扩展名白名单，逗号分隔，如 mp4,mkv,ts */
  ALLOW_EXT?: string
}

const TEMP_DIR = "TEMP"

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // 供播放引擎取用（Serverless 后台清理）
    ;(globalThis as any).__ol_ctx__ = ctx

    const url = new URL(req.url)
    const path = url.pathname

    let client: Yun139Client
    let engine: CasPlayEngine
    try {
      const cfg = buildConfig(env)
      client = new Yun139Client(cfg)
      engine = new CasPlayEngine({
        client,
        autoCleanup: env.AUTO_CLEANUP !== "false",
        allowExt: (env.ALLOW_EXT ?? "")
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      })
    } catch (e) {
      return textResponse(
        `配置错误：${e instanceof Error ? e.message : String(e)}\n\n` +
          `请检查环境变量 YUN139_AUTH / YUN139_HOST 是否已设置。`,
        500,
      )
    }

    // 状态页
    if (path === "/" || path === "") {
      return htmlResponse(renderHome(url.origin))
    }

    if (path === "/api/health") {
      return jsonResponse({ ok: true, service: "139OpenList", ts: Date.now() })
    }

    // WebDAV（爆米花挂这个）
    if (path === "/dav" || path.startsWith("/dav/")) {
      const handler = new WebdavHandler({
        client,
        engine,
        virtualizeCas: env.VIRTUALIZE_CAS !== "false",
        prefix: "/dav",
      })
      return handler.handle(req)
    }

    // STRM 列表
    if (path === "/strm" || path.startsWith("/strm/")) {
      return handleStrm(req, client, engine, url, path)
    }

    // 直接播放
    if (path.startsWith("/play/")) {
      return handlePlay(req, client, engine, path)
    }

    return textResponse("未找到该路径，可用：/  /dav  /strm  /play  /api/health", 404)
  },
} satisfies ExportedHandler<Env>

/* ------------------------------ 路由实现 ------------------------------ */

/** /strm/<路径> —— 列出目录下所有可播视频的 .strm 内容 */
async function handleStrm(
  req: Request,
  client: Yun139Client,
  engine: CasPlayEngine,
  url: URL,
  path: string,
): Promise<Response> {
  const sub = path.replace(/^\/strm\/?/, "")
  const segs = sub.split("/").filter(Boolean)

  // 请求具体文件 → 返回 .strm 内容（一行直链）
  if (segs.length > 0 && segs[segs.length - 1].toLowerCase().endsWith(".strm")) {
    const fileName = segs.pop()!
    const dirId = await client.resolveDirId(segs)
    const entries = await client.list(dirId)
    const wantBase = fileName.replace(/\.strm$/i, "")

    const target =
      entries.find((e) => e.isDir === false && e.name.replace(/\.cas$/i, "") === wantBase) ||
      entries.find((e) => e.name === fileName)

    if (!target) return textResponse("未找到对应文件", 404)

    const playUrl = `${url.origin}/play/${[...segs, target.name].map(encodeURIComponent).join("/")}`
    return new Response(playUrl + "\n", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    })
  }

  // 请求目录 → 列出 .strm 虚拟文件
  const dirId = await client.resolveDirId(segs)
  const entries = await client.list(dirId)
  const lines: string[] = []

  for (const e of entries) {
    if (e.isDir) {
      lines.push(`[DIR] ${e.name}`)
    } else if (e.name.toLowerCase().endsWith(".cas")) {
      lines.push(`${e.name.replace(/\.cas$/i, "")}.strm`)
    }
  }

  return textResponse(lines.join("\n") || "（空目录）")
}

/** /play/<路径> —— 解析 CAS 并 302 到真实直链 */
async function handlePlay(
  req: Request,
  client: Yun139Client,
  engine: CasPlayEngine,
  path: string,
): Promise<Response> {
  try {
    const segs = path.replace(/^\/play\/?/, "").split("/").filter(Boolean).map(decodeURIComponent)
    if (segs.length === 0) return textResponse("缺少文件路径", 400)

    const fileName = segs.pop()!
    const dirId = await client.resolveDirId(segs)
    const entries = await client.list(dirId)
    const target = entries.find((e) => e.name === fileName)
    if (!target) return textResponse("未找到该文件", 404)

    // 普通文件：直接跳到直链
    if (!engine.shouldHandle(target.name)) {
      const u = await client.getDownloadUrl(target.id)
      return Response.redirect(u, 302)
    }

    // CAS 文件：恢复后跳转
    await engine.sweepTempFiles()
    const casText = await readCasText(client, target.id)
    const play = await engine.resolvePlayLink(casText, target.name)

    if (req.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "Content-Length": String(play.size) },
      })
    }
    return new Response(null, { status: 302, headers: { Location: play.url } })
  } catch (e) {
    return textResponse(`播放失败：${e instanceof Error ? e.message : String(e)}`, 500)
  }
}

async function readCasText(client: Yun139Client, fileId: string): Promise<string> {
  const url = await client.getDownloadUrl(fileId)
  const res = await fetch(url, { headers: { Referer: "https://yun.139.com/" } })
  if (!res.ok) throw new Error(`读取 CAS 失败（HTTP ${res.status}）`)
  return await res.text()
}

/* ------------------------------ 配置与响应 ------------------------------ */

function buildConfig(env: Env): Yun139Config {
  if (!env.YUN139_AUTH) throw new Error("缺少 YUN139_AUTH")
  if (!env.YUN139_HOST) throw new Error("缺少 YUN139_HOST")

  const kind = (env.YUN139_KIND ?? "personal").toLowerCase() as DiskKind
  if (!["personal", "family", "group"].includes(kind)) {
    throw new Error(`YUN139_KIND 非法：${env.YUN139_KIND}`)
  }

  return {
    authorization: env.YUN139_AUTH,
    account: env.YUN139_ACCOUNT,
    host: env.YUN139_HOST,
    kind,
    cloudId: env.YUN139_CLOUD_ID,
    rootFolderId: env.YUN139_ROOT_ID,
  }
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  })
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  })
}

function renderHome(origin: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>139OpenList</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
         max-width: 760px; margin: 64px auto; padding: 0 20px; line-height: 1.7; }
  h1 { font-size: 26px; margin-bottom: 4px; }
  .sub { opacity: .6; font-size: 14px; margin-bottom: 28px; }
  .card { border: 1px solid rgba(128,128,128,.25); border-radius: 10px; padding: 16px 18px; margin: 12px 0; }
  code { background: rgba(128,128,128,.15); padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  .ok { color: #16a34a; font-weight: 600; }
  ul { padding-left: 20px; margin: 8px 0; }
  li { margin: 4px 0; }
</style>
</head>
<body>
  <h1>139OpenList</h1>
  <div class="sub">移动云盘 CAS 文件 · 只读播放网关 · 运行于 Cloudflare Workers</div>

  <div class="card">
    <div class="ok">● 服务已启动</div>
    <div style="margin-top:8px">把下面这个地址挂到网易爆米花的 WebDAV 里，即可扫描并播放 CAS 视频：</div>
    <div style="margin-top:8px"><code>${origin}/dav</code></div>
  </div>

  <div class="card">
    <b>可用端点</b>
    <ul>
      <li><code>/dav</code> — WebDAV，<b>推荐给爆米花用这个</b></li>
      <li><code>/strm</code> — 浏览可播文件（.strm 形式）</li>
      <li><code>/play/&lt;路径&gt;</code> — 直接播放，自动 302 到真实视频</li>
      <li><code>/api/health</code> — 健康检查</li>
    </ul>
  </div>

  <div class="card">
    <b>它是怎么工作的</b>
    <ul>
      <li>读取 <code>.cas</code> 占位文件里的元数据（base64 JSON）</li>
      <li>取出其中的 <b>SHA256</b>，向移动云盘发起<b>秒传</b>恢复真实文件</li>
      <li>全程<b>零字节传输</b>，因此无需上传能力，天然适配 Serverless</li>
      <li>播放结束后自动清理临时副本</li>
    </ul>
  </div>
</body>
</html>`
}
