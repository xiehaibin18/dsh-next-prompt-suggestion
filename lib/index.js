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
import { buildReplayRequest, createStreamReducer } from "./replay.js"

export const name = "next-prompt-suggestion"
export const inject = ["llm"]

export const Config = z.object({
	/** Master switch; `false` disables capture, generation, and the route. */
	enabled: z.boolean().default(true),
	/** Hard cap on the accepted suggestion length in characters. */
	maxSuggestionChars: z.number().step(1).min(10).default(200),
	/** Replay latency cap; the aborted replay is discarded, never retried. */
	latencyCapMs: z.number().step(1).min(1000).default(15000),
	/** Exact webserver route serving the live suggestion to the browser half. */
	routePath: z.string().default("/api/plugins/next-prompt-suggestion"),
	/**
	 * Also append outcome lines to $DSH_HOME/next-prompt-suggestion.log:
	 * the desktop app's host logger writes to stdout only, which a GUI
	 * launch does not persist.
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

const writeJson = (res, statusCode, payload) => {
	res.statusCode = statusCode
	res.setHeader("content-type", "application/json")
	res.end(JSON.stringify(payload))
}

export function apply(ctx, config) {
	if (config.enabled === false) return

	/** Per-session trackers keyed by session id. */
	const trackers = new Map()
	/** Per-session in-flight replay abort controllers. */
	const inflight = new Map()
	/** Per-session hanging-GET responses, held open until the state changes. */
	const waiters = new Map()

	const respondWithState = (res, tracker) => {
		writeJson(res, 200, { suggestion: tracker.getSuggestion(), v: tracker.version })
	}

	const dropWaiter = (sessionId, res) => {
		const set = waiters.get(sessionId)
		if (set === undefined) return
		set.delete(res)
		if (set.size === 0) waiters.delete(sessionId)
	}

	const flushWaiters = (sessionId) => {
		const set = waiters.get(sessionId)
		if (set === undefined) return
		waiters.delete(sessionId)
		const tracker = trackers.get(sessionId)
		if (tracker === undefined) return
		for (const res of set) respondWithState(res, tracker)
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
		set.add(res)
		const timer = setTimeout(() => {
			dropWaiter(sessionId, res)
			if (!res.writableEnded) respondWithState(res, tracker)
		}, HANG_CAP_MS)
		res.on("close", () => {
			clearTimeout(timer)
			dropWaiter(sessionId, res)
		})
	}

	const trackerFor = (sessionId) => {
		let tracker = trackers.get(sessionId)
		if (tracker === undefined) {
			tracker = new SuggestionTracker()
			tracker.onChange = () => flushWaiters(sessionId)
			trackers.set(sessionId, tracker)
		}
		return tracker
	}

	const abortInflight = (sessionId) => {
		const controller = inflight.get(sessionId)
		if (controller !== undefined) {
			controller.abort()
			inflight.delete(sessionId)
		}
	}

	/**
	 * Replay the captured request and store the normalized suggestion. Any
	 * failure (including rate limits) gives up silently - a suggestion is
	 * best-effort by definition and is never retried.
	 */
	const generate = async (sessionId, action) => {
		abortInflight(sessionId)
		const controller = new AbortController()
		inflight.set(sessionId, controller)
		const startedAt = Date.now()
		const timer = setTimeout(() => controller.abort(), config.latencyCapMs)
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
				`${usagePart} latencyMs=${String(Date.now() - startedAt)}${extra}`
			ctx.logger?.info?.(line)
			if (config.logToFile) void appendUsageLog(line)
		}
		try {
			const request = buildReplayRequest({
				snapshot: action.snapshot,
				assistant: action.assistant,
				instruction: nextPromptInstruction,
				pluginName: name,
			})
			const reducer = createStreamReducer()
			for await (const chunk of ctx.llm.stream({ ...request, signal: controller.signal })) {
				const outcome = reducer.push(chunk)
				if (outcome === "tool_call") {
					controller.abort()
					logOutcome("tool_call_rejected", reducer)
					return
				}
				if (outcome === "done") break
				if (controller.signal.aborted) return
			}
			if (controller.signal.aborted) {
				logOutcome("cancelled", reducer, " reason=latency_cap_or_abort")
				return
			}
			const text = normalizeSuggestion(reducer.text, config.maxSuggestionChars)
			if (text === null) {
				logOutcome("empty", reducer, " chars=" + String(reducer.text.length))
				return
			}
			trackerFor(sessionId).setSuggestion({
				text,
				turn: action.turn,
				anchorMessageId: action.assistant.id,
				createdAt: Date.now(),
			})
			logOutcome("emitted", reducer, ` chars=${String(text.length)}`)
		} catch (error) {
			if (controller.signal.aborted) return
			const line =
				`next-prompt-suggestion: error session=${sessionId} turn=${String(action.turn)} ` +
				`provider=${String(action.snapshot.provider)} model=${String(action.snapshot.model)} ` +
				`latencyMs=${String(Date.now() - startedAt)} error=${String(error)}`
			ctx.logger?.warn?.(line)
			if (config.logToFile) void appendUsageLog(line)
		} finally {
			clearTimeout(timer)
			if (inflight.get(sessionId) === controller) inflight.delete(sessionId)
		}
	}

	// Passive capture: the loop deep-freezes its requests; we only copy.
	ctx.on("llm/stream", (options, next) => {
		if (typeof options.sessionId === "string" && options.purpose === undefined) {
			trackerFor(options.sessionId).captureRequest(options)
		}
		return next()
	})

	ctx.on("session/event", (session, event) => {
		const sessionId = sessionKey(session)
		if (sessionId === null) return
		const action = trackerFor(sessionId).onSessionEvent(event)
		if (action.type === "cancel_inflight") abortInflight(sessionId)
		else if (action.type === "generate") void generate(sessionId, action)
	})

	// Serve the live suggestion to the browser half. Registered as an exact
	// route (exact matches dispatch before the gateway's /api prefix route),
	// so the composer pill can poll it with a plain same-origin fetch.
	ctx.inject(["webServer"], (scope) => {
		scope.effect(
			() =>
				scope.webServer.register({
					kind: "exact",
					path: config.routePath,
					handler: async (req, res) => {
						try {
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
							const tracker = trackerFor(sessionId)
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
