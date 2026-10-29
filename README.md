# dsh-next-prompt-suggestion

English | [中文](README.zh.md)

Next-prompt suggestion for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): after a successful human turn, the plugin replays the session's last model request verbatim with one appended suggestion-mode instruction, predicts what the user might naturally type next, and shows it as the composer's placeholder - the same shape as the original Mentat feature. The suggestion appears only while the draft is empty (native placeholder semantics), and Tab in the focused editor fills it into the draft.

Ported from the proven [Mentat next-prompt suggestion](https://github.com/Herbin-s/mentat/pull/199) design, rebuilt on DSH's Cordis extension points.

## How it works

```text
llm/stream waterfall ─► capture the last ordinary conversation request (detached full request)
        │
session/event turn/end ─► gate: completed human turn, final assistant has no tool calls
        │
ctx.llm.stream() ─► replay [...captured messages, final assistant, <instruction>]
        │                same request fields and prefix → upstream prompt cache hits
        │
normalize ─► single line, ≤ max chars, quotes stripped, silent-on-doubt
        │
exact route GET /api/plugins/next-prompt-suggestion?session=<id>
        │
browser half ─► placeholder takeover: ghost node mirroring the native placeholder (hanging GET, instant)
```

Invalidation is structural: every `turn/start` aborts any in-flight replay and drops the previous suggestion, and a surface `replace` event (manual `/compact` rewrites history between turns without opening one) does the same while also stopping a generation from publishing onto the replaced context. A suggestion can never outlive the context it belongs to. The replay is an ordinary `ctx.llm.stream()` call: it keeps the captured `toolHistory`, `sessionId`, `maxTokens`, `stop`, and every other request field, uses a fresh cancellation signal, and is excluded from capture by exact request-object ownership. It never retries transport, rate-limit, error, cancellation, or truncation failures.

The attempt's terminal state decides. Only a `finish` reason of `stop` can produce a suggestion. A tool-call delta, a complete tool-call block, or a `tool-calls` finish rejects the attempt and gets exactly one retry with the same request prefix plus one rejection paragraph; tools are never executed. A second tool-call ending fails. Error, aborted, max-tokens, unknown, missing, and truncated finishes are rejected without salvaging earlier text. (Earlier diagnostics recorded an ostensibly empty replay from an abandoned synthetic tool-result shape, but those logs did not retain the finish reason, so the historical cause remains unverified.)

While the model is still streaming, a local hard cap at twice `maxSuggestionChars` aborts an attempt whose text runs over; it is a runaway guard with headroom and never changes the captured request.

## Install

The plugin is a dual-half Cordis package (host half for capture/generation, browser half for the composer placeholder).

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

3. Restart `dsh web`. After your next clean conversational turn the suggestion appears in the empty composer placeholder.

## Configuration

All keys are optional; the exported Config schema owns the defaults.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch for capture, generation, and the route. |
| `maxSuggestionChars` | `200` | Hard cap on the accepted suggestion length (reference parity). |
| `latencyCapMs` | `0` (disabled) | Optional per-attempt latency cap, kept as an escape hatch against a genuinely runaway provider. Disabled by default: invalidation-driven abort is the real staleness guard (a new turn aborts the generation and clears the suggestion), and an unfinished generation has no user-visible consequence - a tight cap only silently kills suggestions on slow reasoning models. |
| `routePath` | `/api/plugins/next-prompt-suggestion` | Exact webserver route serving the live suggestion. |
| `logToFile` | `true` | Append safe outcome diagnostics to `$DSH_HOME/next-prompt-suggestion.log`. Set `false` to suppress every plugin-written file diagnostic; suggestion text and raw exception payloads are never logged. |

## Development

```bash
bun install
bun run test   # node --test, including production apply(ctx, config) behavior tests
```

`lib/prompt.js`, `lib/store.js`, and `lib/replay.js` are dependency-free and unit-tested (gating state machine, history-replacement invalidation, replay assembly, stream reduction, output normalization). Behavior tests also run the production `apply(ctx, config)` wiring for finish termination, retry limits, streaming overrun aborts, compaction invalidation, request parity, authentication, session bounds, subagent exclusion, disposal, and logging. `lib/client.js` is the browser half.

## Security notes

- The suggestion route is an exact host route guarded before state lookup by the installed DSH connection service's Host/Origin and browser authentication checks. Requests the connection rejects never touch suggestion state. An authenticated query for an unknown session returns 404 without allocating or evicting a tracker; hanging GET delivery applies only to known sessions.
- Suggestion text is model output derived from the conversation; the browser half renders it as text only.
- The replay request is a detached copy of the full captured request. The plugin never mutates the loop-built request or reuses its cancellation signal.

## Known limitations (v0)

- **Accept = direct DOM fill.** Tab in the focused editor fills the empty draft through the Lexical editor's own input path (`execCommand("insertText")`), so revisions and undo history stay correct. The suggestion must still be showing for this composer; toolbar focus and open menus keep normal navigation. The sanctioned `slash/input-insert-text` channel needs an exact draft-revision match that is not readable across the plugin boundary yet — switching to it is a future iteration once a revision-observable or session-scoped emit exists.
- **Upstream streams are validated.** An attempt only counts as completed when its terminal `finish` reason is `stop`; every other finish is a failure, and a stream without `finish` is `incomplete`. Text is taken from deltas or a delta-less `block-end` block, never both.
- **Snapshot retention is bounded.** At most 256 sessions keep a captured request snapshot (least recently used evicted). Session or plugin disposal drops trackers, aborts every attempt, clears timers, and resolves held responses.
- **Subagent turns are excluded.** DSH child sessions carry subagent origin and delegation depth in their headers while their task messages still use `kind: "user"`; the plugin filters those sessions before capture/generation. Top-level conversations, including forks that only share a parent lineage, remain eligible.
- **The instruction carries a producer-owned source kind.** Durable V4 message admission refuses the retired V3 spelling `{ kind: "plugin", plugin }` — `format v4 message requires a producer-owned source kind`, because a bare `plugin` kind carries no producer identity. The instruction and its retry therefore use `{ kind: "<plugin name>", form: "notice" }`.
- **No fixed generation timeout.** A replay runs until it finishes or a turn invalidates it; reasoning models can take 10-20s to emit the suggestion. `latencyCapMs` exists but defaults to disabled.
- **Hanging-GET delivery.** The browser half keeps one hanging request open against the exact route; the host resolves it the moment the suggestion state changes (or after a 30s cap, which the client immediately re-opens), so a new suggestion and turn-start invalidation arrive instantly without a client-side event surface. A failed probe (host restart, session eviction, auth loss, network drop) clears the shown suggestion until the next successful probe, and that first retry fetches the full state without a version so recovery never hangs on a stale or reset version; offline or host restart backs off 1.5s and resumes.
- **Placeholder takeover, no local visibility state.** The suggestion rides the native `[data-composer-placeholder]` node: React mounts that node only for an empty draft, and a MutationObserver mirrors its (re)appearance with a same-class ghost carrying the suggestion text — typing hides, clearing restores, all for free. The suggestion disappears when the next turn starts, history is replaced, a newer one arrives, or the status probe fails.

## License

MIT
