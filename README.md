# Pi Local CLI

在 Pi 的 `/model` 中选择本机已安装的 AI CLI。Pi 通过 stdio 与 CLI 通信；CLI 仍使用自己的登录状态和供应商服务。插件不读取登录令牌、不代理账号，也不要求安装 Magpie 或 Bun。**本地启动 CLI 不等于离线推理。**

| CLI | 协议 | Pi 默认模型 |
|---|---|---|
| OpenAI Codex | Codex App Server | `local-cli/codex-default` |
| Claude Code + `@agentclientprotocol/claude-agent-acp` | ACP | `local-cli/claude-default` |
| Google Antigravity CLI (`agy`) | ACP | `local-cli/antigravity-default` |
| Grok Build (`grok`) | ACP | `local-cli/grok-default` |

## 安装与使用

需要 Node.js ≥22 和支持原生 provider 注册及自定义 fetch 的 Pi（已验证 Pi 1.5.2）。CLI 要先在终端自行登录，Pi 不会替你登录。

```powershell
cd D:/ForWork/Documents/MyCode/pi-local-cli
npm ci
npm run doctor
pi -e ./index.mjs
```

进入 Pi 后输入 `/local-cli` 查看检测结果，输入 `/model` 搜索 `local-cli`。模型列表只显示已检测到的 CLI；`-default` 让 CLI 决定用什么模型。Pi 刷新模型目录时也会试着获取 CLI 暴露的原生模型；失败时仍保留默认项。检测到可执行文件不代表已经登录或通过兼容性测试。

要让插件在其他工作目录也自动加载：

```powershell
pi install "D:/ForWork/Documents/MyCode/pi-local-cli"
```

不安装也可以从任意目录用 `pi -e "D:/ForWork/Documents/MyCode/pi-local-cli/index.mjs"` 临时加载。只需回复、不向模型提供 Pi 工具时，可以用：

```powershell
pi -e ./index.mjs --provider local-cli --model antigravity-default --no-tools -p "用一句话解释 ACP"
```

### 在 Pi Web 里启用

重启 Pi Web 服务后，打开 **设置 → 模型 → Local CLI**。这里不需要填 API Key。点击 **刷新模型目录**，插件会查询 CLI 并缓存实际返回的具体模型；查询失败时保留上次的目录。打开所需模型的开关，再点右下角 **保存**；然后回到聊天，点击输入框下方的当前模型名称进行切换。已有 `enabledModels` 白名单时，新模型不会自动勾选。

`Antigravity (agy)` 和 `xAI (Grok/X subscription)` 是单独的 provider，不是本插件的 `Local CLI`。

## 诊断和用量

- `/local-cli doctor`：查看可执行文件、模型目录来源、上次成功时间，以及当前进程最近一次查询失败的简要原因。
- `/local-cli doctor probe`：主动查询目录，不发起推理，不修改模型启用列表。Antigravity 的 ACP 目录不可用时回退到 `agy models` 查询；聊天仍通过 ACP。
- `/local-cli usage`：查看当前会话最近一轮的统计。Codex 给 Pi 的用量使用最近一次推理的计数来估算上下文；整轮累计（含多次推理）单独显示在命令结果中，不进入 Pi 的上下文计算。若 ACP 上报了上下文占用，命令优先显示该值；没有就标为估算。Pi Web 顶栏没有独立的累计用量与占用字段，不能把它当作精确账单。统计仅保存在当前会话运行时。

如果 Grok Build 返回 `HTTP 402`，请在 Grok Build CLI 中检查登录账号的用量余额与账单。这与模型发现、Pi 的 API Key 或会话恢复无关。

## 长工具调用

推理时间最多 5 分钟（同一原生轮次内累计），等待 Pi 工具时暂停；每次等待单独最多 10 分钟，并受本地 CLI 自身更短的限制约束。Pi Web 会提示进入等待或失去回传连接，也可用 `/local-cli status` 查看。收到结果后只有原来的 CLI 轮次可以续接；若连接已断、等待过期或被取消，插件**不会自动重放**。先检查 Pi 中已执行的工具结果，再决定是否显式发一条新消息继续。未完成的工具调用不支持跨重启恢复。

## 找不到 CLI？

默认查找 PATH、常见安装目录和 Windows Codex Desktop 的可执行文件。把 `.local-agents.example.json` 复制为同目录的 `.local-agents.json`，删掉不需要的条目，改成真实绝对路径。也可把环境变量 `PI_LOCAL_CLI_CONFIG` 设为另一个配置文件的绝对路径。改好后重启 Pi 或在正式安装后使用 `/reload`。

```json
{
  "executables": {
    "antigravity": "C:/Users/you/AppData/Local/agy/bin/agy.exe"
  }
}
```

Windows 优先用 `.exe`，也支持能解析到 JS 入口的标准 npm `.cmd`，不用 `cmd.exe` 拼接命令。需要前置参数时，可写 `{"path":"D:/Tools/node.exe","args":["D:/Tools/cli-entry.mjs"]}`。Claude Code 本体须用原生可执行文件；ACP 适配器可用 npm 安装：

```powershell
npm install -g @agentclientprotocol/claude-agent-acp
```

配置属于插件用户，不从当前项目读取可执行文件覆盖。只配置你信任的二进制和脚本；它们以当前用户身份运行。插件沿用上游对非原生推理路由的检查；如已有自定义转发配置，CLI 可能需要先切回其官方路由。

## 迁移范围

- 复用 Codex App Server 与 ACP 会话层、流式输出、CLI 上报的 token 用量和 MCP 工具回传。图片需要 CLI 声明支持，整个请求上限为 2 MiB（含 Base64 和历史）。
- CLI 在临时目录启动，插件限制其原生工具并拒绝无关的权限请求；不把项目目录作为 CLI 工作目录。**这不是通用 OS 沙箱。** 模型仍可请求当前 Pi 会话已开放的工具，最终由 Pi 按自己的工具权限和扩展规则执行。
- Chat Completions 是进程内适配，不对外提供 HTTP API。工具回传使用按需启动的、随机端口的本机回环 MCP 中继，按 CLI 会话使用随机令牌。不迁移 Magpie 页面与订阅额度界面。
- CLI 会话在同一个 Pi 会话内、模型/思考级别/工具声明相同且历史匹配时复用；不匹配时重放历史。具体 Codex 型号的上下文窗口从 Codex 自己的 `models_cache.json` 读取 `context_window`，不使用更高的 `max_context_window`。读不到匹配的目录条目时仍显示 128,000 的兜底值；输出上限也是估计，实际限制由 CLI 和供应商决定。

## Antigravity 会话恢复

每轮正常完成后，插件会保持原生进程可供下一轮复用，并把带所有权标记的恢复点保存在 Pi 的 agent 目录下的 `local-cli/agy-checkpoints`（通常是 `~/.pi/agent/local-cli/agy-checkpoints`）。只写会话 ID、模型、时间与历史/工具配置指纹，不另存聊天正文、工具结果、图片或令牌。agy 自己的会话历史仍由 CLI 管理。

同一 Pi 会话在重启后继续聊天时，只有上一轮正常完成、原宿主进程已退出（或干净释放了所有权），且模型、设置、工具清单和历史前缀均匹配，才恢复原生会话并发送新增消息。继续原生会话之前会先使旧恢复点失效，防止中断后的半轮历史被误恢复。恢复点有效期 6 小时。切换分支、压缩历史、升级 CLI 或恢复失败时会开新会话；等待中的工具调用不恢复、不重跑。设置 `PI_LOCAL_CLI_AGY_RESUME=0` 后重启可关闭该功能，仅使用原来的进程内复用。Grok 和 Claude Code 暂不使用磁盘恢复点。

**Codex 仍只复用进程内线程。** 已在 Windows 上用 App Server 0.171.0 实测：`ephemeral: true` 的线程完成真实推理后没有磁盘记录，关闭 App Server 后 `thread/resume` 返回 `no rollout found`。因此插件保留临时线程；重启后从 Pi 已保存的对话历史新开线程，不会隐式启用 Codex 的持久化。

## 代码结构

- `index.mjs`：接入 Pi，注册 provider 和命令。
- `lib/model-discovery.mjs`：探测可用 CLI、发现模型目录并记录诊断；`lib/catalog.mjs` 处理目录数据。
- `lib/history.mjs`：统一计算历史及工具配置指纹、检查前缀、构造续接消息，不管理会话状态。
- `lib/provider.mjs`：负责流式调用与会话状态，包括推理、等待工具、复用与恢复；`lib/session.mjs` 选择适配器：`lib/session/codex.mjs` 处理 Codex App Server，`lib/session/acp.mjs` 处理 Antigravity、Grok 和 Claude Code。两者共用 `lib/session/common.mjs` 的连接与审批辅助代码，以及 `lib/rpc.mjs` 的传输。

## 验证

`npm test` 使用模拟 Codex App Server 和 ACP，不消耗账号额度。另用 Pi 的 print 模式验证了模型注册以及 CLI → MCP → Pi 工具 → CLI 的完整回传链路。

- `node scripts/smoke-agy-pi-web.mjs <Pi-Web-安装目录>`：在临时配置下启动和重启 Pi Web，验证同一会话接入新 MCP 桥、工具只执行一次。默认用模拟 ACP；加 `--live` 用本机真实 `agy`，会使用账号额度。
- `node scripts/benchmark-agy.mjs 2`：比较禁用恢复与启用恢复时的连续回复延迟；加 `--cold-resume` 可测每轮重启 CLI 的代价。会使用 `agy` 额度，不打开工具。
- `node scripts/probe-codex-resume.mjs [Codex 模型 ID]`：在临时目录和只读策略下运行一次短推理，重启 App Server 后尝试读取和恢复该临时线程。会使用 Codex 额度，不使用已有线程或打开工具。

移植来源：[ErkundenSie/magpie-local-agents](https://github.com/ErkundenSie/magpie-local-agents/tree/9828f7ac6eb4d04e121ffb0efb9e17b1604dd40f)，MIT。保留上游 [LICENSE](./LICENSE)。
