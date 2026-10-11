# 动态客户端接入配置验证

日期：2026-10-11。Goal：按实例中各客户端实际模型分配生成接入配置，补齐 Pi，保存后刷新，
显示未配置或不支持的原因，未配置部署默认模型时隐藏默认组。无新依赖、数据库迁移或代理协议变化。

## 实现范围

- Core 返回客户端分配的公开字段；Panel 解析可用性，不导出供应商密钥、订阅令牌或连接引用。
- 接入页覆盖九种客户端，按各自模型生成示例；不可用项显示原因并隐藏复制按钮。
- Pi 使用已有插件和真实会话 ID，模板包含模型、实例与业务身份占位符，以及 Bash / Zsh 引用转义。
- 模型保存事件按实例隔离，页面重取最新数据；切换实例、窗口聚焦及手动刷新同样更新。
- 默认组无部署模型时隐藏，保留调整已分配客户端的入口，不改写已保存配置。

## 验证结果

| 验证 | 状态 | 范围 |
| --- | --- | --- |
| Core 定向测试 | Passed | `instance-upstream-credential.test.ts`，11 个用例。 |
| Panel 定向测试 | Passed | `client-access-config`、`client-models`、`meta-instance-models`、`upstream-settings-form`，共 24 个用例。 |
| Core / Panel 类型检查 | Passed | 两个包的 `npm run typecheck`。 |
| Panel 构建 | Passed | `npm run build --prefix web` 及 dev Hub 镜像构建。 |
| 浏览器默认组 | Passed | 无部署模型时卡片隐藏；调整入口可打开并取消。 |
| 浏览器动态更新 | Passed | 保存临时模型后返回接入页自动更新；OpenCode 主模型及辅助模型一致。 |
| 浏览器 Pi 状态 | Passed | 移出组后显示未分配、隐藏复制；恢复分配后模板恢复。 |
| 浏览器复制 / 刷新 | Passed | 点击 Pi 复制显示“复制成功”；手动刷新有效。未取得原生剪贴板逐字回读，未将其记为通过。 |
| Claude Code / DeepSeek | Passed | 现有镜像运行真实文件工具；响应 model 和 modelUsage 为 `deepseek-flash`；注入标识、文件结果和 L0 assistant 归档一致，exit 0。 |
| DSH / DeepSeek | Passed | 现有镜像按 `deepseek-flash` 路由完成真实文件工具；注入标识、文件结果和 L0 assistant 归档一致，exit 0。客户端未输出响应 model 回显。 |
| 配置与记忆保留 | Passed | 浏览器测试恢复原值；随后真实调用保留用户最新 DeepSeek 分配。88 条既有 Lab L0/L1 记录缺失 0、变化 0。 |
| 其他四个 DeepSeek 客户端真实调用 | Not Run | 仅核对分配。 |
| 总结 / 新会话召回 / 五 Agent 清空式回归 | Not Run | 本次不覆盖总结和召回矩阵；保留既有记忆，不运行清空流程。 |

真实调用使用各自业务 User Key、新建合成 Agent/Task 和现有镜像，不修改模型组或总结配置。
Claude Code 的自定义模型名提示 `unrecognized_model`，最终 `is_error=false`，未阻止工具执行。
两次调用期间观察到 Proxy 到 DeepSeek DNS 地址的 HTTPS 连接，同时存在代理桥连接；
采样粒度为整个进程，不能把所有连接归因于单次调用。DSH 路由结论以当前配置、成功调用及该连接观测为依据。
浏览器捕获 error 日志为 0；两次真实调用的临时容器均退出，资源审计 Passed。

部署源码以构建基线 `4d36953869b4250aaebaaff146803ab800e5bb15` 加本次 13 个代码及测试文件构建。
提交前重新计算摘要，与构建时全部一致。部署仓库保留脱敏验证记录和逐文件摘要；原始浏览器截图、
客户端输出及连接采样保存在忽略目录，不纳入提交。

## 复现定向检查

在 MemoryPanel 目录执行：

```bash
npm test -- tests/client-access-config.test.ts tests/client-models.test.ts tests/meta-instance-models.test.ts tests/upstream-settings-form.test.ts
npm run typecheck
npm run build --prefix web
```

在 MemoryCore 目录执行：

```bash
npm test -- src/metadata/service/instance-upstream-credential.test.ts
npm run typecheck
```
