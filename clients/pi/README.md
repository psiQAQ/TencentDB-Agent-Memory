# Pi 客户端包

本目录提供 Pi 安装与启动器、部署专属客户端包导出程序和验证用例。插件唯一源码位于
`MemoryCore/pi-plugin/index.ts`，导出时命名为 `tdai-memory.ts`。

## 为部署导出

在仓库根目录执行；需要 Node.js 22+、Python 3 和 Git，无需安装打包依赖：

```bash
python3 clients/pi/export.py \
  --proxy-url https://memory.example.com/proxy \
  --panel-url https://panel.example.com \
  --instance-id default \
  --output ./workspace/pi-client-bundle
```

使用自定义 CA 时追加 `--ca-file /path/to/public-root.crt`。仅接受一张公开 CA 证书，
不接受私钥或包含私钥的 PEM。Proxy 和 Panel 都须使用 HTTPS；地址可包含端口和路径前缀。
省略 `--panel-url` 时使用 Proxy 的 origin。两个服务须可由客户端直接访问。

输出 `pi-client-bundle.zip`、`download.json` 和包内公开文件。ZIP 只包含启动器、插件、
示例配置、README、LICENSE、manifest，以及可选的 `root.crt`。不会扫描输出目录，已有
业务 Key 和个人配置不会进入 ZIP。输出目录中同名公开产物会更新，其他文件保留。
部署从自定义 CA 切到默认信任时移除旧的公开 `root.crt`。

manifest 记录本仓库 revision、dirty 状态和公开文件摘要。推荐 Pi 版本由
`compatibility.json` 维护，独立于开发测试环境。生成失败退出非零；校验和打包完成后才
发布，发生文件写入错误时恢复原产物。并发导出由 `.pi-export.lock` 拒绝；若进程被强制
终止，确认没有导出进程后移除该锁并重新导出。Panel 在更新期间如发现摘要不匹配会拒绝下载。

使用仓库的全局镜像部署脚本时，将 `PANEL_CLIENT_BUNDLE_DIR` 设置为输出目录的绝对路径，
启动 Hub 后会以只读方式挂载到 `/data/client-bundles`。独立运行 Panel 时，该变量直接指向
产物目录。它是可选部署能力；未导出时页面显示不可用原因。模型、地址或证书变化后核对
Panel 配置；地址或证书变化需要重新导出。模型使用页面当前分配值，示例保留占位值。

## 安装、检查、启动

在 Panel「API Key → 客户端接入配置 → Pi」下载并解压包。按照页面提示安装推荐版本 Pi，
将页面复制的配置保存为 `pi-client.jsonc`，填写自己的 Team、Agent 和可选 Task。
把业务 User Key 单独保存到 `pi-user.key`；Linux/macOS 执行 `chmod 600 pi-user.key`，
Windows 限制该文件为当前用户可读。不要使用管理员 Key 或模型供应商 Key。

在解压目录运行（PowerShell、Bash 均可）：

```bash
node ./pi-client.js install --config ./pi-client.jsonc
node ./pi-client.js check --config ./pi-client.jsonc
node ./pi-client.js run --config ./pi-client.jsonc
```

`install` 仅执行本地安装和校验。`check` 检查 TLS、插件、Pi 版本命令及业务身份，不调用
模型。`run` 通过身份检查后启动 Pi，额外参数置于 `--` 后。`smoke --prompt TEXT` 会调用
配置的模型，只在获准发送提示时使用。

| 字段 | 说明 |
| --- | --- |
| `proxyUrl` | 客户端可访问的 HTTPS Proxy 基地址，保留路径前缀 |
| `panelUrl` | 可选 HTTPS Panel 基地址，保留路径前缀；省略时使用 Proxy origin |
| `spaceId` | 当前实例 ID |
| `teamId` / `agentId` | 业务身份；启动前校验 Team 归属和自己创建的 active Agent |
| `taskId` | 可选业务 Task，空字符串表示不限定 Task |
| `model` | Panel 当前分配给 Pi 的模型；占位值不能启动 |
| `userKeyFile` | 业务 Key 文件，默认 `./pi-user.key` |
| `caFile` / `expectedCaSha256` | 成对可选；自定义公开 CA 和指纹，省略时使用运行时默认信任 |
| `pluginFile` / `piCommand` | 默认 `./tdai-memory.ts` 和 `pi` |

文件路径相对于配置文件。配置使用 JSON 语法；`.jsonc` 后缀兼容已有文件名。
业务 Key 会发送到配置中的 Panel 做身份校验，并发送到 Proxy 调用服务；不跟随重定向。
自定义 CA 补充默认信任，所有 HTTPS 请求均验证证书；子进程强制启用 Node TLS 验证。

启动器将同一 Key 传给 `TDAI_USER_KEY` 和 `TDAI_MEMORY_USER_KEY`，将同一 Proxy 基地址
传给 `TDAI_PROXY_URL` 和 `TDAI_PROXY_BASE_URL`。只影响 Pi 及其子进程；继承的同名旧值被
覆盖。默认信任模式清除子进程继承的 `NODE_EXTRA_CA_CERTS`。保留已有 `NO_PROXY` 排除项，
追加两个服务的具体主机名。会话 ID 由插件动态生成，无需配置固定 ID。

新安装位置为 `~/.pi/agent/extensions/tdai-memory.ts`。若仅存在旧的
`tdai-memory-local-ds.ts`，继续原位维护；两者同时存在时报错，请核对后只保留一份。
同内容安装幂等，不同内容需显式 `install --replace`，替换前备份旧文件。
更新启动器后须退出 Pi 并通过 `run` 重新启动，旧进程不会自动获得环境变量修复。

## 源码验证

在仓库根目录执行。测试使用合成身份；HTTPS 测试启动本机服务，不调用外部模型。
测试还需要 Bash 和 OpenSSL，临时文件保存在被忽略的 `workspace/pi-tests/`。

```bash
node clients/pi/tests/test-client.cjs
node clients/pi/tests/test-https.cjs
python3 clients/pi/tests/test-export.py
```

Panel 的下载链路测试使用此导出程序生成的真实 ZIP；其 Core 认证响应由测试 fixture 隔离，
不能视为真实部署验收。实际 Windows/macOS 安装、浏览器下载及真实模型调用分别记录验证状态。
