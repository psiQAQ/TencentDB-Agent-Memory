# 模型目录与 ChatGPT 连接

`ModelCatalog` 提供实例内的公共目录、账号发现和刷新结果；`ChatGPTConnections`
负责 OAuth 与令牌生命周期。模块使用现有元数据存储和加密主密钥，不依赖 Pi-AI。
上游版本、目录摘要和许可见 [SOURCES.md](./SOURCES.md)。

## 接口与权限

以下接口均为 POST，位于 `/v3/meta/` 下，沿用模型设置的 system admin 权限：

| 路径 | 用途 |
| --- | --- |
| `model-catalog/list` | 读取公共目录、连接快照、订阅连接状态；不请求供应商 |
| `model-catalog/refresh` | 更新公共目录与已配置连接；逐来源返回状态、增删改数量、最近成功时间 |
| `model-catalog/discover` | 用未保存 Key、已保存组或订阅连接获取模型 |
| `model-connections/chatgpt/start` | 创建 PKCE 登录请求，返回登录地址与连接引用 |
| `model-connections/chatgpt/complete` | 验证管理员、state、授权码与 ID token，保存连接并发现账号模型 |
| `model-connections/chatgpt/disconnect` | 本地退出并尝试远端撤销，保留 issued client ID |

Panel 在现有 HTTP 端口提供 `/auth/callback`，将 state 绑定到发起登录的实例和管理员。
页面通过 `model-connections/chatgpt/result` 获取结果。直接向 Panel 提交 complete 被拒绝。
Core 对 complete 仍独立验证身份与 PKCE；Panel 重启会使未完成登录失效。

内部 `/v3/internal/meta/model-connections/chatgpt/resolve` 由现有 Gateway 鉴权保护。
Proxy 提交组引用和模型 ID，Core 重新核对启用状态、认证方式与账号模型列表后返回短期
access token。普通配置缓存和客户端导出不包含 OAuth token。

模型组和 extraction 增加 `provider_id`、`credential_kind`、`credential_ref`。
未提供认证类型的旧配置按 `api_key` 解释。切换认证方式或供应商不能借同一地址复用凭据。
订阅对话组接受 Codex、Pi 和 OpenCode。Codex 使用 Responses；Pi、OpenCode 和后台提取
通过 Proxy 将 Chat Completions 转成 Responses，并将流式或非流式结果还原为客户端协议。
订阅只有在收到 `response.completed` 后才归档和触发提取；额度错误、认证失效和断流
分别报错，由用户手动切换。Panel 按已选客户端分别测试 Chat 转换及 Responses 协议。

## 数据与刷新

SQLite/MongoDB 使用独立 `meta_model_state`，跟随当前实例的元数据存储隔离：

- `catalog:pi`：公共目录的最近成功结果及更新错误。读取失败使用内置快照。
- `account:<group>:<digest>`：按供应商、基础地址、加密凭据版本隔离的 API 账号列表。
- `account:oauth:<reference>:<generation>`：按订阅连接和登录代次隔离。
- `oauth:<reference>`：AES-256-GCM 加密的注册信息、令牌和刷新租约。
- `oauth-pending:<reference>`：加密的十分钟 PKCE 请求，消费后删除，开始登录时清理过期项。
- `oauth-host`：本实例稳定的安装标识，不包含秘密。

写入、轮换和临时状态清理使用版本比较；同一进程合并重复刷新，多个 Core 对象通过数据库
租约串行轮换 refresh token。响应丢失时保留加密记录并要求重新登录，不并发重试可能已消费
的 refresh token。没有定时更新任务。刷新失败保留最近成功列表，并标记最近尝试的错误。
草稿 Key 仅用于本次发现请求，不持久化凭据或结果。

公共目录请求不携带凭据。自动发现只访问本地代码明确列出的官方端点，不跟随重定向。
自定义地址或本地服务仍可手填模型；自动发现不支持的地址会单独报告原因。
供应商原始模型 ID 保留；账号明确返回的信息优先，Pi 补充名称和能力、参考价格。
目录中的调用地址、请求头和兼容配置不参与上游配置。

## 订阅调用

使用腾讯记忆自己的动态公共客户端注册，重登复用 issued client ID；校验 PKCE、state、
nonce、RS256 签名、issuer、audience、账号和调用权限。Core 新增依赖仅 `jose@6.2.10`。
加密使用现有 `TDAI_LLM_CONFIG_ENCRYPTION_KEY_FILE`，备份元数据时必须同时保护并备份此文件。

Proxy 使用公开 `/v1/responses`，固定 `stream: true`、`store: false`，保留输入历史和工具
往返，移除订阅端不支持的参数，拒绝不支持的托管工具。只有 `response.completed` 算成功；
额度、认证和断流分别报错。未完成响应不会触发成功回合归档。Core 配置首次读取失败返回
503，有旧配置则使用旧配置；不会因订阅不可用而自动改用其他计费来源。

Codex 订阅对话使用 HTTP `/responses`；Pi、OpenCode 使用各自客户端路径下的
`/chat/completions`，由 Proxy 转换协议。`/responses/compact`、
`/memories/trace_summarize` 和 `/realtime/calls` 返回明确的不支持错误；客户端导出关闭
WebSocket。真实 Codex 长会话及服务端压缩行为仍需在账号验收时确认。

API 发现测试使用合成 HTTP 响应验证分页、权限、字段和错误边界。OAuth 测试使用临时
RSA 签名验证真实 JOSE 校验流程，但不能代替真实账号授权和模型调用验收。

Pi、OpenCode 的协议回归、真实客户端矩阵、Panel 点击测试与 dev 代理出口结果见
[2026-10-11 验收记录](./VALIDATION-20261011.md)。
