# Pi 客户端包与客户端模板

Panel「API Key → 客户端接入配置 → Pi」提供当前部署的客户端包下载、安装说明和配置复制。
模型与实例地址跟随当前 Pi 分配；Team、Agent 和业务 Key 由使用者填写，不从管理员会话导出。

## 部署接口

`POST /api/v1/meta/client-bundle/pi` 沿用 Panel 实例及登录认证，并调用 Core `auth/verify`
确认业务凭据。空请求返回可用状态和公开版本信息；`{"download":true}` 另返回 ZIP 的 Base64。
响应禁止缓存。未导出、实例不匹配、文件缺失或摘要不匹配时返回明确不可用原因。

`PANEL_CLIENT_BUNDLE_DIR` 指定受部署管理的只读目录，包含：

- `pi-client-bundle.zip`：插件、启动器、配置示例、README、LICENSE、manifest 和可选公开 CA。
- `download.json`：`instanceId`、40 位 `sourceRevision`、`pluginSha256`、`archiveSha256`、
  `piVersion`、成对的 `proxyUrl` / `panelUrl` 和可选 `expectedCaSha256`。未知字段不向客户端透出。

使用本仓库的 [`clients/pi/export.py`](../../clients/pi/export.py) 生成产物，参数、客户端配置及
安装说明见 [`clients/pi/README.md`](../../clients/pi/README.md)。导出不依赖其他仓库或 Lab，
Pi 推荐版本由客户端模块维护。插件唯一源码仍为 `MemoryCore/pi-plugin/index.ts`。

路由不接受文件路径参数。`deploy/global-images/start-memory-hub.sh` 把宿主产物目录只读挂载到
`/data/client-bundles`。下载要求元信息实例及 Proxy 地址匹配当前实例；地址变化后应重新导出。
保留旧元信息兼容：没有部署地址时按页面当前 Proxy 和同域 Panel 生成配置，已有 CA 指纹继续生效。
缺少可选目录时，其他客户端接入不受影响。

客户端接受通用 HTTPS 和路径前缀；`panelUrl` 指定独立 Panel 地址，省略时使用 Proxy origin。
CA 配置成对可选：没有 CA 字段时使用运行时默认信任，有 CA 时验证公开证书指纹后补充信任。
业务 Key 由用户单独提供，不进入 ZIP。Panel 复制配置使用当前分配模型；示例使用占位值。
`install` 只做本地安装，`check` 检查 HTTPS 和业务身份，`run` 检查身份后启动 Pi。
部署包使用 HTTP 或地址不匹配时不生成可复制配置，而显示重新配置 / 导出的原因。

## 源码验证

客户端测试涵盖独立导出、有 / 无 CA、白名单、符号链接、失败回退、旧安装兼容、环境变量、
真实本机 HTTPS、身份校验请求与重定向拒绝。Panel 下载测试使用真实导出 ZIP，并以 fixture
隔离 Core 认证；配置测试覆盖新旧元信息、独立 Panel 和地址不匹配。离线测试不代表已部署。
