/**
 * Per-session suggestion state machine: captured request snapshots, turn
 * gating, and the live suggestion. Pure bookkeeping - no LLM calls, no
 * timers, no host services; the service layer in index.js drives it.
 * @module dsh-next-prompt-suggestion/store
 */

const hasToolCallBlocks = (message) => message.content.some((block) => block.type === "tool-call")

/**
 * A surface `replace` event rewrites already-captured history (manual
 * `/compact` runs between turns and never opens one), so the captured replay
 * snapshot no longer describes the live conversation. Append markers carry
 * the literal `"append"`; any other defined `surfaceOp` is a replacement.
 */
const isReplacementSurfaceEvent = (event) =>
	event !== null &&
	typeof event === "object" &&
	event.surfaceOp !== undefined &&
	event.surfaceOp !== "append"

/**
 * Detach one JSON-shaped request value. GenerateOptions messages, tools, and
 * tool history are durable JSON values; structuredClone preserves their full
 * nested prefix while keeping replay state independent of the caller.
 */
const copyRequestValue = (value) => structuredClone(value)

const copyMessage = (message) => copyRequestValue(message)

/**
 * One session's tracker. Events are applied in log order; every
 * `onSessionEvent` returns the action the service layer must take:
 *
 * - `cancel_inflight` - a new turn opened; abort any running replay and drop
 *   the previous suggestion (it is stale by definition).
 * - `generate` - a human turn completed cleanly; replay the captured request.
 * - `none` - no service-layer work.
 */
class SuggestionTracker {
	constructor() {
		/** Last ordinary conversation request of the session, or null. */
		this.snapshot = null
		/** Open-turn bookkeeping: { turn, humanOrigin, lastAssistant } or null. */
		this.turn = null
		/** Live suggestion: { text, turn, anchorMessageId, createdAt } or null. */
		this.suggestion = null
		/**
		 * Monotonic state version, bumped on every suggestion transition
		 * (cleared, replaced, or set). The route layer hands it to hanging
		 * GETs so state changes can be pushed the moment they happen.
		 */
		this.version = 0
		/**
		 * Monotonic history-shape version, bumped whenever a surface
		 * `replace` event rewrites the conversation. A generation records the
		 * version it started against and re-checks it before publishing, so a
		 * replacement racing the generation cannot publish onto a context it
		 * no longer matches.
		 */
		this.contextVersion = 0
		/** Change hook set by the service layer; receives the new version. */
		this.onChange = null
	}

	notifyChange() {
		this.version += 1
		if (this.onChange !== null) this.onChange(this.version)
	}

	/**
	 * Capture one dispatched model request. The service layer selects ordinary
	 * conversation calls and excludes its own suggestion requests before
	 * calling this method.
	 *
	 * @param options - the `llm/stream` waterfall's GenerateOptions.
	 */
	captureRequest(options) {
		if (typeof options.sessionId !== "string") return
		const { signal: _signal, ...request } = options
		this.snapshot = copyRequestValue(request)
	}

	/**
	 * Apply one durable session event.
	 *
	 * @param event - a SessionEvent (`turn/start`, `user/message`,
	 *   `assistant/message`, `turn/end`, ...).
	 * @returns the service-layer action; see the class doc.
	 */
	onSessionEvent(event) {
		const historyReplaced = isReplacementSurfaceEvent(event)
		if (historyReplaced) this.contextVersion += 1
		let action = { type: "none" }
		if (event.type === "turn/start") {
			this.turn = { turn: event.data.turn, humanOrigin: false, lastAssistant: null }
			if (this.suggestion !== null) {
				this.suggestion = null
				this.notifyChange()
			}
			action = { type: "cancel_inflight" }
		} else if (event.type === "user/message") {
			// Only a direct human prompt makes the turn suggestion-worthy;
			// plugin-injected context (`agent.inject()`, memory heads, cron
			// notifications, goal rounds) does not.
			if (this.turn !== null && event.data.source !== undefined && event.data.source.kind === "user") {
				this.turn.humanOrigin = true
			}
		} else if (event.type === "assistant/message") {
			if (this.turn !== null && event.data.turn === this.turn.turn) {
				const message = event.data.message
				this.turn.lastAssistant = {
					step: event.data.step,
					message: copyMessage(message),
					hasToolCalls: hasToolCallBlocks(message),
				}
			}
		} else if (event.type === "turn/end") {
			if (event.data.reason.kind !== "completed") action = { type: "none", reason: "turn_not_completed" }
			else if (this.turn === null) action = { type: "none", reason: "no_open_turn" }
			else if (this.turn.humanOrigin !== true) action = { type: "none", reason: "not_human_origin" }
			else {
				const last = this.turn.lastAssistant
				if (last === null) action = { type: "none", reason: "no_assistant_settlement" }
				else if (last.hasToolCalls) action = { type: "none", reason: "final_assistant_has_tool_calls" }
				else if (this.snapshot === null) action = { type: "none", reason: "no_captured_snapshot" }
				else {
					this.suggestion = null
					action = {
						type: "generate",
						snapshot: this.snapshot,
						assistant: last.message,
						turn: this.turn.turn,
						contextVersion: this.contextVersion,
					}
				}
			}
		}
		if (historyReplaced) {
			if (this.suggestion !== null) {
				this.suggestion = null
				this.notifyChange()
			}
			// A `generate` action and a replacement cannot share one event
			// (turn/end is log-only); any other event type yields a cancel.
			if (action.type !== "generate") action = { type: "cancel_inflight", reason: "history_replaced" }
		}
		return action
	}

	setSuggestion(suggestion) {
		const replacing =
			this.suggestion !== null && suggestion !== null && this.suggestion.text === suggestion.text
		this.suggestion = suggestion
		if (!replacing) this.notifyChange()
	}

	getSuggestion() {
		return this.suggestion
	}
}

export { SuggestionTracker }
