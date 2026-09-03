# TencentDB Agent Memory 安装指南（简体中文）

← 返回 [README_CN.md](./README_CN.md) · English: [INSTALL.md](./INSTALL.md)

本文覆盖三种安装形态：
1. **完整三件套**：`memory-core` + `memory-hub` + `proxy` 一键起（推荐，能让 Claude Code 之类的 coding agent 直接用上团队记忆 / 知识 / skill 注入）
2. **只装 Memory Hub**：已有 Memory Core 运行在本机时的轻量部署
3. **通过 Proxy 使用 Claude Code**：把 coding agent 挂到 proxy 上

---

## 完整三件套：Memory Core + Memory Hub + Proxy（推荐）

一次拉起 `memory-core` + `memory-hub` + `proxy`，并通过 `proxy` 让 Claude Code
之类的 coding agent 直接用上团队记忆 / 知识 / skill 注入：

```bash
# 1) 拿脚本
git clone https://github.com/TencentCloud/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory/deploy/global-images

# 2) 一键起（交互式）
./start-all.sh
```

`start-all.sh` 是**交互式**的，运行时会自动完成：

1. `.env` 不存在时，自动从 `.env.example` 复制一份
2. 引导你填写两组 LLM（回车 = 保留默认值）：
   - `memory 组`：`MEMORY_LLM_BASE_URL` / `MEMORY_LLM_API_KEY` / `MEMORY_LLM_MODEL`（memory + hub 内部用）
   - `proxy 组`：`PROXY_UPSTREAM_URL` / `PROXY_UPSTREAM_API_KEY` / `PROXY_UPSTREAM_MODEL`（proxy 转发上游，可复用 memory 组）
3. 填完**立即检查 LLM 通路**，不通会提示重新输入，直到通过或主动放弃
4. 把填写值写回 `.env` 持久化
5. 通过后拉起三件套

> 干跑校验（可选，只检查不启动）：`./verify.sh`（`--skip-llm` 跳过 LLM 检查）。

启动完成后脚本会自动：

1. 首次启动时用 `init-admin` 生成 admin user，`user_key` 随机 32 位、持久化到
   `./.admin-key`（同一 volume 下每次重启复用）；
2. 立即跑一次 `POST /v3/meta/auth/verify` 校验这把 Key；
3. 打印 Panel 建业务用户的下一步，以及供业务用户 Key 使用的 Claude Code 模板：

    ```bash
    export ANTHROPIC_BASE_URL=http://127.0.0.1:8096/claude-code/default
    export ANTHROPIC_AUTH_TOKEN='<normal-user-key>'
    claude --model <PROXY_UPSTREAM_MODEL 里配的模型>
    ```

bootstrap `.admin-key` 只用于登录 Panel 管理账号和凭证，不要分发或用作日常 Agent Key。

三个服务默认端口：

| 服务 | 端口 | 用途 |
|---|---|---|
| Memory Core | `8420` | 记忆读写、鉴权、skill/RAG 数据面 |
| Panel UI    | `8125` | 团队记忆管理面板 |
| Knowledge   | `8424` | Wiki / Code-Graph 服务 |
| Proxy       | `8096` | LLM 请求代理（Anthropic / OpenAI 双协议） |

---

## 部署完成后：把它跑起来

服务起来只是第一步。要让 coding agent 用上团队记忆，
你还需要在面板里**建组织结构**、然后**在 agent 会话里选它们**。

---

> **⚠️ 本节以 Claude Code 为示例。** 如果你使用的是其他 agent，请直接跳转到对应文档：
>
> | Agent | 文档 |
> |-------|------|
> | CodeBuddy | [`agents/codebuddy/`](./agents/codebuddy/) |
> | WorkBuddy | [`agents/workbuddy/`](./agents/workbuddy/) |
> | Codex | [`agents/codex/`](./agents/codex/) |
> | DeepSeek Harness | [`agents/dsh/`](./agents/dsh/) |
> | OpenCode | [`agents/opencode/`](./agents/opencode/) |
> | Hermes / OpenClaw / 其他 | [`agents/README.md`](./agents/README.md) |

---

### 第 1 步：登录管理面板

打开浏览器访问 **<http://localhost:8125>**（Panel UI）。

- 第一次访问会看到登录页，用 `start-all.sh` 结尾打印的 admin `user_key`
  （即 `deploy/global-images/.admin-key` 文件里那串 `sk-mem-...`）登录
- 顶栏会分别显示“账号类型：`system_admin`”和“当前 Team 角色”。若尚未加入
  Team，后者显示“未加入 Team”
- `system_admin` 只因账号类型获得全局用户与凭证管理能力；Team、Agent、Task、
  Asset 的权限仍取决于它在当前 Team 中的真实角色

> 单实例只允许一个 bootstrap `system_admin`。面板“用户管理”创建的账号固定为
> `normal`，不能创建第二个 `system_admin`。账号类型与 Team 角色是两套独立概念：
> `normal` 也可以是某个 Team 的 owner/admin；`system_admin` 若在 Team 中只是 member，
> 就没有编辑/删除 Team、增删成员或修改角色的权限。

Knowledge Service Swagger（可选，看接口调试用）：
<http://localhost:8424/docs>

### 第 1.5 步：在“用户管理”创建业务用户

1. 用 bootstrap `system_admin` 登录后，打开左侧“组织与权限 → 用户管理”。
2. 点击“新建用户”。页面明确显示账号类型固定为 `normal`。
3. 填写用户名；初始 User_Key 可由 Core 自动生成，也可开启开关后自定义。
4. 创建成功后立即复制并安全保存 User_Key。**完整明文只展示这一次**。
5. 退出登录，用新 Key 登录。顶栏应显示 `normal / 未加入 Team`。

Teamless 用户也会出现在 `system_admin` 的“API Key”清单中；Team 只作为组织关系
上下文，不决定 `system_admin` 是否能管理该用户的凭证。

### 第 2 步：用 normal 用户在面板里建 Team / Agent / Task

Coding agent 用记忆必须落到具体 `team / agent / task` 三元组上：

1. **Team**（团队）：点击顶栏左侧 TeamSwitcher → “新建团队”
   - 一个 Team 是一组资产的归属容器（memory、skill、knowledge 都归 Team）
   - 任意已认证用户都可以创建自己的 Team；创建后自动成为 owner/Team `admin`
2. **Agent**（智能体）：左侧“Agents 管理”，二选一
   - “从 Team 默认模板创建”：先显示将创建的 Agent/模板资产摘要，确认后才创建；
     Team 没有模板时会创建 `default-agent-{username}` 和三个预置 Skill
   - “新建 Agent”：手动填写 `description` + `system prompt`；例如
     `bug-fix 工程师`、`前端评审 agent`、`SQL 优化师`
   - 默认模板创建支持重复点击/超时重试，已完成项不会重复，部分失败时再次确认只补缺失项
3. **Task**（任务，可选）：左侧“任务看板”→“新建 Task”
   - Task 是**这一次工作的抓手**，比如「修复登录页 XSS」「上线 v1.4 灰度」
   - 记忆会关联到 Task；不建 Task 也能用，但 L2/L3 会缺 Task 维度

先建**至少 1 个 Team + 1 个 Agent**，可选建 Task。

### 第 2.5 步：Team admin 添加已有账号并设置角色

1. 让待加入用户从“我的资料”复制自己的 `user_id`。
2. Team owner/admin 打开“成员管理”→“添加成员”，输入该 `user_id`。
3. 添加时选择 `admin`、`member` 或 `reviewer`；以后可在成员卡片中调整。

“成员管理”不会创建全局账号。owner 的角色以及操作者自己的角色被锁定；owner
不可移除。全局 `system_admin` 也只有在当前 Team 确实为 owner/admin 时才会看到
编辑/删除 Team、增删成员和修改角色等入口。

添加成员只建立 membership，**不会静默创建 Agent 或 Asset**。新成员首次登录后，
自行进入“Agents 管理”，选择“从 Team 默认模板创建”并确认，或使用普通表单手动创建。

### 第 2.6 步：交接后安全离组和删除账号

ownership 不随 membership 自动转移或删除。移除成员或删除账号前按以下顺序处理：

1. 用户在左侧“我的资源依赖”查看自己拥有的 Team、Agent、Task、Skill、Wiki、
   Code Graph、Chat Memory 和其他 Asset；inactive、archived 状态也会显示并计入 blocker。
2. 如果页面标记 `membership=absent`，由该 Team owner/admin 在“成员管理”按
   `user_id` 恢复 membership。恢复不会自动生成默认资源。
3. 用户本人在 active membership 下逐项或批量选择处理方式：
   - “转移 ownership”：Agent、Task、Wiki、Code Graph、Chat Memory 可直接转给同 Team
     任意 active member；Skill 单独转移时还必须选择接收用户拥有的 active Agent，并同时
     迁移 Skill 的 backing `owner_agent_id`、Core metadata owner 和固定绑定。Team ownership
     只能转给 active `admin`。接收者无需确认。
   - Agent 是聚合根：转移 Agent 时保留它的全部固定绑定；四类绑定资产（Skill、Wiki、
     Code Graph、Chat Memory）中，owner 与原 Agent owner 相同的资产及相应 backing
     ownership 一并转移，其他成员拥有的共享资产保留原 owner 和绑定。历史
     `user_id`/`creator_user_id` 不改写。即使同时勾选 Agent 和其子资产，Panel 也会归一化
     为一次 Agent 聚合转移，不会把四类子资产重复提交。未勾选 Agent 时，四类子资产仍可
     各自转移或永久清理；借入可见但非本人 owner 的资产只展示，不能勾选。
   - “永久清理”：先清 backing data，再清 metadata 和关系。普通 Agent“归档”不等于
     解除 ownership。
4. ownership 和活动授权归零后，成员可点击“退出当前 Team”，Team owner/admin 也可再次
   点击“移出 Team”。最终提交会在事务中重新检查；若期间又创建了资源，离组被拒绝且
   membership 保持 active。
5. membership 移除后，`system_admin` 才能在“用户管理”删除账号。

`team-member/leave` 和 `team-member/remove` 会在写入事务内重新检查目标用户在当前 Team
所有状态的 Agent、Task、细分 Asset、活动 ACL 和未完成 lifecycle operation；有依赖时
返回结构化 `409` 且 membership 保持不变。成员不能带着资源主动退出，也不能被 admin
强制移出。
`user/delete` 同样检查所有状态的 Team、Agent、Task、Asset，批量请求中任一用户有依赖
都会整批拒绝。`system_admin` 可在用户详情查看依赖名称、状态、Team 和 membership，
但页面不提供业务资源清理或 membership 修改按钮；它也不能代替资源 owner 清理。

### 第 2.7 步：安全解散 Team 与孤立资源治理

- TeamSwitcher 只负责切换和创建，不再放删除图标。永久解散位于 Team 设置的
  Danger Zone，且仅 Team owner 可见。
- 解散前必须只剩 owner 一名 active member，并且 Agent、Task、全部 Asset subtype、
  活动关系、未完成 operation 和 operational integrity finding 全部归零。输入完整 Team
  名称并使用最新 preview revision 后才会删除空 Team；Team admin 调用返回 403。
- `system_admin` 左侧菜单顺序为“用户管理 → 孤立资源治理 → 成员管理 → Agents 管理 →
  我的资源依赖 → API Key”。“孤立资源治理”先扫描再人工处置；可全选允许处置的条目并
  批量彻底清理，但服务端会逐项重新验证，只清理仍为 `operational_orphan` 或
  `cache_residue` 的条目。
- Alice 这类 Team 和 owner 仍存在、只是 membership 缺失的资源属于
  `recoverable_dependency`：治理页只展示恢复路径，`system_admin` 不能借此代删。

### 第 3 步：把 Claude Code 指向 Proxy

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8096/claude-code/default
export ANTHROPIC_AUTH_TOKEN="<第 1.5 步建的业务用户的 sk-mem-...>"
claude --model <PROXY_UPSTREAM_MODEL 里配的上游模型>
```

- `ANTHROPIC_BASE_URL` 把 CC 的 API 从 anthropic.com 改指到本机 proxy；
  路径里的 `default` 是 memory 实例 ID（`x-tdai-service-id`），我们的
  本地部署固定叫 `default`
- `ANTHROPIC_AUTH_TOKEN` 是**业务用户**的 user_key（就是第 1.5 步创建
  用户时返回的 `default_user_key`）；proxy 会用它去 core 反查 user_id，
  只有该用户已加入的 Team 以及其中按现有权限可见的 Agent/Task，才会出现在下一步表单里
- `--model` 用你在 `.env` 里 `PROXY_UPSTREAM_MODEL` 配的那个上游模型名
  （proxy 会把请求转发到 `PROXY_UPSTREAM_URL`）

### 第 4 步：CC 首次会话，选 Team → Agent → Task

**每开一个新的 CC 会话**，proxy 会用 CC 自带的 `AskUserQuestion` 工具
弹出 3 个连续选择：

```
┌─────────────────────────────────────────────────┐
│  1. 请选择本次会话所属的 Team：                    │
│     ○ Team A                                    │
│     ○ Team B                                    │
│                                                 │
│  2. 请选择「Team A」下要使用的 Agent：              │
│     ○ bug-fix 工程师                             │
│     ○ 前端评审 agent                             │
│                                                 │
│  3. 请选择「Team A」下要关联的任务（可选）：         │
│     ○ 修复登录页 XSS                             │
│     ○ [跳过任务关联]                             │
└─────────────────────────────────────────────────┘
```

**每个问题直接在 CC 里用箭头选、回车确认**。选完之后：

- proxy 记住这次会话的 team/agent/task 绑定
- **后续每一轮请求，proxy 会自动把这个 agent 的 L2/L3 记忆、skill、
  knowledge 注入到 system prompt**
- L0（原始对话）会自动落到 memory-core 的 SQLite 里
- 满足触发条件时后台跑 L1（抽 memory）→ L2（scene）→ L3（persona）

只有**新 CC 会话**才会弹表单；同一次 `claude` 进程内的多轮不会再问。

### 第 5 步：观察记忆一层层长出来

聊完一段之后，在面板里看：

- **左侧「记忆」→ Chat Memory**：能看到 L0 原始对话被切分成的 scene
- **「Agent」详情页 → Profile**：agent 的 L2 scene 与 L3 persona 会逐步累积
- **「Skill」列表**：如果对话里 LLM 判定"这是一条可复用的操作方法"，
  会自动抽出 skill 存下来

用 memory-core `/health` 也能看后台 pipeline worker 有没有干活：

```bash
curl -s http://localhost:8420/health | jq .services.pipelineWorker
```

期望看到 `tasksConsumed` / `tasksCompleted` 数字随着对话增长。

### 常见问题

**Q: CC 会话没有弹选择表单？**
可能 proxy 里 `PROXY_ENABLE_SESSION_INIT=1` 没开。`start-all.sh` 默认
`PROXY_FULL_STACK=1` 已经打开；如果你手动改过 `.env` 或用 `PROXY_FULL_STACK=0`
起的，重启 proxy：`PROXY_FULL_STACK=1 ./start-proxy.sh`。

**Q: 表单选择项里空空的，或者只有别人的 team？**
请确认当前使用的账号已加入目标 Team，且该 Team 已创建 Agent。`system_admin` 不会因为
账号类型自动看到所有 Team；若要作为业务身份使用，也必须先加入目标 Team。


**Q: 面板显示"Panel API 8125 未启动"？**
`docker ps` 检查 `tdai-memory-hub` 是不是 healthy；不 healthy 看
`docker logs tdai-memory-hub` 找报错（大概率是 `REMOTE_INSTANCE_URL` /
`LLM_BASE_URL` 之类配错）。

**Q: L1/L2 一直没跑起来，records/ 目录里没东西？**
默认 `promptMode=chat`，对普通对话能抽出 memory；如果你配了
`code` 而对话都是闲聊，LLM 会认为没有可沉淀的东西，返回 0。改回 `chat`
或跟 agent 做**真实工作对话**（改文件、跑测试、给出结论）。

**Q: 想切换到别的 team/agent？**
起一个新的 `claude` 会话（新窗口 / 新 session）就会重新弹选择表单。

---

## 只装 Memory Hub

已有 Memory Core 运行在本机 `8420` 端口时，一条命令拉取 Memory Hub，打开团队记忆面板：

```bash
docker pull docker.io/agentmemory/memory-hub:latest
```

启动 Panel + Knowledge Service：

```bash
docker run -d --name tdai-memory-hub \
  --add-host=host.docker.internal:host-gateway \
  -p 8125:8125 -p 8424:8424 \
  -v tdai-panel-data:/data/knowledge \
  -e REMOTE_INSTANCE_URL=http://host.docker.internal:8420 \
  -e REMOTE_INSTANCE_KEY=local \
  -e KNOWLEDGE_PUBLIC_BASE_URL=http://host.docker.internal:8424/v3 \
  -e LLM_MODE=custom \
  -e LLM_BASE_URL=<OPENAI_COMPATIBLE_BASE_URL> \
  -e LLM_API_KEY=<YOUR_API_KEY> \
  -e LLM_MODEL=<MODEL_ID> \
  docker.io/agentmemory/memory-hub:latest
```

打开 [http://localhost:8125](http://localhost:8125)。

## 通过 Proxy 接入各类 Agent

Proxy 目前支持 8 类 AI Agent 客户端。每个 agent 的**完整接入配置、适配细节、常见问题**
已拆分到独立文档，按需查阅：

| Agent | 配置方式 | 详细文档 |
|-------|----------|----------|
| **Claude Code** | 环境变量 或 `~/.claude/settings.json` | [`agents/claude-code/`](./agents/claude-code/) |
| **CodeBuddy** | `~/.codebuddy/models.json` | [`agents/codebuddy/`](./agents/codebuddy/) |
| **WorkBuddy** | `~/.workbuddy/models.json` | [`agents/workbuddy/`](./agents/workbuddy/) |
| **Codex** | `~/.codex/config.toml`（⚠️ 首次需切 Plan 模式） | [`agents/codex/`](./agents/codex/) |
| **DeepSeek Harness (dsh)** | `~/.dsh/settings.yaml` + `.credentials.yaml` | [`agents/dsh/`](./agents/dsh/) |
| **OpenCode** | `~/.config/opencode/opencode.json` | [`agents/opencode/`](./agents/opencode/) |
| **Hermes** | `~/.hermes/config.yaml` + Header 预选 | [`agents/hermes/`](./agents/hermes/) |
| **OpenClaw** | `~/.openclaw/openclaw.json` + Header 预选 | [`agents/openclaw/`](./agents/openclaw/) |
| **其他平台** | Header 预选（通用） | [`agents/README.md`](./agents/README.md) |

Proxy 会依次做：`auth`（校验 user_key）→ `sessionInit`（选 team/agent/task
表单）→ `injection`（把 L2/L3 记忆、skill、knowledge 注入 system prompt）→
转发到上游 LLM。

关掉完整流水线（只做透传）：`PROXY_FULL_STACK=0 ./start-proxy.sh`。

## 可选能力：`sessionInit.defaultTaskId`（"本次不关联任务"选项）

**做什么用。** 默认情况下,session-init 表单里 Task 一步只列出该用户在面板
里真实创建过的 Task。如果用户还没建过 Task,或者他这轮就是不想把会话绑到
任何 Task 上——表单要么走不下去,要么直接 bypass。配 `sessionInit.defaultTaskId`
可以解决这问题:proxy 会在**每个 team 的 Task 列表最前面**插一条虚拟条目,
label 固定为 `本次不关联任务`。用户选中它,proxy 就用你配置的这个兜底
`task_id` 完成登记,整个流程正常收尾,但不真的挂载到任何 Task 上。

**什么时候开。** 建议在下列场景配上:

- 有 Agent 但还没建 Task,想让 CC / CodeBuddy 用户首次会话选完不卡住;
- 想在每次会话都给用户一个"一键跳过 Task 绑定"的按钮,免得他们手打或
  翻箭头去绕开;
- 用 L2/L3 记忆 + skill,但整体不需要 Task 维度(整套记忆模型里 Task
  本来就是可选的,见前文第 2 步)。

**行为细节。**

- 虚拟条目始终排在每个 team 的 Task 列表**最前面**,真 Task 跟在它后面。
- 选中它 → session 绑到 `task_id = <你的 defaultTaskId>`。这个 ID **不
  需要**在控制面里真实存在——proxy 对它跳过 `getTask` 调用,`taskDetail`
  为 null → 系统提示词里不注入 `[Task]` 块。`team / agent` 绑定完全正常,
  记忆 / skill / 知识注入不受任何影响。
- 不配置 → 表单只显示真 Task(维持老行为)。在这个能力上线之前,标准
  表单路径根本产不出"没绑 Task"的会话——所以别期望不配也有跳过入口。

### 配置

在 proxy `config.yaml` 已有的 `sessionInit` 段里追加 `defaultTaskId` 一行
即可(`start-proxy.sh` 生成的模板里 `sessionInit` 段已经在了):

```yaml
sessionInit:
  enabled: true
  maxRetries: 3
  injectAgentContext: true
  injectTaskContext: true
  defaultTaskId: "no-task"     # 任意稳定字符串,不需要内核里真实存在
  headerAutoSelect:
    enabled: true
    teamHeader: "x-team-id"
    agentHeader: "x-agent-id"
    taskHeader: "x-task-id"
    onMismatch: "form"
```

值随便挑,`no-task` / `default` / 自己的 UUID 都行,只要短且稳定。这个值
会跟着 session-init 请求写到日志 / 埋点里,后续追 trace 时能看到它标记
着"这条会话主动跳过了 Task 绑定"。

> 💡 覆写提醒(同 `/analyse` marker):走 `deploy/global-images/start-proxy.sh`
> 的话,生成的 `config.yaml` 每次启动都会被覆盖——要么改脚本里 YAML 模板
> 加上 `defaultTaskId`,要么用 `PROXY_CONFIG_DIR` 指到你自己维护的
> `config.yaml` 目录。

## 可选能力：`/analyse` URL marker（资产注入效果评估）

**做什么用。** Proxy 内置了一个用于**内部效果评估**的能力,叫**资产反思**
(asset reflection)。开启后,只要请求 URL 里带 `/analyse/` 段,proxy 就会
在系统提示词**末尾**追加一个 `<asset_reflection>` 块,指导 LLM 在最终回答
末尾按固定格式做一次简短复盘——**只对本轮真的调用过的云端资产工具**
(`<skill_tools>` / `<tdai_memory_tools>` / `<knowledge_tools>`)逐个说明:
是否起到作用(拿到了什么关键信息 / 帮它少走了什么弯路 / 或为什么没命中)。
没调过的工具一律不列;本轮完全没调任何工具,仍要输出固定的一行
`【资产反思】本轮未使用任何云端资产工具。`

它的定位是**接入效果验证**——把评测集 / 一次性 curl / 某个 Team 的 staging
CC 会话导到 `/analyse` URL 上,直接读回 LLM 自己给出的逐工具评价,用来判断
skill / 记忆 / 知识注入是否物有所值。**特意做成可选,不建议对线上真实流量
默认打开。**

### 路径写法

把 `/analyse` 作为一段插到 `/{agent}/{spaceId}` 和协议尾巴之间,结构和
`/cost-guard` 完全对称:

```text
# Claude Code(Anthropic Messages)
http://<proxy-host>:<port>/claude-code/<spaceId>/analyse/v1/messages

# CodeBuddy(OpenAI Chat Completions)
http://<proxy-host>:<port>/codebuddy/<spaceId>/analyse/v1/chat/completions

# Codex(OpenAI Responses)
http://<proxy-host>:<port>/codex/<spaceId>/analyse/v1/responses
http://<proxy-host>:<port>/codex/<spaceId>/analyse/responses   # base_url 不带 /v1

# OpenCode(OpenAI Chat Completions,协议同 CodeBuddy)
http://<proxy-host>:<port>/opencode/<spaceId>/analyse/v1/chat/completions
http://<proxy-host>:<port>/opencode/<spaceId>/analyse/chat/completions   # base_url 不带 /v1
```

不带 `/analyse` 的普通请求一字节不改——injector 不 emit 任何块,上游 KV
cache 的前缀完全和平常一致。

### 开启方式(双闸门)

**闸门 1 —— 配置开关。** `injection.assetReflection.markerOptIn` **默认已开
(true)**——`start-proxy.sh` 生成的模板 / `config.example.yaml` 都写着 true,
直接把这个开关删掉也会走默认 true。想显式关掉时才在 proxy `config.yaml` 的
`injection` 段追加:

```yaml
injection:
  enabled: true
  injectors:
    - skill
    - knowledge
    - tdai-memory
  assetReflection:
    markerOptIn: false      # 默认 true;这里显式关掉才不允许 /analyse marker
```

`markerOptIn` 显式为 `false` 时,任何带 `/analyse/` 段的请求都直接
`404 analyse_marker_disabled` 拒绝——用来给"确定不需要资产反思能力"的部署
兜底,避免客户端"以为"打开了 marker 实际却 fall through 到默认透传。

**闸门 2 —— URL 段。** 即便 `markerOptIn: true`,也只有 URL 真的带
`/analyse/` 段时,反思块才会被追加。普通的
`/claude-code/<spaceId>/v1/messages` 完全走原路,和以前一模一样。

### 有效 tag 列表

反思块里列出的 tag 名,由本节点上实际启用的资产 injector 决定
(`skill` / `tdai-memory` / `knowledge`)。一个都没启用时,反思块内容为空
(injector 早退)——所以这个 marker 只有在至少一个资产 injector 挂上
pipeline 时才有意义。

> 💡 如果你走的是 `deploy/global-images/` 的 `start-proxy.sh`,那份
> `config.yaml` 每次启动都会被脚本覆写。要么改 `start-proxy.sh` 里的
> YAML 模板加上 `assetReflection` 段,要么用 `PROXY_CONFIG_DIR` 指向你
> 自己维护的 `config.yaml` 目录,绕开自动生成。

## 关于 `x-task-id` 的已知限制

> ⚠️ **当前版本限制**：`x-task-id` 在 Hermes / OpenClaw 场景下为**必填项**。
>
> Proxy 的 header 预选机制要求 `x-team-id` + `x-agent-id` + `x-task-id` 三者齐全才能完成 session 直接注册。缺少 `x-task-id` 时，Proxy 会尝试弹出交互式表单让用户选择 task，但 Hermes / OpenClaw 无法响应交互式表单，最终导致 session bypass（记忆注入和对话回流均不生效）。
>
> 这带来的不便：
>
> 1. 用户需要预先在面板上创建 Task 并获取 `task_id`，增加了接入门槛。
> 2. 切换不同任务时需要手动修改配置文件中的 `x-task-id`。
>
> 我们将在下一个版本中支持 `x-task-id` 可选：当 header 中未指定 task 时，Proxy 自动选择该 agent 下的默认 task 或跳过 task 绑定，直接完成 session 注册。

## 关于 `x-conversation-id` 的已知限制

> ⚠️ **当前版本限制**：Hermes 和 OpenClaw 需要在配置文件中静态指定 `x-conversation-id`。
> 这与 Claude Code / CodeBuddy 不同（它们由 SDK 自动管理 session ID）。
>
> 当前限制：
>
> 1. **同一个 conversation ID 的所有请求共享同一个 session** —— 记忆注入、对话回流都绑定到这个 ID。
> 2. **每次开启新对话时需要手动更换 conversation ID**，否则会继续沿用上次的 session 状态。
> 3. **部分客户端的 tool call 后续请求可能不携带 extra headers**，导致那些轮次跳过记忆注入和对话回流。
>
> 我们将在下一个版本中优化 conversation ID 的使用体验。

## 停止 / 清理

```bash
./stop-all.sh            # 停容器，保留 volume 数据 & admin key
./stop-all.sh --purge    # 连 volume、admin key、proxy config 一起清
```

## 更多

其它安装形态（OpenClaw、Hermes、CodeBuddy、WorkBuddy、SDK、源码启动、K8s、平台说明），参见
[`deploy/global-images/README.md`](./deploy/global-images/README.md) 与
[`MemoryCore/README_CN.md`](./MemoryCore/README_CN.md)。
