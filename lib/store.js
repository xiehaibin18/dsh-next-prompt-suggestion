/**
 * Per-session suggestion state machine: captured request snapshots, turn
 * gating, and the live suggestion. Pure bookkeeping - no LLM calls, no
 * timers, no host services; the service layer in index.js drives it.
 * @module dsh-next-prompt-suggestion/store
 */

/**
 * Defensive copies of the captured request. The loop deep-freezes its
 * requests, but freeze is shallow per level and replay must never alias a
 * live array the loop could still reference; copying at capture time keeps
 * the snapshot stable regardless of later mutations.
 */
const copyMessages = (messages) =>
	messages.map((message) => ({ ...message, content: message.content.map((block) => ({ ...block })) }))

const copyTools = (tools) => {
	if (tools === undefined) return undefined
	return tools.map((tool) => {
		const copy = { ...tool }
		if (copy.parameters !== undefined && typeof copy.parameters === "object") {
			copy.parameters = { ...copy.parameters }
		}
		return copy
	})
}

const hasToolCallBlocks = (message) => message.content.some((block) => block.type === "tool-call")

const copyMessage = (message) => ({ ...message, content: message.content.map((block) => ({ ...block })) })

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
		/** Change hook set by the service layer; receives the new version. */
		this.onChange = null
	}

	notifyChange() {
		this.version += 1
		if (this.onChange !== null) this.onChange(this.version)
	}

	/**
	 * Capture one dispatched model request. Only ordinary conversation
	 * requests qualify: auxiliary calls (compaction, session-title) carry a
	 * `purpose` and hand-built one-shots carry no `sessionId`.
	 *
	 * @param options - the `llm/stream` waterfall's GenerateOptions.
	 */
	captureRequest(options) {
		if (typeof options.sessionId !== "string" || options.purpose !== undefined) return
		this.snapshot = {
			provider: options.provider,
			model: options.model,
			reasoningEffort: options.reasoningEffort,
			temperature: options.temperature,
			tools: copyTools(options.tools),
			messages: copyMessages(options.messages),
		}
	}

	/**
	 * Apply one durable session event.
	 *
	 * @param event - a SessionEvent (`turn/start`, `user/message`,
	 *   `assistant/message`, `turn/end`, ...).
	 * @returns the service-layer action; see the class doc.
	 */
	onSessionEvent(event) {
		if (event.type === "turn/start") {
			this.turn = { turn: event.data.turn, humanOrigin: false, lastAssistant: null }
			if (this.suggestion !== null) {
				this.suggestion = null
				this.notifyChange()
			}
			return { type: "cancel_inflight" }
		}
		if (event.type === "user/message") {
			// Only a direct human prompt makes the turn suggestion-worthy;
			// plugin-injected context (`agent.inject()`, memory heads, cron
			// notifications, goal rounds) does not.
			if (this.turn !== null && event.data.source !== undefined && event.data.source.kind === "user") {
				this.turn.humanOrigin = true
			}
			return { type: "none" }
		}
		if (event.type === "assistant/message") {
			if (this.turn !== null && event.data.turn === this.turn.turn) {
				const message = event.data.message
				this.turn.lastAssistant = {
					step: event.data.step,
					message: copyMessage(message),
					hasToolCalls: hasToolCallBlocks(message),
				}
			}
			return { type: "none" }
		}
		if (event.type === "turn/end") {
			if (event.data.reason.kind !== "completed") return { type: "none" }
			if (this.turn === null || this.turn.humanOrigin !== true) return { type: "none" }
			const last = this.turn.lastAssistant
			if (last === null || last.hasToolCalls || this.snapshot === null) return { type: "none" }
			this.suggestion = null
			return {
				type: "generate",
				snapshot: this.snapshot,
				assistant: last.message,
				turn: this.turn.turn,
			}
		}
		return { type: "none" }
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
