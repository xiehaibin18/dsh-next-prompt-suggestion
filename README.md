# dsh-next-prompt-suggestion

English | [中文](README.zh.md)

Next-prompt suggestion for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): after a successful human turn, the plugin replays the session's last model request verbatim with one appended suggestion-mode instruction, predicts what the user might naturally type next, and shows it as a subtle pill above the composer. Press Tab inside the composer (or click the pill) to fill the suggestion into an empty draft; clicking with a non-empty draft copies it instead.

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
browser half ─► conversation.input.overlay pill (polls while mounted)
```

Invalidation is structural: every `turn/start` aborts any in-flight replay and drops the previous suggestion, so a suggestion can never outlive the turn it belongs to. The replay carries no `purpose` (it is an ordinary call through `ctx.llm.stream`), never retries, and any tool-call delta rejects the whole suggestion.

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
| `maxSuggestionChars` | `200` | Hard cap on the accepted suggestion length. |
| `latencyCapMs` | `15000` | Replay latency cap; aborted replays are discarded, never retried. |
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

- **Accept = direct DOM fill.** Tab inside the composer (or a click) fills an empty draft through the focused Lexical editor's own input path (`execCommand("insertText")`), so revisions and undo history stay correct; a non-empty draft falls back to clipboard copy. The sanctioned `slash/input-insert-text` channel needs an exact draft-revision match that is not readable across the plugin boundary yet — switching to it is a future iteration once a revision-observable or session-scoped emit exists.
- **Poll-based delivery.** The browser half polls the exact route every 4s while mounted instead of receiving a push; reconnect behavior is naturally correct because the host state is authoritative.
- **Anchor invalidation is turn-level.** A suggestion survives minor draft edits (it is a pill, not ghost text), and disappears when the next turn starts or a newer suggestion replaces it.

## License

MIT
