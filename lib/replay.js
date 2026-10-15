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

/** Tool-result notice returned for a rejected suggestion-mode tool call. */
const TOOL_REJECTION_NOTICE =
	"Tool calls are not available in suggestion mode. Reply with only the suggested next user input as plain text."

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

const isCompleteToolCall = (call) =>
	typeof call.id === "string" &&
	call.id.length > 0 &&
	typeof call.name === "string" &&
	call.name.length > 0

/**
 * Assemble the single retry request for a rejected attempt.
 *
 * The retry keeps the same route and tools (cache parity), appends the
 * rejected attempt as an assistant tool-call message, and answers every call
 * with one error tool result carrying the rejection notice - the standard
 * agentic "your call failed" shape a model knows how to recover from. When
 * the attempt's calls are not complete enough to serialize (a provider that
 * withheld the name), the rejection notice rides the instruction message
 * instead, which needs no fabricated call blocks.
 *
 * @param input.snapshot - the captured ordinary conversation request.
 * @param input.assistant - the turn's final settled assistant message.
 * @param input.instruction - suggestion-mode instruction text.
 * @param input.pluginName - producing plugin identity for the message source.
 * @param input.toolCalls - tool calls accumulated from the rejected attempt.
 * @returns a GenerateOptions-shaped request for `ctx.llm.stream()`.
 */
const buildRetryRequest = ({ snapshot, assistant, instruction, pluginName, toolCalls }) => {
	const base = {
		provider: snapshot.provider,
		model: snapshot.model,
		reasoningEffort: snapshot.reasoningEffort,
		temperature: snapshot.temperature,
		tools: snapshot.tools,
	}
	const complete = toolCalls.length > 0 && toolCalls.every(isCompleteToolCall)
	if (!complete) {
		return {
			...base,
			messages: [
				...snapshot.messages,
				assistant,
				instructionMessage(instruction, pluginName, TOOL_REJECTION_NOTICE),
			],
		}
	}
	return {
		...base,
		messages: [
			...snapshot.messages,
			assistant,
			instructionMessage(instruction, pluginName),
			{
				id: globalThis.crypto.randomUUID(),
				role: "assistant",
				content: toolCalls.map((call) => ({
					type: "tool-call",
					id: call.id,
					name: call.name,
					arguments: call.arguments,
				})),
				source: { kind: "model" },
			},
			...toolCalls.map((call) => ({
				id: globalThis.crypto.randomUUID(),
				role: "user",
				content: [
					{
						type: "tool-result",
						toolCallId: call.id,
						content: [{ type: "text", text: TOOL_REJECTION_NOTICE }],
						isError: true,
					},
				],
				source: { kind: "tool", callId: call.id },
			})),
		],
	}
}

/**
 * Reduce a replay StreamChunk stream. Text deltas accumulate; the first
 * tool-call delta rejects the whole attempt (a suggestion must be plain
 * user-voice text) while the attempted calls accumulate for the retry;
 * usage is captured for logging.
 *
 * @returns `{ push(chunk) -> "continue" | "tool_call" | "done", text, usage, toolCalls }`.
 */
const createStreamReducer = () => {
	let text = ""
	let usage = undefined
	const toolCalls = new Map()
	return {
		push(chunk) {
			if (chunk.type === "text-delta") {
				text += chunk.text
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
			if (chunk.type === "finish") return "done"
			return "continue"
		},
		get text() {
			return text
		},
		get usage() {
			return usage
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
