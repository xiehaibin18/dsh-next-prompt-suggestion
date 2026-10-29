/**
 * Next-prompt suggestion, host half.
 *
 * After a successful human turn ends, replay the session's last ordinary
 * model request verbatim with one appended suggestion-mode instruction and
 * predict what the user might type next. The normalized one-liner is kept
 * per session and served to the browser half over an exact webserver route.
 *
 * Gating mirrors the proven feature design: only completed human turns
 * (a direct user prompt, not plugin-injected context) whose final assistant
 * message carries no tool calls produce a suggestion; every new turn
 * invalidates the previous suggestion and aborts any in-flight replay.
 *
 * The browser half ships via exports["./client"], discovered through the
 * package.json `dsh.client` declaration.
 * @module dsh-next-prompt-suggestion
 */

import z from "@deepseek-ai/schemastery"
import { appendFile, rename, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { nextPromptInstruction, normalizeSuggestion } from "./prompt.js"
import { SuggestionTracker } from "./store.js"
import { buildReplayRequest, buildRetryRequest, createStreamReducer } from "./replay.js"

export const name = "next-prompt-suggestion"
export const inject = ["llm"]

export const Config = z.object({
	/** Master switch; `false` disables capture, generation, and the route. */
	enabled: z.boolean().default(true),
	/** Hard cap on the accepted suggestion length in characters. */
	maxSuggestionChars: z.number().step(1).min(10).default(200),
	/**
	 * Optional per-attempt latency cap in milliseconds; `0` (the default)
	 * disables it. Invalidation-driven abort is the real staleness guard -
	 * a new turn aborts the in-flight generation and clears the suggestion -
	 * and an unfinished generation has no user-visible consequence, so no
	 * fixed timeout is needed (the proven design has none either). A cap
	 * that is too tight silently kills every attempt on slow reasoning
	 * models; raise it only to bound a genuinely runaway provider.
	 */
	latencyCapMs: z.number().step(1).min(0).default(0),
	/** Exact webserver route serving the live suggestion to the browser half. */
	routePath: z.string().default("/api/plugins/next-prompt-suggestion"),
	/**
	 * Also append outcome lines to $DSH_HOME/next-prompt-suggestion.log:
	 * the desktop app's host logger writes to stdout only, which a GUI
	 * launch does not persist. Set this to `false` to suppress every
	 * plugin-written file diagnostic while retaining host logger output.
	 */
	logToFile: z.boolean().default(true),
})

const usageLogPath = () => {
	const home =
		typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.length > 0
			? process.env.DSH_HOME
			: join(homedir(), ".dsh")
	return join(home, "next-prompt-suggestion.log")
}

/** Best-effort bounded file sink: rotate to .old past 1 MiB, never throw. */
const appendUsageLog = async (line) => {
	try {
		const path = usageLogPath()
		const stats = await stat(path).catch(() => undefined)
		if (stats !== undefined && stats.size > 1_048_576) {
			await rename(path, `${path}.old`).catch(() => undefined)
		}
		await appendFile(path, `${new Date().toISOString()} ${line}\n`)
	} catch {
		// Best-effort observability; the ctx.logger line already went out.
	}
}

/** Extract the session identity from a `session/event` session argument. */
const sessionKey = (session) => {
	if (session !== null && typeof session === "object") {
		if (typeof session.id === "string") return session.id
		if (typeof session.sessionId === "string") return session.sessionId
	}
	return null
}

/** Hanging-GET cap: a held response resolves with the current state at latest this. */
const HANG_CAP_MS = 30000

/**
 * Local streaming hard cap, applied while the model is still talking. The
 * acceptance cap (`maxSuggestionChars`) stays the only acceptance rule; this
 * cap is a runaway guard with headroom for trim/whitespace and short
 * overshoot, so a model that ignores the suggestion format is aborted early
 * instead of consuming an unbounded reply.
 */
const STREAM_CHAR_HEADROOM_MULTIPLIER = 2

/** Sessions whose captured request snapshots are retained (reference parity). */
const MAX_TRACKED_SESSIONS = 256

const writeJson = (res, statusCode, payload) => {
	res.statusCode = statusCode
	res.setHeader("content-type", "application/json")
	res.end(JSON.stringify(payload))
}

const SAFE_CODE = /^[a-z0-9][a-z0-9_.:-]{0,79}$/iu

const safeCode = (value, fallback = "unknown") =>
	typeof value === "string" && SAFE_CODE.test(value) ? value : fallback

const errorCode = (error) => safeCode(error !== null && typeof error === "object" ? error.code : undefined)

/**
 * Subagent executions carry durable lineage in the session header. A fork may
 * share `parentSession` without subagent origin and is still an independent,
 * interactive conversation, so only host-declared child identity qualifies.
 */
const isSubagentSession = (session) => {
	const header = session !== null && typeof session === "object" ? session.header : undefined
	return (
		header !== null &&
		typeof header === "object" &&
		(header.origin === "subagent" || (typeof header.delegationDepth === "number" && header.delegationDepth > 0))
	)
}

export function apply(ctx, config) {
	if (config.enabled === false) return

	const maxSuggestionChars = config.maxSuggestionChars
	const latencyCapMs = config.latencyCapMs
	const routePath = config.routePath
	const logToFile = config.logToFile
	let disposed = false

	/** Per-session trackers keyed by session id. */
	const trackers = new Map()
	/** Per-session in-flight replay abort handles (one handle per generation). */
	const inflight = new Map()
	/** Per-session hanging-GET entries, held open until the state changes. */
	const waiters = new Map()
	/** Host-declared subagent sessions never qualify as interactive turns. */
	const nonInteractiveSessions = new Set()
	/** Exact request objects this plugin dispatches for suggestion replay. */
	let suggestionRequests = new WeakSet()

	const logLine = (level, line) => {
		ctx.logger?.[level]?.(line)
		if (logToFile) void appendUsageLog(line)
	}

	const respondWithState = (res, tracker) => {
		writeJson(res, 200, { suggestion: tracker.getSuggestion(), v: tracker.version })
	}

	const dropWaiter = (sessionId, waiter) => {
		const set = waiters.get(sessionId)
		if (set === undefined) return
		set.delete(waiter)
		if (set.size === 0) waiters.delete(sessionId)
	}

	const flushWaiters = (sessionId) => {
		const set = waiters.get(sessionId)
		if (set === undefined) return
		waiters.delete(sessionId)
		const tracker = trackers.get(sessionId)
		if (tracker === undefined) return
		for (const waiter of set) {
			clearTimeout(waiter.timer)
			if (!waiter.res.writableEnded) respondWithState(waiter.res, tracker)
		}
	}

	/**
	 * Hold one response open until the tracker's state version changes (or
	 * the cap elapses), then resolve it with the fresh state. The client
	 * keeps one such request open, so suggestion changes arrive the moment
	 * they happen instead of on a poll cadence.
	 */
	const holdUntilChange = (res, tracker, sessionId) => {
		let set = waiters.get(sessionId)
		if (set === undefined) {
			set = new Set()
			waiters.set(sessionId, set)
		}
		const waiter = { res, timer: null }
		waiter.timer = setTimeout(() => {
			dropWaiter(sessionId, waiter)
			if (!res.writableEnded) respondWithState(res, tracker)
		}, HANG_CAP_MS)
		set.add(waiter)
		res.on("close", () => {
			clearTimeout(waiter.timer)
			dropWaiter(sessionId, waiter)
		})
	}

	const trackerFor = (sessionId) => {
		if (disposed) return null
		let tracker = trackers.get(sessionId)
		if (tracker === undefined) {
			tracker = new SuggestionTracker()
			tracker.onChange = () => flushWaiters(sessionId)
			trackers.set(sessionId, tracker)
		} else {
			// Refresh recency so eviction takes the least recently used
			// session; each tracker holds a full request snapshot.
			trackers.delete(sessionId)
			trackers.set(sessionId, tracker)
		}
		evictStaleTrackers()
		return tracker
	}

	/**
	 * Bound the sessions holding captured request snapshots (reference
	 * parity: 256). A tracker retains a full message array, so an unbounded
	 * map grows with every session the process ever sees.
	 */
	const evictStaleTrackers = () => {
		while (trackers.size > MAX_TRACKED_SESSIONS) {
			const oldest = trackers.keys().next().value
			if (oldest === undefined) break
			dropSession(oldest)
		}
	}

	const abortInflight = (sessionId, reason = "turn_start") => {
		const handle = inflight.get(sessionId)
		if (handle !== undefined) {
			handle.abort(reason)
			inflight.delete(sessionId)
		}
	}

	/**
	 * Forget one session entirely: resolve anything held for it, abort its
	 * in-flight generation, and drop its tracker. Used by session disposal
	 * and by the snapshot bound's eviction; held responses are answered
	 * first so an evicted session never leaves a client waiting.
	 */
	const dropSession = (sessionId, reason = "session_disposed") => {
		const held = waiters.get(sessionId)
		if (held !== undefined) {
			waiters.delete(sessionId)
			for (const waiter of held) {
				clearTimeout(waiter.timer)
				if (!waiter.res.writableEnded) writeJson(waiter.res, 200, { suggestion: null, v: 0 })
			}
		}
		abortInflight(sessionId, reason)
		trackers.delete(sessionId)
	}

	const disposeAll = () => {
		if (disposed) return
		disposed = true
		const sessionIds = new Set([...trackers.keys(), ...waiters.keys(), ...inflight.keys()])
		for (const sessionId of sessionIds) dropSession(sessionId, "plugin_disposed")
		trackers.clear()
		waiters.clear()
		inflight.clear()
		nonInteractiveSessions.clear()
		suggestionRequests = new WeakSet()
	}

	ctx.effect(() => disposeAll, "next-prompt-suggestion: lifecycle")

	/**
	 * Replay the captured request and store the normalized suggestion. Only a
	 * tool-call termination receives the single bounded retry; all other
	 * failures give up without another provider call.
	 */
	const generate = async (sessionId, action) => {
		if (disposed) return
		abortInflight(sessionId, "superseded")
		/**
		 * Per-generation abort handle. Each attempt gets its own controller
		 * (a tool-call rejection ends one attempt without poisoning the
		 * retry); each attempt gets its own latency budget.
		 */
		const handle = {
			aborted: false,
			abortReason: null,
			controllers: new Set(),
			timer: null,
			abort(reason = "cancelled") {
				if (this.aborted) return
				this.aborted = true
				this.abortReason = reason
				if (this.timer !== null) {
					clearTimeout(this.timer)
					this.timer = null
				}
				for (const controller of this.controllers) controller.abort()
			},
		}
		inflight.set(sessionId, handle)
		const startedAt = Date.now()
		let capTimer = null
		/**
		 * Per-attempt latency budget: the first attempt and the one tool-call
		 * retry each get a fresh cap. Sharing one budget squeezed the retry
		 * out entirely on large sessions, where a single attempt alone can
		 * take 12-15s; turn-start invalidation stays the real staleness
		 * guard, so the cap only bounds a runaway generation.
		 */
		const armCap = () => {
			if (capTimer !== null) clearTimeout(capTimer)
			capTimer = null
			handle.timer = null
			if (latencyCapMs <= 0) return
			capTimer = setTimeout(() => handle.abort("latency_cap"), latencyCapMs)
			handle.timer = capTimer
		}
		/** One structured line per replay attempt: route, tokens, latency, outcome. */
		const logOutcome = (outcome, reducer, extra = "") => {
			const usage = reducer.usage
			const usagePart =
				usage === undefined
					? "tokens=-/-"
					: `tokens=${String(usage.inputTokens)}/${String(usage.outputTokens)}` +
						(usage.cacheReadTokens === undefined ? "" : ` cacheRead=${String(usage.cacheReadTokens)}`) +
						(usage.cacheWriteTokens === undefined ? "" : ` cacheWrite=${String(usage.cacheWriteTokens)}`)
			const line =
				`next-prompt-suggestion: ${outcome} session=${sessionId} turn=${String(action.turn)} ` +
				`provider=${String(action.snapshot.provider)} model=${String(action.snapshot.model)} ` +
				`${usagePart} latencyMs=${String(Date.now() - startedAt)} chunks=${reducer.chunkTypes}${extra}`
			logLine("info", line)
		}
		/** Run one attempt to its first terminal chunk; never throws past cancel. */
		const runAttempt = async (request) => {
			const controller = new AbortController()
			handle.controllers.add(controller)
			armCap()
			const reducer = createStreamReducer({ maxChars: maxSuggestionChars * STREAM_CHAR_HEADROOM_MULTIPLIER })
			try {
				const streamRequest = { ...request, signal: controller.signal }
				suggestionRequests.add(streamRequest)
				for await (const chunk of ctx.llm.stream(streamRequest)) {
					const outcome = reducer.push(chunk)
					if (outcome === "tool_call") {
						controller.abort()
						return { outcome: "tool_call", reducer }
					}
					if (outcome === "over_limit") {
						controller.abort()
						return { outcome: "over_limit", reducer }
					}
					if (outcome === "done") return { outcome: "completed", reducer }
					if (outcome === "failed") {
						controller.abort()
						return {
							outcome: "failed",
							reducer,
							finishKind: reducer.finishKind,
							failureCode: reducer.finishFailureCode,
						}
					}
					if (controller.signal.aborted) return { outcome: "cancelled", reducer }
				}
				// The iterator ended without a terminal `finish` chunk: the
				// upstream stream was empty or truncated. Never treat that as
				// a completed attempt - the main loop guards this exact case
				// ("stream ended before a terminal completion event").
				return { outcome: controller.signal.aborted ? "cancelled" : "incomplete", reducer }
			} finally {
				handle.controllers.delete(controller)
			}
		}
		try {
			const request = buildReplayRequest({
				snapshot: action.snapshot,
				assistant: action.assistant,
				instruction: nextPromptInstruction,
				pluginName: name,
			})
			let attempts = 1
			let result = await runAttempt(request)
			if (result.outcome === "tool_call" && handle.aborted === false && disposed === false) {
				// The terminal state decides. An attempt that ended in a tool
				// call chose to work instead of answering, so everything it
				// wrote on the way is narration, not a suggestion: discard it
				// and give exactly one more round with the rejection notice.
				// Tools are never executed.
				attempts = 2
				result = await runAttempt(
					buildRetryRequest({
						snapshot: action.snapshot,
						assistant: action.assistant,
						instruction: nextPromptInstruction,
						pluginName: name,
					}),
				)
			}
			const suffix = ` attempts=${String(attempts)}`
			if (handle.aborted || disposed) {
				if (!disposed) {
					logOutcome("cancelled", result.reducer, `${suffix} reason=${safeCode(handle.abortReason, "cancelled")}`)
				}
				return
			}
			if (result.outcome === "tool_call") {
				logOutcome("tool_call_rejected", result.reducer, suffix)
				return
			}
			if (result.outcome === "cancelled") {
				logOutcome("cancelled", result.reducer, suffix)
				return
			}
			if (result.outcome === "incomplete") {
				logOutcome("incomplete", result.reducer, suffix)
				return
			}
			if (result.outcome === "over_limit") {
				logOutcome(
					"over_limit",
					result.reducer,
					`${suffix} chars=${String(result.reducer.text.length)} cap=${String(maxSuggestionChars * STREAM_CHAR_HEADROOM_MULTIPLIER)}`,
				)
				return
			}
			if (result.outcome === "failed") {
				const failure = result.failureCode === null ? "" : ` code=${safeCode(result.failureCode, "unknown")}`
				logOutcome("failed", result.reducer, `${suffix} finish=${safeCode(result.finishKind, "unknown")}${failure}`)
				return
			}
			// Only an attempt that ended in a normal message is ever adopted.
			const text = normalizeSuggestion(result.reducer.text, maxSuggestionChars)
			if (text === null) {
				logOutcome("empty", result.reducer, `${suffix} chars=${String(result.reducer.text.length)}`)
				return
			}
			const tracker = trackerFor(sessionId)
			// A surface `replace` (manual `/compact` runs between turns without
			// opening one) can invalidate the generation's context while the
			// replay was in flight; the abort arrives via the tracker event,
			// and this check closes the race where the result was already
			// complete when the replacement landed.
			if (tracker === null || tracker.contextVersion !== action.contextVersion) {
				logOutcome("stale", result.reducer, suffix)
				return
			}
			tracker.setSuggestion({
				text,
				turn: action.turn,
				anchorMessageId: action.assistant.id,
				createdAt: Date.now(),
			})
			logOutcome("emitted", result.reducer, `${suffix} chars=${String(text.length)}`)
		} catch (error) {
			if (handle.aborted || disposed) return
			const line =
				`next-prompt-suggestion: error session=${sessionId} turn=${String(action.turn)} ` +
				`provider=${String(action.snapshot.provider)} model=${String(action.snapshot.model)} ` +
				`latencyMs=${String(Date.now() - startedAt)} code=${errorCode(error)}`
			logLine("warn", line)
		} finally {
			if (capTimer !== null) clearTimeout(capTimer)
			handle.timer = null
			if (inflight.get(sessionId) === handle) inflight.delete(sessionId)
		}
	}

	// Passive capture: ordinary conversation calls carry a session id and no
	// host auxiliary purpose. This plugin's own suggestion request keeps both
	// fields, so exact object ownership is recorded before dispatch rather than
	// adding an unsupported GenerateOptions field.
	ctx.on("llm/stream", (options, next) => {
		if (
			disposed === false &&
			typeof options.sessionId === "string" &&
			options.purpose === undefined &&
			suggestionRequests.has(options) === false &&
			nonInteractiveSessions.has(options.sessionId) === false
		) {
			const tracker = trackerFor(options.sessionId)
			if (tracker === null) return next()
			const first = tracker.snapshot === null
			tracker.captureRequest(options)
			if (first) {
				logLine(
					"info",
					`next-prompt-suggestion: outcome=ready event=capture session=${options.sessionId} provider=${String(options.provider)} model=${String(options.model)}`,
				)
			}
		}
		return next()
	})

	ctx.on("session/created", (session) => {
		const sessionId = sessionKey(session)
		if (sessionId !== null && isSubagentSession(session)) nonInteractiveSessions.add(sessionId)
	})

	// Session disposal: drop the tracker, its snapshot, its in-flight
	// generation, and any held response for that session.
	ctx.on("session/disposed", (session) => {
		const sessionId = sessionKey(session)
		if (sessionId === null) return
		nonInteractiveSessions.delete(sessionId)
		if (trackers.has(sessionId) === false && waiters.has(sessionId) === false && inflight.has(sessionId) === false) {
			return
		}
		dropSession(sessionId)
		logLine("info", `next-prompt-suggestion: outcome=disposed session=${sessionId}`)
	})

	ctx.on("session/event", (session, event) => {
		const sessionId = sessionKey(session)
		if (sessionId === null) {
			if (event.type === "turn/start") {
				logLine(
					"warn",
					`next-prompt-suggestion: outcome=gate reason=unresolvable_session keys=${Object.keys(session ?? {})
						.join("|")
						.slice(0, 120)}`,
				)
			}
			return
		}
		if (isSubagentSession(session)) {
			nonInteractiveSessions.add(sessionId)
			if (trackers.has(sessionId) || waiters.has(sessionId) || inflight.has(sessionId)) {
				dropSession(sessionId, "subagent")
			}
			return
		}
		const tracker = trackerFor(sessionId)
		if (tracker === null) return
		const action = tracker.onSessionEvent(event)
		if (event.type === "turn/end") {
			logLine(
				"info",
				`next-prompt-suggestion: outcome=gate session=${sessionId} turn=${String(event.data.turn)} endReason=${safeCode(event.data.reason?.kind)} action=${action.type} reason=${safeCode(action.reason, "-")}`,
			)
		}
		if (action.type === "cancel_inflight") abortInflight(sessionId, action.reason ?? "turn_start")
		else if (action.type === "generate") void generate(sessionId, action)
	})

	// Serve the live suggestion to the browser half. Registered as an exact
	// route (exact matches dispatch before the gateway's /api prefix route),
	// so the browser half can hold a plain same-origin GET for placeholder state.
	ctx.inject(["webServer", "connection"], (scope) => {
		scope.effect(
			() =>
				scope.webServer.register({
					kind: "exact",
					path: routePath,
					handler: async (req, res) => {
						try {
							const rejection = Reflect.get(scope, "connection").requestRejection(req)
							if (rejection !== undefined) {
								res.statusCode = rejection
								res.end()
								return
							}
							if (req.method !== "GET") {
								writeJson(res, 405, { error: "GET only" })
								return
							}
							const url = new URL(req.url ?? "/", "http://localhost")
							const sessionId = url.searchParams.get("session")
							if (sessionId === null || sessionId.length === 0) {
								writeJson(res, 400, { error: "session query parameter required" })
								return
							}
							const tracker = trackers.get(sessionId)
							if (tracker === undefined) {
								// A query is observational: it must not allocate a
								// tracker, evict a real session, or abort its work.
								writeJson(res, 404, { error: "unknown session" })
								return
							}
							// Hanging GET (long poll): with a known version that
							// still matches, hold the response open until the
							// suggestion state changes or the cap elapses, then
							// resolve with the fresh state; otherwise respond
							// immediately.
							const knownRaw = url.searchParams.get("v")
							const known = knownRaw === null ? null : Number(knownRaw)
							if (known !== null && Number.isFinite(known) && known === tracker.version) {
								holdUntilChange(res, tracker, sessionId)
								return
							}
							respondWithState(res, tracker)
						} catch {
							res.statusCode = 500
							res.end()
						}
					},
				}),
			"next-prompt-suggestion: suggestion route",
		)
	})
}
