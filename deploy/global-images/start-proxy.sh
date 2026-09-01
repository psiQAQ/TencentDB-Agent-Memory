#!/usr/bin/env bash
# 单独拉起 proxy（context-proxy，端口 8096）。
#
# proxy 的转发上游走 PROXY_UPSTREAM_URL（与 memory 组的 MEMORY_LLM_* 独立）。
# proxy 会调 memory:8420 做鉴权 / skill / tdai memory 注入；调 memory-hub:8125
# 做 sessionInit control plane。可以单跑 proxy 但相关能力会降级 / 关闭。
#
# 用法：
#   ./start-proxy.sh
#
# 需要以下 proxy 组参数（写在 .env）：
#   PROXY_UPSTREAM_URL / PROXY_UPSTREAM_API_KEY / PROXY_UPSTREAM_MODEL

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

load_env
require_vars \
  PROXY_IMAGE PROXY_PORT \
  PROXY_UPSTREAM_URL PROXY_UPSTREAM_API_KEY PROXY_UPSTREAM_MODEL \
  MEMORY_CORE_GATEWAY_API_KEY

# 与 memory-core 保持一致的 gateway 内部凭据。
MEMORY_CORE_GATEWAY_API_KEY="${MEMORY_CORE_GATEWAY_API_KEY:?}"

CONTAINER=tdai-proxy
NETWORK=tdai-memory-stack

if ! $DOCKER network inspect "$NETWORK" >/dev/null 2>&1; then
  info "创建 docker 网络 $NETWORK"
  $DOCKER network create "$NETWORK" >/dev/null
fi

# 依赖检查（不阻塞，仅提醒）
if ! $DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -qx "tdai-memory-core"; then
  warn "memory-core 容器未运行，proxy 的 auth / tdai memory / skill 注入将全部降级。"
fi
if ! $DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -qx "tdai-memory-hub"; then
  warn "memory-hub 容器未运行，proxy 的 sessionInit control plane 不可达。"
fi

pull_image "$PROXY_IMAGE"
rm_container_if_exists "$CONTAINER"

# proxy 只从 YAML 读上游 URL / API key（不认 PROXY_UPSTREAM_URL 环境变量），
# 所以我们从 .env 生成一个最小 config.yaml 挂到容器 /data/config.yaml。
# 容器 CMD 已经是 [--config /data/config.yaml]。
CONFIG_DIR="${PROXY_CONFIG_DIR:-$SCRIPT_DIR/.proxy-config}"
mkdir -p "$CONFIG_DIR"
CONFIG_FILE="$CONFIG_DIR/config.yaml"

# ── 四大能力开关（默认最小可用；打开时自动串联依赖）──
# PROXY_ENABLE_AUTH        : 客户端凭 x-tdai-user-key 走内核 auth/verify → user_id
# PROXY_ENABLE_SESSION_INIT: 首轮弹表单选 team/agent/task；依赖 auth+tdai
# PROXY_ENABLE_TDAI        : L2/L3 记忆注入 + L1 召回；依赖 memory-core
# PROXY_ENABLE_KNOWLEDGE   : <knowledge_tools> 块注入（code-graph / wiki 资源）；依赖 memory-core
#                            （注意：injection.injectors 恒列 knowledge，但缺 knowledge:
#                             段时 shouldRegisterKnowledgeInjector 判 false 不注册 ——
#                             所以必须由这里生成 knowledge: 段，不能只列 injector 名）
#
# 便捷开关 PROXY_FULL_STACK=1 一键把四个都开。
if [[ "${PROXY_FULL_STACK:-0}" == "1" ]]; then
  PROXY_ENABLE_AUTH=1
  PROXY_ENABLE_TDAI=1
  PROXY_ENABLE_SESSION_INIT=1
  PROXY_ENABLE_KNOWLEDGE=1
fi
PROXY_ENABLE_AUTH="${PROXY_ENABLE_AUTH:-0}"
PROXY_ENABLE_TDAI="${PROXY_ENABLE_TDAI:-0}"
PROXY_ENABLE_SESSION_INIT="${PROXY_ENABLE_SESSION_INIT:-0}"
PROXY_ENABLE_KNOWLEDGE="${PROXY_ENABLE_KNOWLEDGE:-0}"
PROXY_OPENAI_UPSTREAM_URL="${PROXY_OPENAI_UPSTREAM_URL:-$PROXY_UPSTREAM_URL}"
PROXY_ANTHROPIC_UPSTREAM_URL="${PROXY_ANTHROPIC_UPSTREAM_URL:-$PROXY_UPSTREAM_URL}"

# sessionInit 依赖 auth 拿 user_id；开 sessionInit 时自动补 auth
if [[ "$PROXY_ENABLE_SESSION_INIT" == "1" && "$PROXY_ENABLE_AUTH" != "1" ]]; then
  warn "PROXY_ENABLE_SESSION_INIT=1 需要 auth；自动打开 PROXY_ENABLE_AUTH"
  PROXY_ENABLE_AUTH=1
fi

# knowledge 依赖 tdai 内核（endpoint 同 memory-core）；开 knowledge 时自动补 tdai
if [[ "$PROXY_ENABLE_KNOWLEDGE" == "1" && "$PROXY_ENABLE_TDAI" != "1" ]]; then
  warn "PROXY_ENABLE_KNOWLEDGE=1 需要 tdai 内核；自动打开 PROXY_ENABLE_TDAI"
  PROXY_ENABLE_TDAI=1
fi

bool() { [[ "$1" == "1" ]] && echo "true" || echo "false"; }

info "生成 proxy config → $CONFIG_FILE  (auth=$(bool $PROXY_ENABLE_AUTH) session-init=$(bool $PROXY_ENABLE_SESSION_INIT) tdai=$(bool $PROXY_ENABLE_TDAI) knowledge=$(bool $PROXY_ENABLE_KNOWLEDGE))"
cat > "$CONFIG_FILE" <<YAML
# 由 start-proxy.sh 自动生成 —— 每次启动覆盖，请不要手动改。
server:
  host: 0.0.0.0
  port: 8096
  forwardTimeoutMs: 600000

upstream:
  url: "${PROXY_UPSTREAM_URL}"
  apiKey: "${PROXY_UPSTREAM_API_KEY}"
  agents:
    codebuddy:
      url: "${PROXY_OPENAI_UPSTREAM_URL}"
      apiKey: "${PROXY_UPSTREAM_API_KEY}"
    dsh:
      url: "${PROXY_OPENAI_UPSTREAM_URL}"
      apiKey: "${PROXY_UPSTREAM_API_KEY}"
    claude-code:
      url: "${PROXY_ANTHROPIC_UPSTREAM_URL}"
      apiKey: "${PROXY_UPSTREAM_API_KEY}"

log:
  file: ""
  level: info
  backend: console

# tdai 内核对接（用于 injection / skill / auth 拉取）
tdai:
  enabled: $(bool $PROXY_ENABLE_TDAI)
  endpoint: "http://memory-core:8420"
  apiKey: "${MEMORY_CORE_GATEWAY_API_KEY}"
  serviceId: default
  memory:
    enabled: true
    inject: true
    writeL0: true
    recallL1: true
    injectL2L3: true

skill:
  endpoint: "http://memory-core:8420"
  serviceToken: "${MEMORY_CORE_GATEWAY_API_KEY}"

# knowledge 注入（<knowledge_tools> 块）：从内核拉取 team 的
# code-graph / wiki 资源列表。与 skill 段独立（endpoint 可不同）。
# 缺此段时 injector 不注册（injectors 列了 knowledge 也没用）。
knowledge:
  enabled: $(bool $PROXY_ENABLE_KNOWLEDGE)
  endpoint: "http://memory-core:8420"
  serviceToken: "${MEMORY_CORE_GATEWAY_API_KEY}"
  serviceId: default
  timeoutMs: 1500

auth:
  enabled: $(bool $PROXY_ENABLE_AUTH)
  url: "http://memory-core:8420"
  serviceToken: "${MEMORY_CORE_GATEWAY_API_KEY}"
  timeoutMs: 5000

sessionInit:
  enabled: $(bool $PROXY_ENABLE_SESSION_INIT)
  maxRetries: 3
  injectAgentContext: true
  injectTaskContext: true
  headerAutoSelect:
    enabled: true
    teamHeader: "x-team-id"
    agentHeader: "x-agent-id"
    taskHeader: "x-task-id"
    onMismatch: "form"

costGuard:
  enabled: false

# 打开 skill + knowledge + tdai-memory 三个注入器。
# 注意：injectors 列表只是第一道开关；knowledge 实际注册还需要
# 上方的 knowledge: 段（enabled + serviceToken），否则恒不注册。
injection:
  enabled: true
  externalGatewayUrl: "${PROXY_EXTERNAL_GATEWAY_URL:-}"
  injectors:
    - skill
    - knowledge
    - tdai-memory

redis:
  enabled: false
YAML

# 镜像以 uid 10001 非 root 运行。bind mount 保留宿主文件权限，因此只给
# 当前宿主 primary group 读取权，并把该 group 映射进容器；避免改成 0644
# 让同机其他用户读到 upstream API key。
chmod 640 "$CONFIG_FILE"
CONFIG_GID="$(id -g)"

info "启动 proxy (image=$PROXY_IMAGE, port=$PROXY_PORT)"
$DOCKER run -d --name "$CONTAINER" \
  --group-add "$CONFIG_GID" \
  --network "$NETWORK" \
  --network-alias proxy \
  --add-host=host.docker.internal:host-gateway \
  -p "${PROXY_PORT}:8096" \
  -v "$CONFIG_FILE:/data/config.yaml:ro" \
  "$PROXY_IMAGE" >/dev/null

wait_healthy "$CONTAINER" 90
ok "proxy 已启动 → http://localhost:${PROXY_PORT}/"
ok "  用法：把 coding agent 的 API base 指向 http://localhost:${PROXY_PORT}"
