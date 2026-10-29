/**
 * Replay request assembly and stream reduction.
 *
 * The replay reuses every captured request field and its exact message prefix
 * so the upstream prompt cache can hit, then appends the settled assistant
 * message and one suggestion-mode instruction user message:
 * `[...original messages, assistant, instruction]`.
 *
 * When the model answers that instruction with a tool call instead of text,
 * the attempt is rejected and retried exactly once with the same request
 * prefix plus one rejection paragraph on the instruction. Tools are never
 * executed, and a second tool call gives up.
 * @module dsh-next-prompt-suggestion/replay
 */

/** Rejection notice appended to the instruction for the single retry round. */
const TOOL_REJECTION_NOTICE =
	"Your previous reply attempted to call a tool. Tool calls are not available in suggestion mode: reply with only the suggested next user input as plain text."

const instructionMessage = (instruction, pluginName, extraNotice) => ({
	id: globalThis.crypto.randomUUID(),
	role: "user",
	content: [{ type: "text", text: extraNotice === undefined ? instruction : `${instruction}\n\n${extraNotice}` }],
	// Producer-owned source kind. The retired V3 spelling
	// `{ kind: "plugin", plugin }` is refused by V4 durable admission
	// ("format v4 message requires a producer-owned source kind"), because a
	// bare `plugin` kind carries no producer identity. The reference
	// migration maps an unknown plugin name to `plugin:<name>`; the plugin's
	// own package name is the same producer-owned identity, so use it.
	source: { kind: pluginName, form: "notice" },
})

const copyRequest = (snapshot) => structuredClone(snapshot)

const SAFE_FAILURE_CODE = /^[a-z0-9][a-z0-9_.:-]{0,79}$/iu

const finishFailureCode = (reason) => {
	const code = reason?.failure?.code
	return typeof code === "string" && SAFE_FAILURE_CODE.test(code) ? code : "unknown"
}

/**
 * Assemble the replay request from a captured snapshot.
 *
 * @param input.snapshot - the captured ordinary conversation request.
 * @param input.assistant - the turn's final settled assistant message.
 * @param input.instruction - suggestion-mode instruction text.
 * @param input.pluginName - producing plugin identity for the message source.
 * @returns a GenerateOptions-shaped request for `ctx.llm.stream()`.
 */
const buildReplayRequest = ({ snapshot, assistant, instruction, pluginName }) => {
	const request = copyRequest(snapshot)
	request.messages = [...request.messages, structuredClone(assistant), instructionMessage(instruction, pluginName)]
	return request
}

/**
 * Assemble the single retry request for a rejected attempt.
 *
 * The retry keeps the same request fields and message prefix (cache parity)
 * and reuses the exact shape of the first attempt - only the instruction
 * carries one extra rejection paragraph. An earlier, abandoned implementation
 * instead synthesized a tool-result turn; diagnostics recorded apparently
 * empty output for that shape, but did not retain the finish reason, so its
 * historical cause remains unverified. The current rejection-paragraph shape
 * does not add a fabricated assistant or tool-result message.
 *
 * @param input.snapshot - the captured ordinary conversation request.
 * @param input.assistant - the turn's final settled assistant message.
 * @param input.instruction - suggestion-mode instruction text.
 * @param input.pluginName - producing plugin identity for the message source.
 * @returns a GenerateOptions-shaped request for `ctx.llm.stream()`.
 */
const buildRetryRequest = ({ snapshot, assistant, instruction, pluginName }) => {
	const request = copyRequest(snapshot)
	request.messages = [
		...request.messages,
		structuredClone(assistant),
		instructionMessage(instruction, pluginName, TOOL_REJECTION_NOTICE),
	]
	return request
}

/**
 * Reduce a replay StreamChunk stream. Text deltas accumulate; the first
 * tool-call delta rejects the whole attempt (a suggestion must be plain
 * user-voice text) while the attempted calls accumulate for the retry;
 * usage is captured for logging. Only a normal `stop` finish is adoptable;
 * every other finish reason is a failed attempt. A complete tool-call block
 * rejects just like a tool-call delta.
 *
 * An optional `maxChars` enforces a local streaming hard cap on the
 * accumulated text: exceeding it is a terminal `over_limit` outcome so the
 * caller can abort the attempt (and skip the tool-call retry) instead of
 * consuming an unbounded reply that normalization would discard anyway.
 *
 * @returns `{ push(chunk) -> "continue" | "tool_call" | "done" | "failed" | "over_limit", ... }`.
 */
const createStreamReducer = ({ maxChars } = {}) => {
	/** Per-index text: deltas accumulate, a delta-less block-end supplies the block text. */
	const textByIndex = new Map()
	let usage = undefined
	/** Chunk-type tally for the outcome log (diagnoses empty/failed upstream streams). */
	const chunkTypes = new Map()
	let sawFinish = false
	let finishKind = null
	let terminalFailureCode = null
	let totalChars = 0
	let overLimit = false
	const toolCalls = new Map()
	return {
		push(chunk) {
			const type = typeof chunk.type === "string" ? chunk.type : "unknown"
			chunkTypes.set(type, (chunkTypes.get(type) ?? 0) + 1)
			if (chunk.type === "text-delta") {
				const text = (textByIndex.get(chunk.index) ?? "") + chunk.text
				textByIndex.set(chunk.index, text)
				totalChars += chunk.text.length
				if (maxChars !== undefined && totalChars > maxChars) overLimit = true
				return overLimit ? "over_limit" : "continue"
			}
			if (chunk.type === "block-end" && chunk.block !== undefined && chunk.block.type === "text") {
				// A provider may deliver a block whole; deltas win when both
				// arrive so the text is never counted twice.
				const streamed = textByIndex.get(chunk.index)
				if (streamed === undefined || streamed.length === 0) {
					textByIndex.set(chunk.index, chunk.block.text)
					totalChars += chunk.block.text.length
					if (maxChars !== undefined && totalChars > maxChars) overLimit = true
					if (overLimit) return "over_limit"
				}
				return "continue"
			}
			if (chunk.type === "tool-call-delta") {
				const entry = toolCalls.get(chunk.index) ?? { id: chunk.id, name: "", arguments: "" }
				entry.id = chunk.id
				if (typeof chunk.name === "string" && chunk.name.length > 0) entry.name = chunk.name
				entry.arguments += chunk.argumentsDelta
				toolCalls.set(chunk.index, entry)
				return "tool_call"
			}
			if (chunk.type === "block-end" && chunk.block !== undefined && chunk.block.type === "tool-call") {
				toolCalls.set(chunk.index, {
					id: chunk.block.id,
					name: chunk.block.name,
					arguments: chunk.block.arguments,
				})
				return "tool_call"
			}
			if (chunk.type === "usage") {
				usage = chunk.usage
				return "continue"
			}
			if (chunk.type === "finish") {
				sawFinish = true
				const kind = chunk.reason !== null && typeof chunk.reason === "object" ? chunk.reason.kind : undefined
				if (kind === "stop") {
					finishKind = "stop"
					return "done"
				}
				if (kind === "tool-calls") {
					finishKind = "tool-calls"
					return "tool_call"
				}
				finishKind = kind === "max-tokens" || kind === "aborted" || kind === "error" ? kind : "unknown"
				if (kind === "aborted" || kind === "error") {
					terminalFailureCode = finishFailureCode(chunk.reason)
				}
				return "failed"
			}
			return "continue"
		},
		get text() {
			return [...textByIndex.values()].join("")
		},
		get usage() {
			return usage
		},
		get sawFinish() {
			return sawFinish
		},
		get finishKind() {
			return finishKind
		},
		get finishFailureCode() {
			return terminalFailureCode
		},
		get overLimit() {
			return overLimit
		},
		/** Compact `${type}:${count}` tally in first-seen order. */
		get chunkTypes() {
			return [...chunkTypes.entries()].map(([type, count]) => `${type}:${String(count)}`).join(",")
		},
		get toolCalls() {
			return [...toolCalls.values()].map((entry) => ({
				id: entry.id,
				name: entry.name,
				arguments: entry.arguments,
			}))
		},
	}
}

export { TOOL_REJECTION_NOTICE, buildReplayRequest, buildRetryRequest, createStreamReducer }
