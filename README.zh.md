# dsh-next-prompt-suggestion

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的下一句输入建议插件：一次成功的人类回合结束后，原样重放该会话最后一次普通模型请求并追加一条 suggestion 指令，预测用户下一句最可能输入的内容，直接作为输入框的 placeholder 展示——与 Mentat 原版形态一致。空草稿时才显示（原生 placeholder 语义），在输入框内按 Tab 即填入草稿。

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
浏览器半 ─► placeholder 接管：镜像原生 placeholder 的 ghost 节点（hanging GET，即时）
```

失效是结构性的：每个 `turn/start` 都会中止进行中的重放并丢弃上一条建议，建议不可能活过它所属的回合。重放不携带 `purpose`，传输或限流失败不重试。若模型用工具调用回应指令，该次尝试会被拒绝并**恰好重试一轮**：沿用与首次完全相同的请求形状，仅在指令后追加一段拒绝说明。工具从不执行，第二次仍调工具则放弃。（曾先尝试伪造 agent 回合——把被拒的工具调用配一条 error 工具结果——但该形状每次都被上游回以空补全，故弃用。）

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
| `latencyCapMs` | `0`（关闭） | 可选的单次尝试延迟上限，仅作为对付真正失控 provider 的逃生阀。默认关闭：真正的过期防护是失效驱动（新回合会中止生成并清掉建议），未完成的生成没有用户可见后果——过紧的上限只会静默掐掉慢推理模型上的建议。 |
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

- **采纳 = 直接写入草稿。** 在输入框内按 Tab 通过聚焦的 Lexical 编辑器自身输入路径（`execCommand("insertText")`）填入空草稿，修订号与撤销历史保持正确。官方 `slash/input-insert-text` 通道需要精确匹配 draft 修订号，而该修订号目前无法跨插件边界读取——待出现修订号可观察对象或按会话作用域的 emit 后切换。
- **hanging GET 交付。** 浏览器半对 exact 路由保持一条挂起请求；建议状态变化（或 30 秒上限到期，客户端立即重新打开）的瞬间由 host 主动响应，新建议与回合失效都是即时的，无需客户端事件面。离线或 host 重启时 1.5 秒退避后恢复。
- **placeholder 接管，无本地显隐状态。** 建议寄生在原生 `[data-composer-placeholder]` 节点上：React 仅在空草稿时挂载该节点，MutationObserver 用同 class 的 ghost 节点镜像它的出现/重挂并承载建议文本——输入隐藏、清空恢复全部免费获得。建议在下一个回合开始或新建议到达时失效。

## 许可

MIT
