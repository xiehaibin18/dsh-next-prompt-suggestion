/**
 * Replay request assembly and stream reduction.
 *
 * The replay reuses the captured request verbatim (same provider, model,
 * tools, and message prefix) so the upstream prompt cache can hit, then
 * appends the settled assistant message and one suggestion-mode instruction
 * user message - the same shape as the proven next-prompt suggestion
 * feature: `[...original messages, assistant, instruction]`.
 *
 * When the model answers that instruction with a tool call instead of text,
 * the attempt is rejected and retried exactly once with a synthetic
 * rejection turn (the attempted tool-call message plus one tool result per
 * call carrying the rejection notice). Tools are never executed: the retry
 * is a plain model call, and a second tool call gives up.
 * @module dsh-next-prompt-suggestion/replay
 */

/** Rejection notice appended to the instruction for the single retry round. */
const TOOL_REJECTION_NOTICE =
	"Your previous reply attempted to call a tool. Tool calls are not available in suggestion mode: reply with only the suggested next user input as plain text."

const instructionMessage = (instruction, pluginName, extraNotice) => ({
	id: globalThis.crypto.randomUUID(),
	role: "user",
	content: [{ type: "text", text: extraNotice === undefined ? instruction : `${instruction}\n\n${extraNotice}` }],
	source: { kind: "plugin", plugin: pluginName, form: "notice" },
})

/**
 * Assemble the replay request from a captured snapshot.
 *
 * @param input.snapshot - the captured ordinary conversation request.
 * @param input.assistant - the turn's final settled assistant message.
 * @param input.instruction - suggestion-mode instruction text.
 * @param input.pluginName - producing plugin identity for the message source.
 * @returns a GenerateOptions-shaped request for `ctx.llm.stream()`.
 */
const buildReplayRequest = ({ snapshot, assistant, instruction, pluginName }) => ({
	provider: snapshot.provider,
	model: snapshot.model,
	reasoningEffort: snapshot.reasoningEffort,
	temperature: snapshot.temperature,
	tools: snapshot.tools,
	messages: [...snapshot.messages, assistant, instructionMessage(instruction, pluginName)],
})

/**
 * Assemble the single retry request for a rejected attempt.
 *
 * The retry keeps the same route, tools, and message prefix (cache parity)
 * and reuses the exact shape of the first attempt - only the instruction
 * carries one extra rejection paragraph. A fabricated agentic turn (the
 * attempted tool-call message answered with an error tool result) was tried
 * first and abandoned: the provider answered that shape with an empty
 * completion (a lone terminal chunk, no usage, no text) on every run, while
 * this shape is the one the plain replay already proves it accepts.
 *
 * @param input.snapshot - the captured ordinary conversation request.
 * @param input.assistant - the turn's final settled assistant message.
 * @param input.instruction - suggestion-mode instruction text.
 * @param input.pluginName - producing plugin identity for the message source.
 * @returns a GenerateOptions-shaped request for `ctx.llm.stream()`.
 */
const buildRetryRequest = ({ snapshot, assistant, instruction, pluginName }) => ({
	provider: snapshot.provider,
	model: snapshot.model,
	reasoningEffort: snapshot.reasoningEffort,
	temperature: snapshot.temperature,
	tools: snapshot.tools,
	messages: [
		...snapshot.messages,
		assistant,
		instructionMessage(instruction, pluginName, TOOL_REJECTION_NOTICE),
	],
})

/**
 * Reduce a replay StreamChunk stream. Text deltas accumulate; the first
 * tool-call delta rejects the whole attempt (a suggestion must be plain
 * user-voice text) while the attempted calls accumulate for the retry;
 * usage is captured for logging.
 *
 * @returns `{ push(chunk) -> "continue" | "tool_call" | "done", text, usage, toolCalls }`.
 */
const createStreamReducer = () => {
	/** Per-index text: deltas accumulate, a delta-less block-end supplies the block text. */
	const textByIndex = new Map()
	let usage = undefined
	/** Chunk-type tally for the outcome log (diagnoses empty/failed upstream streams). */
	const chunkTypes = new Map()
	let sawFinish = false
	const toolCalls = new Map()
	return {
		push(chunk) {
			const type = typeof chunk.type === "string" ? chunk.type : "unknown"
			chunkTypes.set(type, (chunkTypes.get(type) ?? 0) + 1)
			if (chunk.type === "text-delta") {
				textByIndex.set(chunk.index, (textByIndex.get(chunk.index) ?? "") + chunk.text)
				return "continue"
			}
			if (chunk.type === "block-end" && chunk.block !== undefined && chunk.block.type === "text") {
				// A provider may deliver a block whole; deltas win when both
				// arrive so the text is never counted twice.
				const streamed = textByIndex.get(chunk.index)
				if (streamed === undefined || streamed.length === 0) {
					textByIndex.set(chunk.index, chunk.block.text)
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
				// Authoritative complete block; only reached when the caller
				// keeps consuming after a tool-call delta.
				toolCalls.set(chunk.index, {
					id: chunk.block.id,
					name: chunk.block.name,
					arguments: chunk.block.arguments,
				})
				return "continue"
			}
			if (chunk.type === "usage") {
				usage = chunk.usage
				return "continue"
			}
			if (chunk.type === "finish") {
				sawFinish = true
				return "done"
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
