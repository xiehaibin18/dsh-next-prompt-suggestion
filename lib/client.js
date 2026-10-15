/**
 * Next-prompt suggestion, browser half.
 *
 * One `conversation.input.overlay` entry per Session: polls the host half's
 * exact route and, while a live suggestion exists, renders a subtle pill
 * above the composer. Clicking the pill copies the suggestion to the
 * clipboard for one paste into the draft (v0 accept path; direct draft
 * insertion through the slash input pipeline is the next iteration - see
 * README "Known limitations").
 *
 * Format note: plugin client resources execute as classic scripts through
 * the lazy CommonJS module table. The file must register a closure factory
 * via `window.__ModuleLoader__.load({ id, factory })`; the factory receives
 * the module-table `require` (platform modules only - react lives there) and
 * returns the Cordis plugin exports. First-party packages get this shape
 * from the shared tsdown client preset; this plugin ships the factory
 * hand-written because it has no build step.
 * @module dsh-next-prompt-suggestion/client
 */

const PLUGIN_ID = "dsh-next-prompt-suggestion"

const DEFAULT_ROUTE_PATH = "/api/plugins/next-prompt-suggestion"
const POLL_INTERVAL_MS = 4000
const COPIED_HINT_MS = 1600

const pillStyle = {
	display: "inline-flex",
	alignItems: "center",
	gap: "6px",
	margin: "2px 0 6px 10px",
	padding: "3px 10px",
	border: "1px solid rgba(128, 128, 128, 0.35)",
	borderRadius: "999px",
	background: "transparent",
	color: "inherit",
	opacity: 0.78,
	cursor: "pointer",
	fontSize: "12px",
	lineHeight: "20px",
	maxWidth: "calc(100% - 20px)",
	fontFamily: "inherit",
	textAlign: "left",
}

const markStyle = { flexShrink: 0, fontSize: 11, lineHeight: "20px" }
const textStyle = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }

const fetchSuggestion = async (routePath, sessionId, signal) => {
	const response = await fetch(`${routePath}?session=${encodeURIComponent(sessionId)}`, { signal })
	if (!response.ok) return null
	const payload = await response.json()
	if (payload === null || typeof payload !== "object") return null
	const suggestion = payload.suggestion
	if (suggestion === null || suggestion === undefined) return null
	if (typeof suggestion.text !== "string" || suggestion.text.length === 0) return null
	return suggestion
}

window.__ModuleLoader__.load({
	id: PLUGIN_ID,
	factory: (require) => {
		const { createElement, useEffect, useRef, useState } = require("react")

		/**
		 * The composer-anchored suggestion pill.
		 *
		 * @param props.suggestion - injected face: { sessionId, load(signal) }.
		 */
		function SuggestionPill({ suggestion }) {
			const [current, setCurrent] = useState(null)
			const [copied, setCopied] = useState(false)
			const dismissedAnchor = useRef(null)

			useEffect(() => {
				let stopped = false
				let timer = undefined
				const poll = async () => {
					try {
						const next = await suggestion.load()
						if (stopped) return
						if (next === null) {
							// The host cleared the suggestion (new turn); hide
							// unless the copy hint is still showing.
							if (dismissedAnchor.current === null) setCurrent(null)
						} else if (next.anchorMessageId !== dismissedAnchor.current) {
							setCurrent(next)
						}
					} catch {
						// Offline or host restart: keep the last state; the
						// next successful poll reconciles.
					}
					if (!stopped) timer = setTimeout(poll, POLL_INTERVAL_MS)
				}
				void poll()
				return () => {
					stopped = true
					clearTimeout(timer)
				}
			}, [suggestion])

			if (current === null && copied === false) return null

			const accept = () => {
				if (current === null) return
				const text = current.text
				dismissedAnchor.current = current.anchorMessageId
				setCurrent(null)
				setCopied(true)
				setTimeout(() => setCopied(false), COPIED_HINT_MS)
				try {
					void navigator.clipboard.writeText(text)
				} catch {
					// Clipboard may be unavailable (permissions); the hint
					// already told the user what the pill does.
				}
			}

			return createElement(
				"button",
				{
					type: "button",
					style: pillStyle,
					onClick: accept,
					title: "点击复制建议，粘贴到输入框发送 · Click to copy, then paste into the composer",
				},
				createElement("span", { style: markStyle }, copied ? "✓" : "✦"),
				createElement(
					"span",
					{ style: textStyle },
					copied ? "已复制到剪贴板 · Copied to clipboard" : current === null ? "" : current.text,
				),
			)
		}

		/**
		 * Client plugin body: register the overlay entry.
		 *
		 * @param ctx - client root context.
		 * @param config - the composition row config (shared with the host
		 *   half); only `routePath` matters here.
		 */
		const apply = (ctx, config) => {
			const routePath =
				config !== null && typeof config === "object" && typeof config.routePath === "string"
				? config.routePath
				: DEFAULT_ROUTE_PATH

			ctx.slots.inject("conversation.input.overlay", () =>
				ctx.slots.register(
					{
						name: "conversation.input.overlay",
						id: "next-prompt-suggestion",
						order: 3,
						inject: (sessionId) => ({
							suggestion: {
								sessionId,
								load: (signal) => fetchSuggestion(routePath, sessionId, signal),
							},
						}),
					},
					SuggestionPill,
				),
			)
		}

		return {
			name: "next-prompt-suggestion/client",
			inject: ["slots"],
			apply,
		}
	},
})
