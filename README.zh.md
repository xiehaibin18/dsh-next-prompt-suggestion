# dsh-next-prompt-suggestion

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的下一句输入建议插件：一次成功的人类回合结束后，原样重放该会话最后一次普通模型请求并追加一条 suggestion 指令，预测用户下一句最可能输入的内容，在输入框上方以悬浮胶囊展示。在输入框内按 Tab（或点击胶囊）即可把建议填入草稿，草稿非空时点击则复制到剪贴板。

设计移植自已验证的 [Mentat 下一句输入建议](https://github.com/Herbin-s/mentat/pull/199)，基于 DSH 的 Cordis 扩展点重建。

## 工作原理

```text
llm/stream waterfall ─► 捕获该会话最后一次普通对话请求（拷贝，前缀字节一致）
        │
session/event turn/end ─► 门闩：completed 的人类回合，最终 assistant 无工具调用
        │
ctx.llm.stream() ─► 重放 [...捕获的 messages, 最终 assistant, <指令>]
        │                同 provider/model/tools → 命中上游 prompt 缓存
        │
归一化 ─► 单行、≤ 最大字符数、剥引号、不确定则沉默
        │
exact 路由 GET /api/plugins/next-prompt-suggestion?session=<id>
        │
浏览器半 ─► conversation.input.overlay 胶囊（挂载期间轮询）
```

失效是结构性的：每个 `turn/start` 都会中止进行中的重放并丢弃上一条建议，建议不可能活过它所属的回合。重放不携带 `purpose`、绝不重试；任何工具调用增量都会整条丢弃建议。

## 安装

本插件是双半 Cordis 包（host 半负责捕获/生成，浏览器半负责输入框胶囊）。

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

3. 重启 `dsh web`。下一个干净的对话回合结束后，输入框上方出现建议胶囊。

## 配置

所有键均可省略；导出的 Config schema 拥有默认值。

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 捕获、生成与路由的总开关。 |
| `maxSuggestionChars` | `200` | 接受的建议长度硬上限。 |
| `latencyCapMs` | `15000` | 重放延迟上限；中止即丢弃，不重试。 |
| `routePath` | `/api/plugins/next-prompt-suggestion` | 提供实时建议的 exact 路由。 |

## 开发

```bash
bun install
bun run test   # node --test 覆盖纯逻辑模块
```

`lib/prompt.js`、`lib/store.js`、`lib/replay.js` 零依赖且全覆盖单元测试（门闩状态机、重放组装、流归约、输出归一化）。`lib/index.js` 负责接入 host 上下文；`lib/client.js` 是浏览器半。

## 安全说明

- 建议路由由 host webserver 以 exact 路由提供，向同源请求暴露每个会话一行建议文本；DSH 出厂 webserver 只绑定 loopback。请将其视为与其它 feature exact 路由一样的未认证本地状态。
- 建议文本是模型产出的会话衍生内容；浏览器半仅以纯文本渲染。
- 重放请求是拷贝；插件从不改写 loop 构建的请求（运行时本身已 deep-freeze）。

## 已知限制（v0）

- **采纳 = 直接写入草稿。** 在输入框内按 Tab（或点击胶囊）通过聚焦的 Lexical 编辑器自身输入路径（`execCommand("insertText")`）填入空草稿，修订号与撤销历史保持正确；草稿非空时降级为复制到剪贴板。官方 `slash/input-insert-text` 通道需要精确匹配 draft 修订号，而该修订号目前无法跨插件边界读取——待出现修订号可观察对象或按会话作用域的 emit 后切换。
- **轮询式交付。** 浏览器半挂载期间每 4 秒轮询 exact 路由，而非接收推送；host 状态是权威数据源，重连行为天然正确。
- **锚点失效是回合级。** 建议在草稿编辑期间保留（它是胶囊而非 ghost text），下一个回合开始或新建议到达时消失。

## 许可

MIT
