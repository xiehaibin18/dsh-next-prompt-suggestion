import test from "node:test"
import assert from "node:assert/strict"

import { TOOL_REJECTION_NOTICE, buildReplayRequest, buildRetryRequest, createStreamReducer } from "../lib/replay.js"

const snapshot = {
	provider: "deepseek-official",
	model: "deepseek-v4-flash",
	reasoningEffort: undefined,
	temperature: 0.7,
	tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
	messages: [
		{ id: "m0", role: "system", content: [{ type: "text", text: "system" }], source: { kind: "plugin", plugin: "prompt", form: "instructions" } },
		{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } },
	],
}

const assistant = {
	id: "a-1-1",
	role: "assistant",
	content: [{ type: "text", text: "hello back" }],
	source: { kind: "model" },
}

test("buildReplayRequest reuses the snapshot route verbatim", () => {
	const request = buildReplayRequest({ snapshot, assistant, instruction: "INSTRUCTION", pluginName: "p" })
	assert.equal(request.provider, "deepseek-official")
	assert.equal(request.model, "deepseek-v4-flash")
	assert.equal(request.temperature, 0.7)
	assert.deepEqual(request.tools, snapshot.tools)
})

test("buildReplayRequest appends the assistant and the instruction message", () => {
	const request = buildReplayRequest({ snapshot, assistant, instruction: "INSTRUCTION", pluginName: "my-plugin" })
	assert.equal(request.messages.length, snapshot.messages.length + 2)
	assert.equal(request.messages[snapshot.messages.length], assistant)
	const instruction = request.messages[request.messages.length - 1]
	assert.equal(instruction.role, "user")
	assert.equal(instruction.source.kind, "plugin")
	assert.equal(instruction.source.plugin, "my-plugin")
	assert.equal(instruction.source.form, "notice")
	assert.deepEqual(instruction.content, [{ type: "text", text: "INSTRUCTION" }])
})

test("buildReplayRequest mints a fresh instruction message id per call", () => {
	const first = buildReplayRequest({ snapshot, assistant, instruction: "I", pluginName: "p" })
	const second = buildReplayRequest({ snapshot, assistant, instruction: "I", pluginName: "p" })
	const firstId = first.messages[first.messages.length - 1].id
	const secondId = second.messages[second.messages.length - 1].id
	assert.notEqual(firstId, secondId)
})

test("buildReplayRequest does not alias snapshot arrays", () => {
	const request = buildReplayRequest({ snapshot, assistant, instruction: "I", pluginName: "p" })
	request.messages.push({ id: "extra", role: "user", content: [], source: { kind: "user" } })
	assert.equal(snapshot.messages.length, 2)
})

test("stream reducer accumulates text deltas and ends on finish", () => {
	const reducer = createStreamReducer()
	assert.equal(reducer.push({ type: "block-start", index: 0, blockType: "text" }), "continue")
	assert.equal(reducer.push({ type: "text-delta", index: 0, text: "con" }), "continue")
	assert.equal(reducer.push({ type: "text-delta", index: 0, text: "tinue" }), "continue")
	assert.equal(reducer.push({ type: "block-end", index: 0, block: { type: "text", text: "continue" } }), "continue")
	assert.equal(reducer.text, "continue")
	assert.equal(reducer.push({ type: "finish" }), "done")
})

test("stream reducer captures usage", () => {
	const reducer = createStreamReducer()
	const usage = { inputTokens: 10, outputTokens: 5 }
	reducer.push({ type: "usage", usage })
	assert.equal(reducer.usage, usage)
})

test("stream reducer rejects the suggestion on the first tool-call delta", () => {
	const reducer = createStreamReducer()
	reducer.push({ type: "text-delta", index: 0, text: "partial" })
	assert.equal(reducer.push({ type: "tool-call-delta", index: 1, id: "call-1", argumentsDelta: "{" }), "tool_call")
})

test("stream reducer ignores reasoning deltas", () => {
	const reducer = createStreamReducer()
	assert.equal(reducer.push({ type: "reasoning-delta", index: 0, text: "thinking" }), "continue")
	assert.equal(reducer.text, "")
})

test("stream reducer accumulates tool calls from deltas", () => {
	const reducer = createStreamReducer()
	assert.equal(
		reducer.push({ type: "tool-call-delta", index: 0, id: "call-1", name: "shell", argumentsDelta: '{"cmd":' }),
		"tool_call",
	)
	reducer.push({ type: "tool-call-delta", index: 0, id: "call-1", argumentsDelta: '"ls"}' })
	assert.deepEqual(reducer.toolCalls, [{ id: "call-1", name: "shell", arguments: '{"cmd":"ls"}' }])
})

test("stream reducer takes the authoritative block from block-end", () => {
	const reducer = createStreamReducer()
	reducer.push({ type: "tool-call-delta", index: 0, id: "call-1", argumentsDelta: "{" })
	reducer.push({
		type: "block-end",
		index: 0,
		block: { type: "tool-call", id: "call-1", name: "grep", arguments: '{"pattern":"x"}' },
	})
	assert.deepEqual(reducer.toolCalls, [{ id: "call-1", name: "grep", arguments: '{"pattern":"x"}' }])
})

test("buildRetryRequest answers complete tool calls with the rejection notice", () => {
	const request = buildRetryRequest({
		snapshot,
		assistant,
		instruction: "INSTRUCTION",
		pluginName: "p",
		toolCalls: [{ id: "call-1", name: "shell", arguments: '{"cmd":"ls"}' }],
	})
	assert.equal(request.provider, snapshot.provider)
	assert.deepEqual(request.tools, snapshot.tools)
	// messages: snapshot + assistant + instruction + assistant(tool-call) + tool-result
	assert.equal(request.messages.length, snapshot.messages.length + 4)
	const attempted = request.messages[snapshot.messages.length + 2]
	assert.equal(attempted.role, "assistant")
	assert.equal(attempted.content[0].type, "tool-call")
	assert.equal(attempted.content[0].name, "shell")
	const rejection = request.messages[snapshot.messages.length + 3]
	assert.equal(rejection.role, "user")
	assert.equal(rejection.source.kind, "tool")
	assert.equal(rejection.source.callId, "call-1")
	assert.equal(rejection.content[0].type, "tool-result")
	assert.equal(rejection.content[0].toolCallId, "call-1")
	assert.equal(rejection.content[0].isError, true)
	assert.equal(rejection.content[0].content[0].text, TOOL_REJECTION_NOTICE)
})

test("buildRetryRequest falls back to the instruction notice without complete calls", () => {
	const request = buildRetryRequest({
		snapshot,
		assistant,
		instruction: "INSTRUCTION",
		pluginName: "p",
		toolCalls: [{ id: "call-1", name: "", arguments: "{" }],
	})
	assert.equal(request.messages.length, snapshot.messages.length + 2)
	const instruction = request.messages[request.messages.length - 1]
	assert.equal(instruction.role, "user")
	assert.ok(instruction.content[0].text.startsWith("INSTRUCTION"))
	assert.ok(instruction.content[0].text.includes(TOOL_REJECTION_NOTICE))
})
