/**
 * 139OpenList — CAS 编解码自测
 *
 * 用于在不连真实云盘的情况下验证核心逻辑正确性。
 * 运行：pnpm tsx scripts/test-cas.ts
 */

import { decodeCas, encodeCas, isCasName, deriveRealName } from "../src/core/cas"

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

console.log("\n=== 1. 文件名判定 ===")
check("movie.mp4.cas 是 CAS", isCasName("movie.mp4.cas"))
check("movie.MP4.CAS 大小写不敏感", isCasName("movie.MP4.CAS"))
check("movie.mp4 不是 CAS", !isCasName("movie.mp4"))
check("从 CAS 名推导原名", deriveRealName("movie.mp4.cas") === "movie.mp4")

console.log("\n=== 2. 编码 → 解码 往返 ===")
const sha256 = "a".repeat(64)
const encoded = encodeCas({
  name: "测试视频.mp4",
  size: 734003200,
  md5: "d41d8cd98f00b204e9800998ecf8427e",
  sha256,
})

check("编码结果非空", encoded.length > 0)
check("编码结果是 base64 字符集", /^[A-Za-z0-9+/=]+$/.test(encoded))

const decoded = decodeCas(encoded)
check("往返后 name 一致", decoded.name === "测试视频.mp4", `实际: ${decoded.name}`)
check("往返后 size 一致", decoded.size === 734003200, `实际: ${decoded.size}`)
check("往返后 sha256 一致", decoded.sha256 === sha256)
check("sliceMd5 缺省回退到 md5", decoded.sliceMd5 === decoded.md5)

console.log("\n=== 3. 容错：缺失 padding ===")
const noPad = encoded.replace(/=+$/, "")
let noPadOk = false
try {
  const d = decodeCas(noPad)
  noPadOk = d.name === "测试视频.mp4"
} catch {
  noPadOk = false
}
check("无 padding 的 base64 也能解码", noPadOk)

console.log("\n=== 4. 容错：含首尾空白 ===")
let wsOk = false
try {
  const d = decodeCas(`\n  ${encoded}  \n`)
  wsOk = d.size === 734003200
} catch {
  wsOk = false
}
check("首尾空白被正确忽略", wsOk)

console.log("\n=== 5. 异常输入必须被拒绝 ===")
function expectThrow(name: string, fn: () => unknown) {
  try {
    fn()
    check(name, false, "未抛出异常")
  } catch {
    check(name, true)
  }
}

expectThrow("空内容", () => decodeCas(""))
expectThrow("非 base64 内容", () => decodeCas("这不是base64!!!@@@"))
expectThrow("base64 但非 JSON", () => decodeCas(btoa("hello world")))
expectThrow(
  "缺 name 字段",
  () => decodeCas(btoa(JSON.stringify({ size: 100, md5: "abc" }))),
)
expectThrow(
  "size 为负",
  () =>
    decodeCas(btoa(JSON.stringify({ name: "a.mp4", size: -1, md5: "abc" }))),
)
expectThrow(
  "无任何哈希",
  () => decodeCas(btoa(JSON.stringify({ name: "a.mp4", size: 1 }))),
)

console.log("\n=== 6. 中文与特殊字符 ===")
const tricky = encodeCas({
  name: '剧集 "S01E01" 第1集.mp4',
  size: 1024,
  sha256: "b".repeat(64),
})
const trickyDecoded = decodeCas(tricky)
check(
  "特殊字符往返无损",
  trickyDecoded.name === '剧集 "S01E01" 第1集.mp4',
  `实际: ${trickyDecoded.name}`,
)

const emojiName = encodeCas({
  name: "🎬电影😀.mkv",
  size: 2048,
  sha256: "c".repeat(64),
})
check("Emoji 文件名往返无损", decodeCas(emojiName).name === "🎬电影😀.mkv")

console.log(`\n${"=".repeat(40)}`)
console.log(`结果：${passed} 通过，${failed} 失败`)
console.log("=".repeat(40))

if (failed > 0) {
  throw new Error(`${failed} 项自测未通过`)
}
