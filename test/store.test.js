import test from "node:test"
import assert from "node:assert/strict"

import { SuggestionTracker } from "../lib/store.js"

const textBlock = (text) => ({ type: "text", text })
const toolCallBlock = (name) => ({ type: "tool-call", id: `call-${name}`, name, arguments: "{}" })

const request = (sessionId, overrides = {}) => ({
	provider: "deepseek-official",
	model: "deepseek-v4-flash",
	sessionId,
	messages: [
		{ id: "m0", role: "system", content: [textBlock("system prompt")], source: { kind: "system-prompt", form: "instructions" } },
		{ id: "m1", role: "user", content: [textBlock("fix the failing test")], source: { kind: "user" } },
	],
	tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
	...overrides,
})

const turnStart = (turn) => ({ type: "turn/start", data: { turn } })
const turnEnd = (turn, kind = "completed") => ({ type: "turn/end", data: { turn, reason: { kind } } })
const humanMessage = (turn = 1) => ({
	type: "user/message",
	data: { id: `u-${turn}`, role: "user", content: [textBlock("fix the failing test")], source: { kind: "user" } },
})
const injectedMessage = (turn = 1) => ({
	type: "user/message",
	data: {
		id: `inj-${turn}`,
		role: "user",
		content: [textBlock("memory head")],
		source: { kind: "herbin-memory", form: "snapshot" },
	},
})
const assistantMessage = (turn, step, blocks) => ({
	type: "assistant/message",
	data: {
		turn,
		step,
		message: { id: `a-${turn}-${step}`, role: "assistant", content: blocks, source: { kind: "model" } },
		stream: [],
	},
})

test("captureRequest keeps ordinary conversation requests", () => {
	const tracker = new SuggestionTracker()
	tracker.captureRequest(request("s1"))
	assert.ok(tracker.snapshot !== null)
	assert.equal(tracker.snapshot.provider, "deepseek-official")
	assert.equal(tracker.snapshot.messages.length, 2)
})

test("captureRequest skips session-less calls and preserves the complete request", () => {
	const tracker = new SuggestionTracker()
	const { sessionId, ...withoutSession } = request("s1")
	void sessionId
	tracker.captureRequest(withoutSession)
	assert.equal(tracker.snapshot, null)
	tracker.captureRequest(
		request("s1", {
			toolHistory: [{ kind: "tool", name: "shell", loadedAt: 1 }],
			maxTokens: 321,
			stop: ["END"],
		}),
	)
	assert.equal(tracker.snapshot.sessionId, "s1")
	assert.deepEqual(tracker.snapshot.toolHistory, [{ kind: "tool", name: "shell", loadedAt: 1 }])
	assert.equal(tracker.snapshot.maxTokens, 321)
	assert.deepEqual(tracker.snapshot.stop, ["END"])
})

test("captureRequest copies nested messages, tools, and request fields defensively", () => {
	const options = request("s1", {
		toolHistory: [{ kind: "tool", name: "shell", loadedAt: 1 }],
		stop: ["END"],
		signal: new AbortController().signal,
	})
	const tracker = new SuggestionTracker()
	tracker.captureRequest(options)
	options.messages.push({ id: "m2", role: "user", content: [textBlock("later")], source: { kind: "user" } })
	options.tools.push({ type: "function", name: "extra", parameters: { type: "object" } })
	options.toolHistory[0].loadedAt = 2
	options.stop.push("OTHER")
	assert.equal(tracker.snapshot.messages.length, 2)
	assert.equal(tracker.snapshot.tools.length, 1)
	assert.equal(tracker.snapshot.toolHistory[0].loadedAt, 1)
	assert.deepEqual(tracker.snapshot.stop, ["END"])
	assert.equal(Object.hasOwn(tracker.snapshot, "signal"), false)
})

test("turn/start cancels in-flight work and drops the previous suggestion", () => {
	const tracker = new SuggestionTracker()
	tracker.setSuggestion({ text: "old", turn: 1, anchorMessageId: "a-1-1", createdAt: 1 })
	assert.deepEqual(tracker.onSessionEvent(turnStart(2)), { type: "cancel_inflight" })
	assert.equal(tracker.getSuggestion(), null)
})

test("a completed human turn with a clean final assistant generates", () => {
	const tracker = new SuggestionTracker()
	tracker.captureRequest(request("s1"))
	tracker.onSessionEvent(turnStart(1))
	tracker.onSessionEvent(humanMessage(1))
	tracker.onSessionEvent(assistantMessage(1, 1, [toolCallBlock("shell")]))
	tracker.onSessionEvent(assistantMessage(1, 2, [textBlock("tests pass now")]))
	const action = tracker.onSessionEvent(turnEnd(1))
	assert.equal(action.type, "generate")
	assert.equal(action.turn, 1)
	assert.equal(action.assistant.id, "a-1-2")
	assert.equal(action.snapshot.model, "deepseek-v4-flash")
})

test("a final assistant with tool calls does not generate", () => {
	const tracker = new SuggestionTracker()
	tracker.captureRequest(request("s1"))
	tracker.onSessionEvent(turnStart(1))
	tracker.onSessionEvent(humanMessage(1))
	tracker.onSessionEvent(assistantMessage(1, 1, [toolCallBlock("shell")]))
	assert.equal(tracker.onSessionEvent(turnEnd(1)).type, "none")
})

test("an aborted turn does not generate", () => {
	const tracker = new SuggestionTracker()
	tracker.captureRequest(request("s1"))
	tracker.onSessionEvent(turnStart(1))
	tracker.onSessionEvent(humanMessage(1))
	tracker.onSessionEvent(assistantMessage(1, 1, [textBlock("partial")]))
	assert.equal(tracker.onSessionEvent(turnEnd(1, "aborted")).type, "none")
})

test("plugin-injected context alone does not make a turn human", () => {
	const tracker = new SuggestionTracker()
	tracker.captureRequest(request("s1"))
	tracker.onSessionEvent(turnStart(1))
	tracker.onSessionEvent(injectedMessage(1))
	tracker.onSessionEvent(assistantMessage(1, 1, [textBlock("noted")]))
	assert.equal(tracker.onSessionEvent(turnEnd(1)).type, "none")
})

test("injected context beside a human prompt still counts as human", () => {
	const tracker = new SuggestionTracker()
	tracker.captureRequest(request("s1"))
	tracker.onSessionEvent(turnStart(1))
	tracker.onSessionEvent(injectedMessage(1))
	tracker.onSessionEvent(humanMessage(1))
	tracker.onSessionEvent(assistantMessage(1, 1, [textBlock("done")]))
	assert.equal(tracker.onSessionEvent(turnEnd(1)).type, "generate")
})

test("no captured snapshot means no generation", () => {
	const tracker = new SuggestionTracker()
	tracker.onSessionEvent(turnStart(1))
	tracker.onSessionEvent(humanMessage(1))
	tracker.onSessionEvent(assistantMessage(1, 1, [textBlock("done")]))
	assert.equal(tracker.onSessionEvent(turnEnd(1)).type, "none")
})

test("assistant settlements from another turn are ignored", () => {
	const tracker = new SuggestionTracker()
	tracker.captureRequest(request("s1"))
	tracker.onSessionEvent(turnStart(1))
	tracker.onSessionEvent(humanMessage(1))
	tracker.onSessionEvent(assistantMessage(2, 1, [textBlock("other turn")]))
	tracker.onSessionEvent(assistantMessage(1, 1, [textBlock("this turn")]))
	const action = tracker.onSessionEvent(turnEnd(1))
	assert.equal(action.type, "generate")
	assert.equal(action.assistant.id, "a-1-1")
})

test("turn/start bumps the version and notifies only when a suggestion was live", () => {
	const tracker = new SuggestionTracker()
	const versions = []
	tracker.onChange = (version) => versions.push(version)
	tracker.onSessionEvent(turnStart(1))
	assert.equal(tracker.version, 0)
	assert.deepEqual(versions, [])
	tracker.setSuggestion({ text: "hi", turn: 1, anchorMessageId: "a-1-1", createdAt: 1 })
	assert.equal(tracker.version, 1)
	assert.deepEqual(versions, [1])
	tracker.onSessionEvent(turnStart(2))
	assert.equal(tracker.version, 2)
	assert.deepEqual(versions, [1, 2])
})

test("a surface replace event invalidates the suggestion and cancels in-flight work", () => {
	const tracker = new SuggestionTracker()
	tracker.captureRequest(request("s1"))
	tracker.onSessionEvent(turnStart(1))
	tracker.onSessionEvent(humanMessage(1))
	tracker.onSessionEvent(assistantMessage(1, 1, [textBlock("done")]))
	const generate = tracker.onSessionEvent(turnEnd(1))
	assert.equal(generate.type, "generate")
	assert.equal(generate.contextVersion, 0)
	tracker.setSuggestion({ text: "old", turn: 1, anchorMessageId: "a-1-1", createdAt: 1 })

	// Manual `/compact` runs between turns: a surface `replace` event over
	// the compacted range, without opening a turn.
	const compaction = {
		type: "user/message",
		surfaceOp: { op: "replace", startSeq: 1, endSeq: 3 },
		data: { id: "compact-1", role: "user", content: [textBlock("summary")], source: { kind: "compaction", form: "summary" } },
	}
	const action = tracker.onSessionEvent(compaction)
	assert.deepEqual(action, { type: "cancel_inflight", reason: "history_replaced" })
	assert.equal(tracker.getSuggestion(), null)
	assert.equal(tracker.contextVersion, 1)
})

test("append surface events and log-only events never bump the context version", () => {
	const tracker = new SuggestionTracker()
	tracker.captureRequest(request("s1"))
	tracker.onSessionEvent(turnStart(1))
	assert.equal(tracker.contextVersion, 0)
	assert.equal(tracker.onSessionEvent(humanMessage(1)).type, "none")
	assert.equal(tracker.contextVersion, 0)
	const append = { ...humanMessage(1), surfaceOp: "append" }
	assert.equal(tracker.onSessionEvent(append).type, "none")
	assert.equal(tracker.contextVersion, 0)
})

test("a generate action records the context version it started against", () => {
	const tracker = new SuggestionTracker()
	tracker.captureRequest(request("s1"))
	tracker.onSessionEvent(turnStart(1))
	tracker.onSessionEvent(humanMessage(1))
	tracker.onSessionEvent(assistantMessage(1, 1, [textBlock("done")]))
	assert.equal(tracker.onSessionEvent(turnEnd(1)).contextVersion, 0)

	// A replaced history must no longer satisfy a stale generation.
	tracker.onSessionEvent({
		type: "assistant/message",
		surfaceOp: { op: "replace", startSeq: 2, endSeq: 4 },
		data: assistantMessage(1, 1, [textBlock("done")]).data,
	})
	tracker.onSessionEvent(turnStart(2))
	tracker.onSessionEvent(humanMessage(2))
	tracker.onSessionEvent(assistantMessage(2, 1, [textBlock("done again")]))
	const action = tracker.onSessionEvent(turnEnd(2))
	assert.equal(action.type, "generate")
	assert.equal(action.contextVersion, 1)
})

test("setSuggestion notifies on change and stays quiet on identical text", () => {
	const tracker = new SuggestionTracker()
	const versions = []
	tracker.onChange = (version) => versions.push(version)
	tracker.setSuggestion({ text: "run tests", turn: 1, anchorMessageId: "a-1-1", createdAt: 1 })
	assert.deepEqual(versions, [1])
	// Same text (e.g. re-set): no visible change, no notification.
	tracker.setSuggestion({ text: "run tests", turn: 1, anchorMessageId: "a-1-1", createdAt: 2 })
	assert.deepEqual(versions, [1])
	tracker.setSuggestion({ text: "ship it", turn: 1, anchorMessageId: "a-1-1", createdAt: 3 })
	assert.deepEqual(versions, [1, 2])
})
