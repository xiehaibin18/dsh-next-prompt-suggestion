import test from "node:test"
import assert from "node:assert/strict"

import { nextPromptInstruction, normalizeSuggestion } from "../lib/prompt.js"

test("instruction is tag-wrapped with the reference template", () => {
	assert.ok(nextPromptInstruction.startsWith("<next_prompt_suggestion>\n"))
	assert.ok(nextPromptInstruction.endsWith("\n</next_prompt_suggestion>"))
	assert.ok(nextPromptInstruction.includes("[SUGGESTION MODE: "))
	assert.ok(nextPromptInstruction.includes("Reply with ONLY the suggestion, no quotes or explanation."))
	assert.equal(nextPromptInstruction.includes("Do not call any tools"), false)
})

test("normalizeSuggestion trims surrounding whitespace", () => {
	assert.equal(normalizeSuggestion("  continue with tests  ", 200), "continue with tests")
})

test("normalizeSuggestion strips matching surrounding quotes", () => {
	assert.equal(normalizeSuggestion('"continue with tests"', 200), "continue with tests")
	assert.equal(normalizeSuggestion("'continue with tests'", 200), "continue with tests")
	assert.equal(normalizeSuggestion("\u201c继续写测试\u201d", 200), "继续写测试")
})

test("normalizeSuggestion keeps unmatched quotes as content", () => {
	assert.equal(normalizeSuggestion("what's next?", 200), "what's next?")
})

test("normalizeSuggestion rejects empty and whitespace-only output", () => {
	assert.equal(normalizeSuggestion("", 200), null)
	assert.equal(normalizeSuggestion("   ", 200), null)
})

test("normalizeSuggestion rejects multi-paragraph output", () => {
	assert.equal(normalizeSuggestion("first line\nsecond line", 200), null)
})

test("normalizeSuggestion rejects over-cap output", () => {
	assert.equal(normalizeSuggestion("x".repeat(201), 200), null)
	assert.equal(normalizeSuggestion("x".repeat(200), 200), "x".repeat(200))
})

test("normalizeSuggestion rejects markup-looking output", () => {
	assert.equal(normalizeSuggestion("<suggestion>run tests</suggestion>", 200), null)
	assert.equal(normalizeSuggestion("[run tests]", 200), null)
})

