import test from "node:test"
import assert from "node:assert/strict"

import { nextPromptInstruction, normalizeSuggestion } from "../lib/prompt.js"

test("instruction is a non-empty single-block text", () => {
	assert.equal(typeof nextPromptInstruction, "string")
	assert.ok(nextPromptInstruction.length > 100)
	assert.ok(nextPromptInstruction.includes("SUGGESTION MODE"))
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

test("normalizeSuggestion rejects the assistant-voice commentary regression", () => {
	// The exact text a live run accepted as a suggestion: the model answered
	// the instruction itself instead of predicting the user's next input.
	const leaked =
		"这条消息把插件的指令文本当成用户输入送进了真实会话——这是必须立刻查清的泄漏。先取证：指令消息是怎么进入会话的（看 `source` 字段）以及上一轮生成的结果："
	assert.equal(normalizeSuggestion(leaked, 80), null)
})

test("normalizeSuggestion rejects a trailing lead-in", () => {
	assert.equal(normalizeSuggestion("the next step is:", 80), null)
	assert.equal(normalizeSuggestion("接下来要做的事：", 80), null)
	assert.equal(normalizeSuggestion("then we…", 80), null)
})

test("normalizeSuggestion rejects assistant-voice phrasing", () => {
	assert.equal(normalizeSuggestion("Let me check the logs first", 80), null)
	assert.equal(normalizeSuggestion("I'll run the tests again", 80), null)
	assert.equal(normalizeSuggestion("我先看下日志", 80), null)
	assert.equal(normalizeSuggestion("先取证确认一下", 80), null)
})

test("normalizeSuggestion keeps ordinary user-voice suggestions", () => {
	assert.equal(normalizeSuggestion("再看下日志", 80), "再看下日志")
	assert.equal(normalizeSuggestion("continue with the tests", 80), "continue with the tests")
	assert.equal(normalizeSuggestion("把这个 bug 修了", 80), "把这个 bug 修了")
})
