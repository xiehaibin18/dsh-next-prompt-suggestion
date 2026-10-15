# dsh-next-prompt-suggestion

English | [中文](README.zh.md)

Next-prompt suggestion for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): after a successful human turn, the plugin replays the session's last model request verbatim with one appended suggestion-mode instruction, predicts what the user might naturally type next, and shows it as the composer's placeholder - the same shape as the original Mentat feature. The suggestion appears only while the draft is empty (native placeholder semantics), and Tab inside the composer fills it into the draft.

Ported from the proven [Mentat next-prompt suggestion](https://github.com/Herbin-s/mentat/pull/199) design, rebuilt on DSH's Cordis extension points.

## How it works

```text
llm/stream waterfall ─► capture the last ordinary conversation request (copied, frozen prefix)
        │
session/event turn/end ─► gate: completed human turn, final assistant has no tool calls
        │
ctx.llm.stream() ─► replay [...captured messages, final assistant, <instruction>]
        │                same provider/model/tools → upstream prompt cache hits
        │
normalize ─► single line, ≤ max chars, quotes stripped, silent-on-doubt
        │
exact route GET /api/plugins/next-prompt-suggestion?session=<id>
        │
browser half ─► placeholder takeover: ghost node mirroring the native placeholder (hanging GET, instant)
```

Invalidation is structural: every `turn/start` aborts any in-flight replay and drops the previous suggestion, so a suggestion can never outlive the turn it belongs to. The replay carries no `purpose` (it is an ordinary call through `ctx.llm.stream`) and never retries transport or rate-limit failures. The attempt's terminal state decides: an attempt that ends in a tool call chose to work instead of answering, so everything it wrote on the way is discarded and it gets exactly one more round with the same request shape plus one rejection paragraph on the instruction. An attempt that ends in a normal message is the only one ever adopted, tools are never executed, and a second tool-call ending fails the generation. (A fabricated agentic turn - the attempted tool-call message answered by an error tool result - was tried first and abandoned: the provider answered that shape with an empty completion on every run.)

## Install

The plugin is a dual-half Cordis package (host half for capture/generation, browser half for the composer pill).

1. Clone it somewhere stable and install dependencies:

   ```bash
   git clone git@github.com:xiehaibin18/dsh-next-prompt-suggestion.git
   cd dsh-next-prompt-suggestion
   bun install
   ```

2. Add the row to your profile patch — `$DSH_HOME/profiles/web/cordis.patch.yml` for the web profile, or `$DSH_HOME/cordis.patch.yml` for every profile on the machine:

   ```yaml
   - insert:
       - id: next-prompt-suggestion
         name: dsh-next-prompt-suggestion
   ```

   The plugin ships its own `cordis.patch.yml`; when the profile lists the bundle (`dsh bundle add` style flows) the row applies automatically.

3. Restart `dsh web`. After your next clean conversational turn the pill appears above the composer.

## Configuration

All keys are optional; the exported Config schema owns the defaults.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch for capture, generation, and the route. |
| `maxSuggestionChars` | `200` | Hard cap on the accepted suggestion length (reference parity). |
| `latencyCapMs` | `0` (disabled) | Optional per-attempt latency cap, kept as an escape hatch against a genuinely runaway provider. Disabled by default: invalidation-driven abort is the real staleness guard (a new turn aborts the generation and clears the suggestion), and an unfinished generation has no user-visible consequence - a tight cap only silently kills suggestions on slow reasoning models. |
| `routePath` | `/api/plugins/next-prompt-suggestion` | Exact webserver route serving the live suggestion. |

## Development

```bash
bun install
bun run test   # node --test over the pure modules
```

`lib/prompt.js`, `lib/store.js`, and `lib/replay.js` are dependency-free and fully unit-tested (gating state machine, replay assembly, stream reduction, output normalization). `lib/index.js` wires them to the host context; `lib/client.js` is the browser half.

## Security notes

- The suggestion route is served by the host webserver as an exact route. It exposes one suggestion line per session id to same-origin requests; the shipped DSH webserver binds loopback. Treat the route as unauthenticated local state, like other exact feature routes.
- Suggestion text is model output derived from the conversation; the browser half renders it as text only.
- The replay request is a copy; the plugin never mutates loop-built requests (they are deep-frozen by the runtime anyway).

## Known limitations (v0)

- **Accept = direct DOM fill.** Tab inside the composer fills the empty draft through the focused Lexical editor's own input path (`execCommand("insertText")`), so revisions and undo history stay correct. The sanctioned `slash/input-insert-text` channel needs an exact draft-revision match that is not readable across the plugin boundary yet — switching to it is a future iteration once a revision-observable or session-scoped emit exists.
- **Upstream streams are validated.** An attempt only counts as completed when the terminal `finish` chunk arrives (a truncated or empty upstream stream logs `incomplete` with its chunk tally), and text is taken from deltas or a delta-less `block-end` block, never both.
- **Snapshot retention is bounded.** At most 256 sessions keep a captured request snapshot (least recently used evicted), and session disposal drops the tracker, its in-flight generation, and any held response.
- **The instruction carries a producer-owned source kind.** Durable V4 message admission refuses the retired V3 spelling `{ kind: "plugin", plugin }` — `format v4 message requires a producer-owned source kind`, because a bare `plugin` kind carries no producer identity. The instruction and its retry therefore use `{ kind: "<plugin name>", form: "notice" }`.
- **No fixed generation timeout.** A replay runs until it finishes or a turn invalidates it; reasoning models can take 10-20s to emit the suggestion. `latencyCapMs` exists but defaults to disabled.
- **Hanging-GET delivery.** The browser half keeps one hanging request open against the exact route; the host resolves it the moment the suggestion state changes (or after a 30s cap, which the client immediately re-opens), so a new suggestion and turn-start invalidation arrive instantly without a client-side event surface. Offline or host restart backs off 1.5s and resumes.
- **Placeholder takeover, no local visibility state.** The suggestion rides the native `[data-composer-placeholder]` node: React mounts that node only for an empty draft, and a MutationObserver mirrors its (re)appearance with a same-class ghost carrying the suggestion text — typing hides, clearing restores, all for free. The suggestion disappears when the next turn starts or a newer one replaces it.

## License

MIT
