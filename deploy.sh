#!/usr/bin/env bash
# 139OpenList 一键部署到 Cloudflare Workers
set -e

echo "==> 1/5 检查依赖"
command -v node >/dev/null || { echo "请先安装 Node.js 20+"; exit 1; }
command -v pnpm >/dev/null || { echo "正在启用 pnpm..."; corepack enable pnpm; }

echo "==> 2/5 安装依赖"
pnpm install

echo "==> 3/5 类型检查"
pnpm typecheck

echo "==> 4/5 运行自测"
pnpm test:cas

echo "==> 5/5 登录并部署"
if [ ! -f .dev.vars ]; then
  echo "提示: 未找到 .dev.vars，可部署后到 CF 面板配置环境变量"
fi

npx wrangler login
echo ""
echo "接下来设置敏感变量（会提示输入）："
npx wrangler secret put YUN139_AUTH
echo ""
npx wrangler deploy

echo ""
echo "部署完成！把 <你的地址>/dav 挂到网易爆米花的 WebDAV 即可。"
