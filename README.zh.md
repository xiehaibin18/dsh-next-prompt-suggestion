# dsh-next-prompt-suggestion

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的下一句输入建议插件：一次成功的人类回合结束后，原样重放该会话最后一次普通模型请求并追加一条 suggestion 指令，预测用户下一句最可能输入的内容，直接作为输入框的 placeholder 展示——与 Mentat 原版形态一致。空草稿时才显示（原生 placeholder 语义），编辑区获得焦点时按 Tab 即填入草稿。

设计移植自已验证的 [Mentat 下一句输入建议](https://github.com/Herbin-s/mentat/pull/199)，基于 DSH 的 Cordis 扩展点重建。

## 工作原理

```text
llm/stream waterfall ─► 捕获该会话最后一次普通对话请求（完整字段，独立拷贝）
        │
session/event turn/end ─► 门闩：completed 的人类回合，最终 assistant 无工具调用
        │
ctx.llm.stream() ─► 重放 [...捕获的 messages, 最终 assistant, <指令>]
        │                同请求字段与前缀 → 命中上游 prompt 缓存
        │
归一化 ─► 单行、≤ 最大字符数、剥引号、不确定则沉默
        │
exact 路由 GET /api/plugins/next-prompt-suggestion?session=<id>
        │
浏览器半 ─► placeholder 接管：镜像原生 placeholder 的 ghost 节点（hanging GET，即时）
```

失效是结构性的：每个 `turn/start` 都会中止进行中的重放并丢弃上一条建议；surface `replace` 事件（回合之外的手动 `/compact` 会改写历史、不开启新回合）同样如此，并阻止进行中的生成把结果发布到已替换的上下文上。建议不可能活过它所属的上下文。重放是一次普通的 `ctx.llm.stream()` 调用：保留捕获请求中的 `toolHistory`、`sessionId`、`maxTokens`、`stop` 及其他全部字段，使用新的取消信号，并通过精确的请求对象归属避免被再次捕获。传输、限流、错误、取消或截断均不重试。

以尝试的**终止状态**判定：只有 `finish` 原因为 `stop` 才能产出建议。出现 tool-call delta、完整 tool-call block 或 `tool-calls` finish 时，该尝试作废并**恰好重试一轮**：沿用相同请求前缀，仅在指令后追加拒绝说明；工具从不执行，第二次仍以工具调用结束即失败。error、aborted、max-tokens、未知、缺失或截断的 finish 都不会采纳此前文本。（早期诊断曾记录一种已弃用的伪造工具结果形状看似返回空重放，但日志未保留结束原因，历史成因仍未确认。）

模型仍在流式输出时，本地硬上限（`maxSuggestionChars` 的两倍）会中止文本超长的尝试；这是带余量的失控保护，不会改动捕获的请求。

## 安装

本插件是双半 Cordis 包（host 半负责捕获/生成，浏览器半负责输入框 placeholder）。

1. 克隆到稳定位置并安装依赖：

   ```bash
   git clone git@github.com:xiehaibin18/dsh-next-prompt-suggestion.git
   cd dsh-next-prompt-suggestion
   bun install
   ```

2. 把行加入你的 profile patch —— web profile 用 `$DSH_HOME/profiles/web/cordis.patch.yml`，全机生效用 `$DSH_HOME/cordis.patch.yml`：

   ```yaml
   - insert:
       - id: next-prompt-suggestion
         name: dsh-next-prompt-suggestion
   ```

   插件自带 `cordis.patch.yml`；profile 以 bundle 方式列出本包时该行自动生效。

3. 重启 `dsh web`。下一个干净的对话回合结束后，建议出现在空的输入框 placeholder 中。

## 配置

所有键均可省略；导出的 Config schema 拥有默认值。

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 捕获、生成与路由的总开关。 |
| `maxSuggestionChars` | `200` | 接受的建议长度硬上限（与参考实现一致）。 |
| `latencyCapMs` | `0`（关闭） | 可选的单次尝试延迟上限，仅作为对付真正失控 provider 的逃生阀。默认关闭：真正的过期防护是失效驱动（新回合会中止生成并清掉建议），未完成的生成没有用户可见后果——过紧的上限只会静默掐掉慢推理模型上的建议。 |
| `routePath` | `/api/plugins/next-prompt-suggestion` | 提供实时建议的 exact 路由。 |
| `logToFile` | `true` | 把安全的结构化结果诊断追加到 `$DSH_HOME/next-prompt-suggestion.log`。设为 `false` 会关闭插件写入的全部文件诊断；建议正文与原始异常载荷从不写入日志。 |

## 开发

```bash
bun install
bun run test   # node --test，包含生产入口 apply(ctx, config) 行为测试
```

`lib/prompt.js`、`lib/store.js`、`lib/replay.js` 零依赖并有单元测试（门闩状态机、历史替换失效、重放组装、流归约、输出归一化）。行为测试还会通过生产入口 `apply(ctx, config)` 覆盖结束原因、重试上限、流式超长中止、压缩失效、请求一致性、认证、会话上限、子代理排除、卸载清理和日志。`lib/client.js` 是浏览器半。

## 安全说明

- 建议路由是 host 的 exact 路由，在访问任何状态前先执行已安装 DSH connection 服务的 Host/Origin 与浏览器认证检查；被拒绝的请求不会接触建议状态。认证通过但会话未知时返回 404，不创建或淘汰 tracker；仅已知会话使用 hanging GET。
- 建议文本是模型产出的会话衍生内容；浏览器半仅以纯文本渲染。
- 重放请求是完整捕获请求的独立拷贝；插件从不改写 loop 构建的请求，也不复用它原有的取消信号。

## 已知限制（v0）

- **采纳 = 直接写入草稿。** 编辑区获得焦点时按 Tab，通过 Lexical 编辑器自身输入路径（`execCommand("insertText")`）填入空草稿，修订号与撤销历史保持正确。该输入框的建议必须仍在显示；工具栏获得焦点或菜单打开时保留正常导航。官方 `slash/input-insert-text` 通道需要精确匹配 draft 修订号，而该修订号目前无法跨插件边界读取——待出现修订号可观察对象或按会话作用域的 emit 后切换。
- **上游流会校验结束原因。** 只有 terminal `finish` 的 `reason.kind` 为 `stop` 才视为完成；其他 finish 一律失败，没有 finish 的流记为 `incomplete`。文本来自 deltas 或没有 deltas 时的整个 `block-end` block，任选其一。
- **hanging GET 交付。** 浏览器半对 exact 路由保持一条挂起请求；建议状态变化（或 30 秒上限到期，客户端立即重新打开）的瞬间由 host 主动响应，新建议与回合失效都是即时的，无需客户端事件面。一次失败的状态探测（host 重启、会话淘汰、认证失效、网络中断）会清除已显示的建议，直到下一次探测成功，且首次重试不带版本号、强制获取完整状态，恢复不会卡在过期或重置的版本上；离线或 host 重启时 1.5 秒退避后恢复。
- **快照保留有上限。** 最多 256 个会话保留请求快照（按最近最少使用淘汰）。会话或插件销毁时清除 tracker、中止全部尝试、清理计时器并结束挂起的响应。
- **排除子代理回合。** DSH 子会话 header 带有 subagent origin 和 delegation depth，而子代理任务消息仍使用 `kind: "user"`；插件在捕获和生成前过滤这些会话。普通顶层会话（包括仅共享 parent lineage 的 fork）仍可生成。
- **指令消息带生产者自有的 source kind。** V4 的持久化消息准入**拒收**已退役的 V3 写法 `{ kind: "plugin", plugin }`（报 `format v4 message requires a producer-owned source kind`——裸 `plugin` 不携带生产者身份）。指令与重试消息因此改用 `{ kind: "<插件名>", form: "notice" }`。
- **placeholder 接管，无本地显隐状态。** 建议寄生在原生 `[data-composer-placeholder]` 节点上：React 仅在空草稿时挂载该节点，MutationObserver 用同 class 的 ghost 节点镜像它的出现/重挂并承载建议文本——输入隐藏、清空恢复全部免费获得。建议在下一个回合开始、历史被替换、新建议到达或状态探测失败时失效。

## 许可

MIT
