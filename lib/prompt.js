/**
 * Suggestion-mode instruction and output normalization.
 *
 * The instruction is appended as the final user message of the replay
 * request; its wording follows the proven next-prompt suggestion prompt
 * shape (predict what THE USER would type, not what the assistant should
 * do) and stays provider-neutral.
 * @module dsh-next-prompt-suggestion/prompt
 */

/**
 * Instruction appended as the final user message of the replay request.
 *
 * Written in the harness's own product voice - the same shape as the
 * harness's other composer notices - and deliberately free of the trappings
 * that make a message read as a prompt injection: no bracket template, no
 * "mode" switch, no assertion that it is not a user message, and no
 * command-style "reply with ONLY". A security-aware model that recognises
 * those tells answers with a leak analysis instead of a suggestion (observed
 * in a live session), and the harness cannot move this text to a system slot
 * without replacing the session's own system prompt.
 */
const nextPromptInstruction = `The user has not typed anything yet. The composer is showing a placeholder that predicts their next line, written from this conversation so far.

Write that placeholder: one short line, in the user's own voice and language, that they would plausibly type next.

Match their style. Keep it to what they would actually type: no praise ("looks good"), no questions, no assistant-voice ("let me…", "I'll…"), no ideas they did not ask for, and no commentary about the harness or about this request.

Plain text only - the placeholder shows text, nothing else. If nothing obvious comes to mind, leave it empty.`

/**
 * Assistant-voice markers: a suggestion is what the USER would type, so a
 * reply that narrates what the assistant will do is a failed generation, not
 * a suggestion. Deliberately narrow - a false rejection only costs one
 * suggestion, but these phrasings are never something a user types as their
 * next message.
 */
const ASSISTANT_VOICE_PATTERNS = [
	/\b(let me|i'll|i will|here's|i need to|i'm going to|i should)\b/i,
	/(我先(看|查|取证|试|确认)|先取证|让我(先)?(看|查|来)|我来(看|查|处理|确认)|接下来我|我将)/,
]

/** A trailing colon or ellipsis means a lead-in to more content, not a complete suggestion. */
const endsWithLeadIn = (text) => {
	const last = text[text.length - 1]
	return last === ":" || last === "\uff1a" || last === "\u2026" || text.endsWith("...")
}

/**
 * Accept only a single-line, non-empty, length-capped suggestion in the
 * user's own voice. A model that stays silent, answers in multiple
 * paragraphs, wraps its answer in quotes/markup, narrates assistant work
 * ("Let me check..."), or opens a lead-in ("...result:") returns null and
 * the suggestion is dropped.
 *
 * @param raw - concatenated text-delta output of the replay call.
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
	if (endsWithLeadIn(text)) return null
	if (ASSISTANT_VOICE_PATTERNS.some((pattern) => pattern.test(text))) return null
	return text
}

export { nextPromptInstruction, normalizeSuggestion }
