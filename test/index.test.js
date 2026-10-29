import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { apply } from "../lib/index.js"
import { TOOL_REJECTION_NOTICE } from "../lib/replay.js"

const DEFAULT_CONFIG = {
	enabled: true,
	maxSuggestionChars: 200,
	latencyCapMs: 0,
	routePath: "/api/plugins/next-prompt-suggestion",
	logToFile: false,
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

const waitFor = async (predicate, timeoutMs = 1000) => {
	const deadline = Date.now() + timeoutMs
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error("condition was not met before timeout")
		await settle()
	}
}

const textBlock = (text) => ({ type: "text", text })

const message = (id, role, text) => ({
	id,
	role,
	content: [textBlock(text)],
	source: role === "assistant" ? { kind: "model", provider: "test-provider", model: "test-model" } : { kind: role },
})

const modelRequest = (sessionId, prompt = "original prompt") => ({
	provider: "test-provider",
	model: "test-model",
	reasoningEffort: "high",
	system: "captured system prompt",
	temperature: 0.2,
	maxTokens: 900,
	stop: ["STOP"],
	sessionId,
	tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
	toolHistory: [{ kind: "tool", name: "shell", loadedAt: 1 }],
	messages: [
		{
			id: "system-1",
			role: "system",
			content: [textBlock("system")],
			source: { kind: "system-prompt", form: "instructions" },
		},
		message("user-1", "user", prompt),
	],
	signal: new AbortController().signal,
})

const session = (id, header = {}) => ({ id, header: { version: 4, id, isSeeded: false, ...header } })

const turnStart = (turn) => ({ type: "turn/start", data: { turn } })
const humanMessage = (turn) => ({
	type: "user/message",
	data: { ...message(`user-${String(turn)}`, "user", "human prompt"), turn },
})
const assistantMessage = (turn, text = "finished") => ({
	type: "assistant/message",
	data: {
		turn,
		step: 1,
		message: message(`assistant-${String(turn)}`, "assistant", text),
		stream: [],
	},
})
const turnEnd = (turn) => ({ type: "turn/end", data: { turn, reason: { kind: "completed" } } })

const deepFreeze = (value) => {
	if (value !== null && typeof value === "object" && Object.isFrozen(value) === false) {
		Object.freeze(value)
		for (const child of Object.values(value)) deepFreeze(child)
	}
	return value
}

const fixedStream = (chunks) => () => chunks[Symbol.iterator]()

const createPendingStream = () => {
	let resolveStarted
	const started = new Promise((resolve) => {
		resolveStarted = resolve
	})
	let resolveAborted
	const aborted = new Promise((resolve) => {
		resolveAborted = resolve
	})
	const stream = (request) =>
		(async function* () {
			resolveStarted()
			await new Promise((resolve) => {
				if (request.signal.aborted) {
					resolveAborted(request.signal.reason)
					resolve()
					return
				}
				request.signal.addEventListener(
					"abort",
					() => {
						resolveAborted(request.signal.reason)
						resolve()
					},
					{ once: true },
				)
			})
			yield { type: "text-delta", index: 0, text: "late" }
			yield { type: "finish", reason: { kind: "stop" } }
		})()
	return { stream, started, aborted }
}

const createHarness = ({ config = {}, rejection, streams = [] } = {}) => {
	const listeners = new Map()
	const disposers = []
	const streamCalls = []
	const logEntries = []
	const streamQueue = [...streams]
	let route = null
	let rejectRequest = rejection

	const ctx = {
		logger: {
			info: (line) => logEntries.push({ level: "info", line }),
			warn: (line) => logEntries.push({ level: "warn", line }),
		},
		on(name, listener) {
			let handlers = listeners.get(name)
			if (handlers === undefined) {
				handlers = []
				listeners.set(name, handlers)
			}
			handlers.push(listener)
			const dispose = () => {
				const current = listeners.get(name)
				if (current === undefined) return
				const index = current.indexOf(listener)
				if (index >= 0) current.splice(index, 1)
			}
			disposers.push(dispose)
			return dispose
		},
		effect(effect) {
			const dispose = effect()
			disposers.push(dispose)
			return dispose
		},
		inject(dependencies, callback) {
			assert.deepEqual(dependencies, ["webServer", "connection"])
			callback(ctx)
		},
		llm: {
			stream(request) {
				streamCalls.push(request)
				const stream = streamQueue.shift()
				assert.equal(typeof stream, "function", `missing stream script for attempt ${String(streamCalls.length)}`)
				return runWaterfall("llm/stream", request, () => stream(request))
			},
		},
		webServer: {
			register(definition) {
				route = definition
				return () => {
					if (route === definition) route = null
				}
			},
		},
		connection: {
			requestRejection(request) {
				return rejectRequest?.(request)
			},
		},
	}

	apply(ctx, { ...DEFAULT_CONFIG, ...config })

	const runWaterfall = (eventName, value, next) => {
		const handlers = listeners.get(eventName) ?? []
		let downstream = next
		for (const listener of [...handlers].reverse()) {
			const following = downstream
			downstream = () => listener(value, following)
		}
		return downstream()
	}

	return {
		ctx,
		streamCalls,
		logEntries,
		get route() {
			return route
		},
		emit(name, ...args) {
			const handlers = listeners.get(name)
			assert.ok(handlers !== undefined && handlers.length > 0, `no listener for ${name}`)
			for (const listener of handlers) listener(...args)
		},
		runWaterfall,
		pushStreams(...values) {
			streamQueue.push(...values)
		},
		setRejection(value) {
			rejectRequest = value
		},
		dispose() {
			for (const dispose of disposers.reverse()) dispose?.()
		},
	}
}

const makeResponse = () => {
	const closeListeners = []
	return {
		statusCode: 200,
		writableEnded: false,
		headers: {},
		rawBody: "",
		setHeader(name, value) {
			this.headers[name.toLowerCase()] = value
		},
		on(name, listener) {
			if (name === "close") closeListeners.push(listener)
		},
		end(chunk = "") {
			if (this.writableEnded) return
			this.rawBody = typeof chunk === "string" ? chunk : String(chunk)
			this.writableEnded = true
			for (const listener of closeListeners) listener()
		},
		get payload() {
			return this.rawBody.length === 0 ? null : JSON.parse(this.rawBody)
		},
	}
}

const queryRoute = async (harness, sessionId, version) => {
	const res = makeResponse()
	const suffix = version === undefined ? "" : `&v=${String(version)}`
	await harness.route.handler(
		{
			method: "GET",
			url: `${DEFAULT_CONFIG.routePath}?session=${encodeURIComponent(sessionId)}${suffix}`,
			headers: {},
		},
		res,
	)
	return res
}

const capture = (harness, request) => {
	harness.emit("llm/stream", request, () => [])
}

const runCleanHumanTurn = (harness, targetSession, turn = 1) => {
	harness.emit("session/event", targetSession, turnStart(turn))
	harness.emit("session/event", targetSession, humanMessage(turn))
	harness.emit("session/event", targetSession, assistantMessage(turn))
	harness.emit("session/event", targetSession, turnEnd(turn))
}

test("production apply adopts only a stop finish and never salvages failed text", async (t) => {
	const cases = [
		{
			name: "stop",
			chunks: [
				{ type: "text-delta", index: 0, text: "safe next" },
				{ type: "finish", reason: { kind: "stop" } },
			],
			expected: "safe next",
			log: "emitted",
		},
		{
			name: "error",
			chunks: [
				{ type: "text-delta", index: 0, text: "partial" },
				{ type: "finish", reason: { kind: "error" } },
			],
			expected: null,
			log: "failed",
		},
		{
			name: "aborted",
			chunks: [
				{ type: "text-delta", index: 0, text: "partial" },
				{ type: "finish", reason: { kind: "aborted" } },
			],
			expected: null,
			log: "failed",
		},
		{
			name: "max-tokens",
			chunks: [
				{ type: "text-delta", index: 0, text: "partial" },
				{ type: "finish", reason: { kind: "max-tokens" } },
			],
			expected: null,
			log: "failed",
		},
		{
			name: "unknown",
			chunks: [
				{ type: "text-delta", index: 0, text: "partial" },
				{ type: "finish", reason: { kind: "future" } },
			],
			expected: null,
			log: "failed",
		},
		{
			name: "missing reason",
			chunks: [{ type: "text-delta", index: 0, text: "partial" }, { type: "finish" }],
			expected: null,
			log: "failed",
		},
		{
			name: "missing finish",
			chunks: [{ type: "text-delta", index: 0, text: "partial" }],
			expected: null,
			log: "incomplete",
		},
	]

	for (const item of cases) {
		await t.test(item.name, async () => {
			const harness = createHarness({ streams: [fixedStream(item.chunks)] })
			const targetSession = session(`finish-${item.name}`)
			capture(harness, modelRequest(targetSession.id))
			runCleanHumanTurn(harness, targetSession)
			await settle()
			const response = await queryRoute(harness, targetSession.id)
			assert.equal(response.statusCode, 200)
			assert.equal(response.payload.suggestion?.text ?? null, item.expected)
			assert.equal(harness.streamCalls.length, 1)
			assert.ok(
				harness.logEntries.some((entry) => entry.line.includes(`next-prompt-suggestion: ${item.log} `)),
				`missing ${item.log} outcome`,
			)
		})
	}
})

test("tool-call deltas and whole tool-call blocks each reject and retry exactly once", async (t) => {
	const triggers = [
		{
			name: "tool-call delta",
			chunks: [
				{ type: "text-delta", index: 0, text: "narration" },
				{ type: "tool-call-delta", index: 1, id: "call-1", name: "shell", argumentsDelta: "{}" },
			],
		},
		{
			name: "whole tool-call block",
			chunks: [
				{ type: "text-delta", index: 0, text: "narration" },
				{
					type: "block-end",
					index: 1,
					block: { type: "tool-call", id: "call-1", name: "shell", arguments: "{}" },
				},
			],
		},
		{
			name: "tool-calls finish",
			chunks: [
				{ type: "text-delta", index: 0, text: "narration" },
				{ type: "finish", reason: { kind: "tool-calls" } },
			],
		},
	]

	for (const trigger of triggers) {
		await t.test(`${trigger.name} stops after the second rejection`, async () => {
			const harness = createHarness({
				streams: [fixedStream(trigger.chunks), fixedStream(trigger.chunks)],
			})
			const targetSession = session(`tool-${trigger.name}`)
			capture(harness, modelRequest(targetSession.id))
			runCleanHumanTurn(harness, targetSession)
			await settle()
			const response = await queryRoute(harness, targetSession.id)
			assert.equal(response.payload.suggestion, null)
			assert.equal(harness.streamCalls.length, 2)
			assert.equal(harness.streamCalls[1].messages.at(-1).content[0].text.includes(TOOL_REJECTION_NOTICE), true)
			assert.equal(
				harness.streamCalls[1].messages.some((item) => item.role === "tool"),
				false,
			)
		})
	}

	await t.test("a clean retry emits its text", async () => {
		const harness = createHarness({
			streams: [
				fixedStream([{ type: "tool-call-delta", index: 0, id: "call-1", name: "shell", argumentsDelta: "{}" }]),
				fixedStream([
					{ type: "text-delta", index: 0, text: "retry succeeded" },
					{ type: "finish", reason: { kind: "stop" } },
				]),
			],
		})
		const targetSession = session("tool-retry-success")
		capture(harness, modelRequest(targetSession.id))
		runCleanHumanTurn(harness, targetSession)
		await settle()
		const response = await queryRoute(harness, targetSession.id)
		assert.equal(response.payload.suggestion.text, "retry succeeded")
		assert.equal(harness.streamCalls.length, 2)
	})
})

test("finish failures log their safe code without raw failure or suggestion text", async () => {
	const harness = createHarness({
		streams: [
			fixedStream([
				{ type: "text-delta", index: 0, text: "SECRET_SUGGESTION_BODY" },
				{
					type: "finish",
					reason: {
						kind: "error",
						failure: {
							code: "UPSTREAM_TIMEOUT",
							message: "SECRET_RAW_PROVIDER_BODY",
						},
					},
				},
			]),
		],
	})
	const targetSession = session("finish-failure-code")
	capture(harness, modelRequest(targetSession.id))
	runCleanHumanTurn(harness, targetSession)
	await settle()

	const response = await queryRoute(harness, targetSession.id)
	assert.equal(response.payload.suggestion, null)
	const failureLog = harness.logEntries.find((entry) => entry.line.includes("next-prompt-suggestion: failed "))
	assert.ok(failureLog !== undefined)
	assert.ok(failureLog.line.includes("finish=error code=UPSTREAM_TIMEOUT"))
	assert.equal(failureLog.line.includes("SECRET_SUGGESTION_BODY"), false)
	assert.equal(failureLog.line.includes("SECRET_RAW_PROVIDER_BODY"), false)
})

test("a runaway stream is aborted at the local cap without a retry", async () => {
	const chunk = "a".repeat(40)
	const harness = createHarness({
		config: { maxSuggestionChars: 50 },
		streams: [
			fixedStream([
				{ type: "text-delta", index: 0, text: chunk },
				{ type: "text-delta", index: 0, text: chunk },
				{ type: "text-delta", index: 0, text: chunk },
				{ type: "finish", reason: { kind: "stop" } },
			]),
		],
	})
	const targetSession = session("stream-cap")
	capture(harness, modelRequest(targetSession.id))
	runCleanHumanTurn(harness, targetSession)
	await settle()

	const response = await queryRoute(harness, targetSession.id)
	assert.equal(response.payload.suggestion, null)
	// The reducer rejects at the cap (40*3 = 120 > 2*50), so the retry never
	// starts and the trailing finish never turns the overrun into a result.
	assert.equal(harness.streamCalls.length, 1)
	const capLog = harness.logEntries.find((entry) => entry.line.includes("next-prompt-suggestion: over_limit "))
	assert.ok(capLog !== undefined)
	assert.ok(capLog.line.includes("chars=120 cap=100"))
})

test("a manual compaction replacement aborts the in-flight generation and clears state", async () => {
	const releaseStream = (() => {
		let release
		const gate = new Promise((resolve) => {
			release = resolve
		})
		return {
			stream: () =>
				(async function* () {
					await gate
					yield { type: "text-delta", index: 0, text: "stale next prompt" }
					yield { type: "finish", reason: { kind: "stop" } }
				})(),
			release,
		}
	})()
	const harness = createHarness({ streams: [releaseStream.stream] })
	const targetSession = session("compaction-replace")
	capture(harness, modelRequest(targetSession.id))
	runCleanHumanTurn(harness, targetSession)
	await waitFor(() => harness.streamCalls.length === 1)

	// DSH's manual `/compact` runs `runMaintenance()` between turns: the
	// replacement surface event never opens a turn.
	harness.emit("session/event", targetSession, {
		type: "user/message",
		surfaceOp: { op: "replace", startSeq: 1, endSeq: 3 },
		data: {
			id: "compaction-summary",
			role: "user",
			content: [textBlock("compacted summary")],
			source: { kind: "compaction", form: "summary" },
		},
	})
	releaseStream.release()
	await settle()

	const response = await queryRoute(harness, targetSession.id)
	assert.equal(response.statusCode, 200)
	assert.equal(response.payload.suggestion, null)
	assert.equal(harness.streamCalls.length, 1)
	const cancelLog = harness.logEntries.find((entry) =>
		entry.line.includes("next-prompt-suggestion: cancelled "),
	)
	assert.ok(cancelLog !== undefined)
	assert.ok(cancelLog.line.includes("reason=history_replaced"))
})

test("production capture preserves the full request and excludes its own replay and purpose side calls", async () => {
	const harness = createHarness({
		streams: [
			fixedStream([
				{ type: "text-delta", index: 0, text: "discard" },
				{
					type: "block-end",
					index: 1,
					block: { type: "tool-call", id: "call-1", name: "shell", arguments: "{}" },
				},
			]),
			fixedStream([
				{ type: "text-delta", index: 0, text: "parity held" },
				{ type: "finish", reason: { kind: "stop" } },
			]),
			fixedStream([
				{ type: "text-delta", index: 0, text: "second turn" },
				{ type: "finish", reason: { kind: "stop" } },
			]),
		],
	})
	const targetSession = session("parity")
	const options = deepFreeze(modelRequest(targetSession.id))
	const expected = {
		provider: options.provider,
		model: options.model,
		reasoningEffort: options.reasoningEffort,
		system: options.system,
		temperature: options.temperature,
		maxTokens: options.maxTokens,
		stop: structuredClone(options.stop),
		sessionId: options.sessionId,
		tools: structuredClone(options.tools),
		toolHistory: structuredClone(options.toolHistory),
		messages: structuredClone(options.messages),
	}
	capture(harness, options)
	capture(harness, { ...modelRequest(targetSession.id, "compaction side call"), purpose: "compaction" })
	const { sessionId: _sideSessionId, ...sessionlessSideCall } = modelRequest(targetSession.id, "review side call")
	void _sideSessionId
	capture(harness, sessionlessSideCall)
	runCleanHumanTurn(harness, targetSession)
	await settle()
	runCleanHumanTurn(harness, targetSession, 2)
	await settle()

	assert.equal(harness.streamCalls.length, 3)
	for (const [attempt, request] of harness.streamCalls.entries()) {
		assert.equal(request.provider, expected.provider)
		assert.equal(request.model, expected.model)
		assert.equal(request.reasoningEffort, expected.reasoningEffort)
		assert.equal(request.system, expected.system)
		assert.equal(request.temperature, expected.temperature)
		assert.equal(request.maxTokens, expected.maxTokens)
		assert.deepEqual(request.stop, expected.stop)
		assert.equal(request.sessionId, expected.sessionId)
		assert.deepEqual(request.tools, expected.tools)
		assert.deepEqual(request.toolHistory, expected.toolHistory)
		assert.deepEqual(request.messages.slice(0, expected.messages.length), expected.messages)
		assert.ok(request.signal instanceof AbortSignal)
		assert.notEqual(request.signal, options.signal)
		if (attempt === 1) {
			assert.equal(request.messages.at(-1).content[0].text.includes(TOOL_REJECTION_NOTICE), true)
		}
	}
	const response = await queryRoute(harness, targetSession.id)
	assert.equal(response.payload.suggestion.text, "second turn")
})

test("suggestion routing authenticates before lookup and unknown sessions cannot allocate or evict", async () => {
	const harness = createHarness()
	harness.setRejection(() => 401)
	const unauthorized = await queryRoute(harness, "unknown-before-auth")
	assert.equal(unauthorized.statusCode, 401)
	assert.equal(unauthorized.rawBody, "")

	harness.setRejection(undefined)
	const unknown = await queryRoute(harness, "unknown-before-auth")
	assert.equal(unknown.statusCode, 404)

	for (let index = 0; index < 256; index += 1) {
		capture(harness, modelRequest(`session-${String(index)}`))
	}
	const observational = await queryRoute(harness, "unknown-after-full-cache")
	assert.equal(observational.statusCode, 404)
	capture(harness, modelRequest("session-new"))

	assert.equal((await queryRoute(harness, "session-0")).statusCode, 404)
	assert.equal((await queryRoute(harness, "session-1")).statusCode, 200)
})

test("subagent lineage is excluded while a top-level fork remains interactive", async () => {
	const harness = createHarness({
		streams: [
			fixedStream([
				{ type: "text-delta", index: 0, text: "fork suggestion" },
				{ type: "finish", reason: { kind: "stop" } },
			]),
		],
	})
	const child = session("child", {
		parentSession: "parent",
		origin: "subagent",
		delegationDepth: 1,
	})
	harness.emit("session/created", child)
	capture(harness, modelRequest(child.id))
	runCleanHumanTurn(harness, child)
	await settle()
	assert.equal(harness.streamCalls.length, 0)
	assert.equal((await queryRoute(harness, child.id)).statusCode, 404)

	const fork = session("fork", { parentSession: "source", delegationDepth: 0 })
	capture(harness, modelRequest(fork.id))
	runCleanHumanTurn(harness, fork)
	await settle()
	assert.equal(harness.streamCalls.length, 1)
	assert.equal((await queryRoute(harness, fork.id)).payload.suggestion.text, "fork suggestion")
})

test("plugin disposal aborts attempts, flushes held responses, and prevents late emission or retry", async () => {
	const pending = createPendingStream()
	const harness = createHarness({
		config: { latencyCapMs: 60_000 },
		streams: [pending.stream],
	})
	const targetSession = session("dispose")
	capture(harness, modelRequest(targetSession.id))
	runCleanHumanTurn(harness, targetSession)
	await pending.started
	const held = await queryRoute(harness, targetSession.id, 0)
	assert.equal(held.writableEnded, false)
	const routeBeforeDispose = harness.route

	harness.dispose()
	await Promise.race([
		pending.aborted,
		new Promise((_, reject) => setTimeout(() => reject(new Error("stream was not aborted")), 1000)),
	])
	await settle()

	assert.equal(held.writableEnded, true)
	assert.equal(held.payload.suggestion, null)
	assert.equal(harness.streamCalls.length, 1)
	assert.equal(
		harness.logEntries.some((entry) => entry.line.includes("next-prompt-suggestion: emitted ")),
		false,
	)
	const staleResponse = makeResponse()
	await routeBeforeDispose.handler(
		{ method: "GET", url: `${DEFAULT_CONFIG.routePath}?session=dispose`, headers: {} },
		staleResponse,
	)
	assert.equal(staleResponse.statusCode, 404)
})

test("session disposal aborts its generation, clears state, and resolves its held query", async () => {
	const pending = createPendingStream()
	const harness = createHarness({ streams: [pending.stream] })
	const targetSession = session("session-dispose")
	capture(harness, modelRequest(targetSession.id))
	runCleanHumanTurn(harness, targetSession)
	await pending.started
	const held = await queryRoute(harness, targetSession.id, 0)
	assert.equal(held.writableEnded, false)

	harness.emit("session/disposed", targetSession)
	await pending.aborted
	await settle()

	assert.equal(held.writableEnded, true)
	assert.equal(held.payload.suggestion, null)
	assert.equal(harness.streamCalls.length, 1)
	assert.equal((await queryRoute(harness, targetSession.id)).statusCode, 404)
})

test("file logging obeys logToFile and never records suggestion or raw exception text", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "dsh-next-prompt-log-"))
	const previousHome = process.env.DSH_HOME
	process.env.DSH_HOME = scratch
	try {
		const disabled = createHarness({
			config: { maxSuggestionChars: 200 },
			streams: [
				fixedStream([
					{ type: "text-delta", index: 0, text: "not persisted" },
					{ type: "finish", reason: { kind: "stop" } },
				]),
			],
		})
		const disabledSession = session("logging-disabled")
		capture(disabled, modelRequest(disabledSession.id))
		runCleanHumanTurn(disabled, disabledSession)
		await settle()
		await settle()
		await assert.rejects(stat(join(scratch, "next-prompt-suggestion.log")), { code: "ENOENT" })

		const thrownFailure = Object.assign(new Error("SECRET_EXCEPTION_PAYLOAD"), { code: "INTERNAL_BOOM" })
		const enabled = createHarness({
			config: { logToFile: true },
			streams: [
				fixedStream([
					{ type: "text-delta", index: 0, text: "SECRET_SUGGESTION_TEXT" },
					{ type: "finish", reason: { kind: "stop" } },
				]),
				fixedStream([
					{ type: "text-delta", index: 0, text: "SECRET_FINISH_TEXT" },
					{
						type: "finish",
						reason: {
							kind: "error",
							failure: { code: "UPSTREAM_FAILED", message: "SECRET_FINISH_PAYLOAD" },
						},
					},
				]),
				() => ({
					[Symbol.iterator]() {
						throw thrownFailure
					},
				}),
			],
		})
		const emittedSession = session("logging-emitted")
		capture(enabled, modelRequest(emittedSession.id))
		runCleanHumanTurn(enabled, emittedSession)
		await settle()

		const finishFailedSession = session("logging-finish-failed")
		capture(enabled, modelRequest(finishFailedSession.id))
		runCleanHumanTurn(enabled, finishFailedSession)
		await settle()

		const thrownSession = session("logging-thrown")
		capture(enabled, modelRequest(thrownSession.id))
		runCleanHumanTurn(enabled, thrownSession)
		await settle()

		const logPath = join(scratch, "next-prompt-suggestion.log")
		await waitFor(async () => {
			const current = await readFile(logPath, "utf8").catch(() => "")
			return current.includes("code=UPSTREAM_FAILED") && current.includes("code=INTERNAL_BOOM")
		})
		const contents = await readFile(logPath, "utf8")
		assert.ok(contents.includes("next-prompt-suggestion: emitted "))
		assert.ok(contents.includes("next-prompt-suggestion: error "))
		assert.ok(contents.includes("code=UPSTREAM_FAILED"))
		assert.ok(contents.includes("code=INTERNAL_BOOM"))
		assert.equal(contents.includes("SECRET_SUGGESTION_TEXT"), false)
		assert.equal(contents.includes("SECRET_FINISH_TEXT"), false)
		assert.equal(contents.includes("SECRET_FINISH_PAYLOAD"), false)
		assert.equal(contents.includes("SECRET_EXCEPTION_PAYLOAD"), false)
	} finally {
		if (previousHome === undefined) delete process.env.DSH_HOME
		else process.env.DSH_HOME = previousHome
		await rm(scratch, { recursive: true, force: true })
	}
})
