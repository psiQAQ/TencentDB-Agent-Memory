#!/usr/bin/env bash
# 一键拉起 memory → memory-hub → proxy 三件套。
#
# 顺序：先起 memory（内核），等 healthy；再起 memory-hub（面板+知识），等 healthy；
# 最后起 proxy。任意一步失败会中止并打印容器日志。
#
# 用法：
#   ./start-all.sh            # 启动服务；模型配置在 Panel 中填写和验证
#   PULL=1 ./start-all.sh     # 先 docker pull 三个镜像，升级到最新 latest
#
# .env 不存在时从 .env.example 创建；供应商凭据不写入 .env。

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

# .env 不存在时从模板复制。
if [[ ! -f "$ENV_FILE" ]]; then
  info ".env 不存在，从 .env.example 复制一份"
  cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"
fi

load_env

# 模型配置由 Panel 管理。
info "模型地址、模型 ID 和供应商 Key 在 Panel 中配置"

# 一次性校验全部必填参数，避免拉起 memory 之后才发现 proxy 参数缺
require_vars \
  MEMORY_CORE_IMAGE MEMORY_HUB_IMAGE PROXY_IMAGE \
  MEMORY_CORE_PORT PANEL_PORT KNOWLEDGE_PORT PROXY_PORT \
  MEMORY_CORE_VOLUME PANEL_VOLUME \
  KNOWLEDGE_PUBLIC_BASE_URL \
  MEMORY_CORE_GATEWAY_API_KEY

# 端口预检：一次性检查 4 个目标端口，被外部进程占用则报错退出，
# 避免拉起 memory 之后才发现 hub/proxy 端口冲突。（会排除 tdai 自己旧容器）
check_ports

info "═══ Step 1/3: memory ═══════════════════════════════════════"
"$SCRIPT_DIR/start-memory-core.sh"

info "═══ Step 2/3: memory-hub ═══════════════════════════════════"
"$SCRIPT_DIR/start-memory-hub.sh"

info "═══ Step 3/3: proxy ════════════════════════════════════════"
# 默认打开完整流水线（auth + sessionInit + tdai 注入）。
# 用户可用 PROXY_FULL_STACK=0 关闭；也可在 .env 分别覆盖三个开关。
PROXY_FULL_STACK="${PROXY_FULL_STACK:-1}" "$SCRIPT_DIR/start-proxy.sh"

ok "═══ 全部服务已就绪 ═════════════════════════════════════════"
print_endpoints

# bootstrap Key 只用于登录 Panel 做账号/凭证管理；业务 Agent 使用 normal 用户 Key。
ADMIN_KEY_FILE="${MEMORY_CORE_ADMIN_KEY_FILE:-$SCRIPT_DIR/.admin-key}"
if [[ -s "$ADMIN_KEY_FILE" ]]; then
  echo ""
  echo "  ┌─ 下一步：用 Panel 创建业务用户 ─────────────────────────────────┐"
  echo "  │  1. 用 $ADMIN_KEY_FILE 中的 bootstrap Key 登录 Panel"
  echo "  │  2. 在「用户管理」创建 normal 用户并保存一次性 Key"
  echo "  │  3. normal 用户登录 Panel，创建 Team / Agent / Task"
  echo "  │  4. coding agent 使用 normal 用户 Key："
  echo "  │  export ANTHROPIC_BASE_URL=http://127.0.0.1:${PROXY_PORT}/claude-code/default"
  echo "  │  export ANTHROPIC_AUTH_TOKEN='<normal-user-key>'"
  echo "  │  模型 ID 从 Panel 已启用的对话配置查看"
  echo "  │"
  echo "  │  bootstrap Key 只用于运维，不要分发给业务用户"
  echo "  └────────────────────────────────────────────────────────────────┘"
fi
echo ""
echo "  查看日志：  docker logs -f tdai-memory-core | tdai-memory-hub | tdai-proxy"
echo "  停止服务：  ./stop-all.sh"
echo ""
