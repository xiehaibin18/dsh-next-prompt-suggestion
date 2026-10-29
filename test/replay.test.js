import test from "node:test"
import assert from "node:assert/strict"

import { TOOL_REJECTION_NOTICE, buildReplayRequest, buildRetryRequest, createStreamReducer } from "../lib/replay.js"

const snapshot = {
	provider: "deepseek-official",
	model: "deepseek-v4-flash",
	reasoningEffort: "high",
	temperature: 0.7,
	system: "captured system prompt",
	tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
	toolHistory: [{ kind: "tool", name: "shell", loadedAt: 1 }],
	sessionId: "session-1",
	maxTokens: 1234,
	stop: ["END"],
	messages: [
		{
			id: "m0",
			role: "system",
			content: [{ type: "text", text: "system" }],
			source: { kind: "system-prompt", form: "instructions" },
		},
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
	assert.equal(request.reasoningEffort, "high")
	assert.equal(request.temperature, 0.7)
	assert.equal(request.system, "captured system prompt")
	assert.deepEqual(request.tools, snapshot.tools)
	assert.deepEqual(request.toolHistory, snapshot.toolHistory)
	assert.equal(request.sessionId, "session-1")
	assert.equal(request.maxTokens, 1234)
	assert.deepEqual(request.stop, ["END"])
})

test("buildReplayRequest appends the assistant and the instruction message", () => {
	const request = buildReplayRequest({ snapshot, assistant, instruction: "INSTRUCTION", pluginName: "my-plugin" })
	assert.equal(request.messages.length, snapshot.messages.length + 2)
	assert.deepEqual(request.messages[snapshot.messages.length], assistant)
	const instruction = request.messages[request.messages.length - 1]
	assert.equal(instruction.role, "user")
	// Producer-owned kind: the retired V3 `{kind: "plugin", plugin}` spelling is
	// refused by V4 durable admission, so the plugin name itself is the kind.
	assert.equal(instruction.source.kind, "my-plugin")
	assert.equal(instruction.source.plugin, undefined)
	assert.equal(instruction.source.form, "notice")
	assert.deepEqual(instruction.content, [{ type: "text", text: "INSTRUCTION" }])
})

test("buildReplayRequest never emits a retired plugin source kind", () => {
	for (const pluginName of ["my-plugin", "dsh-next-prompt-suggestion"]) {
		for (const request of [
			buildReplayRequest({ snapshot, assistant, instruction: "I", pluginName }),
			buildRetryRequest({ snapshot, assistant, instruction: "I", pluginName }),
		]) {
			const source = request.messages[request.messages.length - 1].source
			assert.notEqual(source.kind, "plugin")
			assert.notEqual(source.kind, "")
			assert.equal(typeof source.kind, "string")
		}
	}
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
	assert.equal(reducer.push({ type: "finish", reason: { kind: "stop" } }), "done")
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
	assert.equal(
		reducer.push({
			type: "block-end",
			index: 0,
			block: { type: "tool-call", id: "call-1", name: "grep", arguments: '{"pattern":"x"}' },
		}),
		"tool_call",
	)
	assert.deepEqual(reducer.toolCalls, [{ id: "call-1", name: "grep", arguments: '{"pattern":"x"}' }])
})

test("a whole tool-call block rejects without a preceding delta", () => {
	const reducer = createStreamReducer()
	assert.equal(
		reducer.push({
			type: "block-end",
			index: 0,
			block: { type: "tool-call", id: "call-1", name: "shell", arguments: "{}" },
		}),
		"tool_call",
	)
	assert.deepEqual(reducer.toolCalls, [{ id: "call-1", name: "shell", arguments: "{}" }])
})

test("buildRetryRequest reuses the replay shape with a rejection notice", () => {
	const request = buildRetryRequest({
		snapshot,
		assistant,
		instruction: "INSTRUCTION",
		pluginName: "p",
	})
	assert.equal(request.provider, snapshot.provider)
	assert.deepEqual(request.tools, snapshot.tools)
	assert.deepEqual(request.toolHistory, snapshot.toolHistory)
	assert.equal(request.sessionId, snapshot.sessionId)
	assert.equal(request.maxTokens, snapshot.maxTokens)
	assert.deepEqual(request.stop, snapshot.stop)
	// Same shape as the plain replay: no fabricated assistant turn.
	assert.equal(request.messages.length, snapshot.messages.length + 2)
	const instruction = request.messages[request.messages.length - 1]
	assert.equal(instruction.role, "user")
	assert.ok(instruction.content[0].text.startsWith("INSTRUCTION"))
	assert.ok(instruction.content[0].text.includes(TOOL_REJECTION_NOTICE))
})

test("stream reducer falls back to block-end text when no deltas arrived", () => {
	const reducer = createStreamReducer()
	assert.equal(reducer.push({ type: "block-end", index: 0, block: { type: "text", text: "whole block" } }), "continue")
	assert.equal(reducer.text, "whole block")
})

test("stream reducer never double counts deltas and block-end text", () => {
	const reducer = createStreamReducer()
	reducer.push({ type: "text-delta", index: 0, text: "streamed" })
	reducer.push({ type: "block-end", index: 0, block: { type: "text", text: "streamed" } })
	assert.equal(reducer.text, "streamed")
})

test("stream reducer reports sawFinish and the chunk tally", () => {
	const reducer = createStreamReducer()
	assert.equal(reducer.sawFinish, false)
	reducer.push({ type: "block-start", index: 0, blockType: "text" })
	reducer.push({ type: "text-delta", index: 0, text: "x" })
	reducer.push({ type: "finish", reason: { kind: "stop" } })
	assert.equal(reducer.sawFinish, true)
	assert.equal(reducer.chunkTypes, "block-start:1,text-delta:1,finish:1")
})

test("stream reducer enforces a local hard cap on streamed text deltas", () => {
	const reducer = createStreamReducer({ maxChars: 10 })
	assert.equal(reducer.push({ type: "text-delta", index: 0, text: "12345" }), "continue")
	// Reaching the cap is fine; the first char past it trips the guard.
	assert.equal(reducer.push({ type: "text-delta", index: 0, text: "123456" }), "over_limit")
	assert.equal(reducer.overLimit, true)
	// Terminal: further pushes keep reporting the overrun; the caller aborts.
	assert.equal(reducer.push({ type: "text-delta", index: 0, text: "more" }), "over_limit")
	assert.equal(reducer.text, "12345123456more")
})

test("stream reducer applies the cap to a whole text block too", () => {
	const reducer = createStreamReducer({ maxChars: 5 })
	const outcome = reducer.push({ type: "block-end", index: 0, block: { type: "text", text: "123456" } })
	assert.equal(outcome, "over_limit")
	assert.equal(reducer.overLimit, true)
})

test("stream reducer without a cap never reports over_limit", () => {
	const reducer = createStreamReducer()
	assert.equal(reducer.push({ type: "text-delta", index: 0, text: "x".repeat(262_144) }), "continue")
	assert.equal(reducer.overLimit, false)
})

test("only stop is an adoptable finish", () => {
	for (const kind of ["stop", "tool-calls", "max-tokens", "aborted", "error", "future-reason"]) {
		const reducer = createStreamReducer()
		const outcome = reducer.push({ type: "finish", reason: { kind } })
		assert.equal(outcome, kind === "stop" ? "done" : kind === "tool-calls" ? "tool_call" : "failed")
		assert.equal(reducer.finishKind, kind === "future-reason" ? "unknown" : kind)
		if (kind === "aborted" || kind === "error") {
			assert.equal(reducer.finishFailureCode, "unknown")
		} else {
			assert.equal(reducer.finishFailureCode, null)
		}
	}
	const missingReason = createStreamReducer()
	assert.equal(missingReason.push({ type: "finish" }), "failed")
	assert.equal(missingReason.finishKind, "unknown")
})

test("finish failures retain only a bounded structured code", () => {
	const safe = createStreamReducer()
	assert.equal(
		safe.push({
			type: "finish",
			reason: {
				kind: "error",
				failure: { code: "UPSTREAM_TIMEOUT", message: "raw provider payload" },
			},
		}),
		"failed",
	)
	assert.equal(safe.finishFailureCode, "UPSTREAM_TIMEOUT")

	const unsafe = createStreamReducer()
	unsafe.push({
		type: "finish",
		reason: {
			kind: "error",
			failure: { code: `unsafe ${"x".repeat(100)}`, message: "raw provider payload" },
		},
	})
	assert.equal(unsafe.finishFailureCode, "unknown")
})

test("replay requests detach every captured field and the assistant", () => {
	const request = buildReplayRequest({ snapshot, assistant, instruction: "I", pluginName: "p" })
	request.toolHistory[0].loadedAt = 2
	request.stop.push("OTHER")
	request.messages[0].content[0].text = "changed"
	request.messages[snapshot.messages.length].content[0].text = "changed assistant"
	assert.equal(snapshot.toolHistory[0].loadedAt, 1)
	assert.deepEqual(snapshot.stop, ["END"])
	assert.equal(snapshot.messages[0].content[0].text, "system")
	assert.equal(assistant.content[0].text, "hello back")
})
