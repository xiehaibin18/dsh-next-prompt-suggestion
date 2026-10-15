/**
 * Replay request assembly and stream reduction.
 *
 * The replay reuses the captured request verbatim (same provider, model,
 * tools, and message prefix) so the upstream prompt cache can hit, then
 * appends the settled assistant message and one suggestion-mode instruction
 * user message - the same shape as the proven next-prompt suggestion
 * feature: `[...original messages, assistant, instruction]`.
 * @module dsh-next-prompt-suggestion/replay
 */

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
	messages: [
		...snapshot.messages,
		assistant,
		{
			id: globalThis.crypto.randomUUID(),
			role: "user",
			content: [{ type: "text", text: instruction }],
			source: { kind: "plugin", plugin: pluginName, form: "notice" },
		},
	],
})

/**
 * Reduce a replay StreamChunk stream. Text deltas accumulate; the first
 * tool-call delta rejects the whole suggestion (a suggestion must be plain
 * user-voice text); usage is captured for logging.
 *
 * @returns `{ push(chunk) -> "continue" | "tool_call" | "done", text, usage }`.
 */
const createStreamReducer = () => {
	let text = ""
	let usage = undefined
	return {
		push(chunk) {
			if (chunk.type === "text-delta") {
				text += chunk.text
				return "continue"
			}
			if (chunk.type === "tool-call-delta") return "tool_call"
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
	}
}

export { buildReplayRequest, createStreamReducer }
