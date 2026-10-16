/**
 * Suggestion-mode instruction and output normalization.
 *
 * Ported from the reference implementation: the instruction is appended as
 * the final user message of the replay request wrapped in a
 * `<next_prompt_suggestion>` tag, and normalization accepts only a
 * single-line, non-empty, length-capped suggestion. The wrapper and the
 * "starts with < or [" rejection are one design unit - a model that echoes
 * the wrapper is rejected.
 * @module dsh-next-prompt-suggestion/prompt
 */

/** Instruction body appended as the final user message of the replay request. */
const NEXT_PROMPT_SUGGESTION_PROMPT = `[SUGGESTION MODE: Suggest what the user might naturally type next into this harness.]

FIRST: Look at the user's recent messages and original request.

Your job is to predict what THEY would type - not what you think they should do.

Think about the next logical step. If you can infer a goal or a target new functionality, offer the next logical step towards that apparent goal or functionality.

THE TEST: Would they think "I was just about to type that"?

NEVER SUGGEST:
- Evaluative ("looks good", "thanks")
- Questions ("what about...?")
- Assistant-voice ("Let me...", "I'll...", "Here's...")
- New ideas they didn't ask about
- Multiple sentences

Stay silent if the next step isn't obvious from what the user said.

Format: keep it short - about 2-12 words in English, or roughly 4-24 characters in Chinese/CJK - and match the user's style including capitalization, verbosity and others.

Reply with ONLY the suggestion, no quotes or explanation.`

/** Tag-wrapped instruction message body. */
const nextPromptInstruction = `<next_prompt_suggestion>\n${NEXT_PROMPT_SUGGESTION_PROMPT}\n</next_prompt_suggestion>`

/**
 * Accept only a single-line, non-empty, length-capped suggestion. A model
 * that stays silent, answers in multiple paragraphs, wraps its answer in
 * quotes/markup, or echoes the instruction wrapper returns null and the
 * suggestion is dropped.
 *
 * @param raw - concatenated text output of the replay call.
 * @param maxChars - hard cap on the accepted suggestion length.
 * @returns the normalized suggestion text, or null when the model declined.
 */
const normalizeSuggestion = (raw, maxChars) => {
	let text = raw.trim()
	if (text.length >= 2) {
		const first = text[0]
		const last = text[text.length - 1]
		if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === "\u201c" && last === "\u201d")) {
			text = text.slice(1, -1).trim()
		}
	}
	if (text.length === 0) return null
	if (text.includes("\n")) return null
	if (text.length > maxChars) return null
	if (text.startsWith("<") || text.startsWith("[")) return null
	return text
}

export { nextPromptInstruction, normalizeSuggestion }
