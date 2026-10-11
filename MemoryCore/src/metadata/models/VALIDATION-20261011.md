# Pi、OpenCode 订阅接入验证

日期：2026-10-11。范围：Core 客户端分配校验、Panel 模型与协议选择、Proxy 的
Chat Completions / Responses 转换，以及 OpenCode 工具续轮的助手回答归档。
本记录仅包含脱敏结果；账号信息、凭据、业务身份、会话原文及原始截图不纳入提交。

## 源码验证

| 检查 | 状态 | 结果 |
| --- | --- | --- |
| Core 定向测试 | Passed | 11 个用例，包含订阅客户端范围及凭据引用。 |
| Panel 定向测试 | Passed | 43 个用例，包含模型选择、协议选择及 OpenCode 主模型与辅助模型一致。 |
| Proxy 定向回归 | Passed | 10 个测试文件、237 个用例，包含消息与工具转换、流式/非流式、最终事件补全、失败不归档、不触发提取、凭据隔离、标题隔离及 Codex/API Key 回归。 |
| Core、Proxy、Panel 类型检查 | Passed | 对应包的 `npm run typecheck`。 |
| Panel 构建 | Passed | Web 构建完成，dev 使用包含该构建的 Hub 镜像。 |
| 提交前源码指纹核对 | Passed | 实施完成时的 18 个文件与验收快照完全一致；提交准备只补充本记录及 README。 |

OpenCode 归档修复先通过新增用例复现：工具续轮没有新用户输入时，原实现同时丢弃了最终
助手回答。修复后，有身份的助手续轮可独立归档，不重复写入用户消息；空续轮和无身份请求仍跳过。
真实客户端验证分别检查用户和最终助手的 L0 记录。认证、额度和协议故障的回归使用明确的 HTTP 测试边界。

## 真实客户端矩阵

使用 Pi 0.84.3、OpenCode 1.18.22 的现有镜像与各自业务 User Key，刷新账号列表后固定
7 个模型、14 个客户端/模型组合。每组使用独立合成数据，检查对话、实际工具执行、注入、
L0、同模型 L1 的四项事实及新会话主动召回。Terra 每种客户端重复三次。

| 模型 | Pi | OpenCode |
| --- | --- | --- |
| `gpt-6.1-sol` | Passed | Passed |
| `gpt-6-astra` | Passed | Passed |
| `gpt-6-sol` | Failed（low，2 次）；Passed（high） | Passed |
| `gpt-6-luna` | Passed | Passed |
| `gpt-5.6-sol` | Passed | Passed |
| `gpt-5.6-terra` | Passed（3/3） | Passed（3/3） |
| `gpt-5.6-luna` | Passed | Passed |

首轮矩阵 18 次流程中 17 次 Passed、1 次 Failed；随后两次定向对照分别为 low Failed、
high Passed，共 40 个原生会话。所有对话、初始工具执行、L0 和 L1 总结通过。
Pi 矩阵采用 low，high 对照沿用客户端原有配置；没有覆盖全部推理级别。

Pi / `gpt-6-sol` 的首次失败已查到正确记忆，但生成的命令含无关尾部文本，工具退出 3；
low 复测持续生成工具参数空白并超时，退出 124，失败会话的 L0 残片为 0。
现有证据更符合模型/供应商工具生成不稳定；未保存原始上游 SSE，不能确定供应商内部根因，
也不能把 high 的单次成功解释为稳定性保证。两次失败均保留在结果中。

## 浏览器点击与网络出口

- **Passed**：在已登录的 Panel 实际选择连接和模型、切换认证方式、检查必填提示及更新列表。
  获取账号模型后草稿保留；API 模式需要独立 Key，不复用订阅凭据。
- **Passed**：以 `gpt-6-luna` 点击 5 次连接测试，得到 6 项可用结果：Codex 的 Responses、
  Pi 和 OpenCode 各自的 Chat、混合选择时的两种协议，以及总结的 Chat。
- **Passed**：临时保存对话模型与三客户端分配、保存总结模型，刷新页面确认保留，再恢复原配置。
  这组测试是界面和最小请求验收，完整内容验收见上述客户端矩阵。
- **Passed**：dev Core 与 Proxy 进程启用 `NODE_USE_ENV_PROXY=1`；OpenAI 不在 `NO_PROXY` 中。
  一次独立的 `gpt-6-luna` Responses 最小请求返回 HTTP 200，同时观察到运行中的 Proxy
  连接宿主机代理桥的 `10810` 端口，该桥转发至宿主机 loopback 的 `10809` 代理。
  本次观察未发现该 Proxy 进程直连外网 443；该结论限于本次请求，不代表所有历史流量或代理最终出口节点。
- **Passed**：原配置及凭据摘要恢复，既有 88 条 Lab 记忆缺失 0、变化 0，资产映射未变。
  合成测试记忆保留；临时容器为 0。

## 未执行范围

- **Not Run**：完整五 Agent 清空式回归，会删除需要保留的既有 Lab 记忆。
- **Not Run**：长会话、其他供应商真实调用、主动制造真实额度或认证故障。
- **Not Run**：本轮重新执行完整真实 Codex 验收；Codex/API Key 兼容性由上述定向回归覆盖。
