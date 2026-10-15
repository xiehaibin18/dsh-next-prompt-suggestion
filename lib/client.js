/**
 * Next-prompt suggestion, browser half.
 *
 * One `conversation.input.overlay` entry per Session: polls the host half's
 * exact route and, while a live suggestion exists, floats a pill above the
 * composer card. Visibility is draft-emptiness driven: typing hides the
 * pill, clearing the draft brings it back (until the host invalidates the
 * suggestion on the next turn). Tab inside the composer (or a click) fills
 * the suggestion into the empty draft through the focused editor's own
 * input path.
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

// The overlay anchor is a zero-height absolute shell spanning the composer
// card's top edge; entries must float themselves above it like the trigger
// menu does (bottom: calc(100% + gap), z-index below the menu's 100). The
// wrapper stays mounted even while hidden so its DOM position - and with it
// the owning card reference - survives visibility changes.
const wrapperStyle = {
	position: "absolute",
	bottom: "calc(100% + 4px)",
	left: 0,
	zIndex: 90,
}

const pillStyle = {
	display: "inline-flex",
	alignItems: "center",
	gap: "6px",
	padding: "4px 12px",
	border: "1px solid rgba(128, 128, 128, 0.35)",
	borderRadius: "999px",
	background: "var(--dsw-specific-menu, rgba(32, 32, 32, 0.95))",
	color: "inherit",
	cursor: "pointer",
	fontSize: "12px",
	lineHeight: "20px",
	maxWidth: "100%",
	fontFamily: "inherit",
	textAlign: "left",
	boxShadow: "0 2px 8px rgba(0, 0, 0, 0.18)",
}

const markStyle = { flexShrink: 0, fontSize: 11, lineHeight: "20px" }
const textStyle = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
const hintStyle = { flexShrink: 0, opacity: 0.55, lineHeight: "20px" }

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

		const cardOf = (element) => element.closest("[data-composer-card]")

		const editorTextOf = (card) => {
			const editor = card.querySelector('[contenteditable="true"]')
			if (editor === null || editor === undefined) return ""
			return typeof editor.textContent === "string" ? editor.textContent : ""
		}

		/**
		 * Insert text into this pill's own composer draft. The event bus is a
		 * flat table and `slash/input-insert-text` requires an exact
		 * draft-revision match we cannot read from outside, so v0.1 fills the
		 * focused Lexical editor directly through the DOM: the caret is
		 * already there when the user pressed Tab or clicked the pill, and
		 * `execCommand("insertText")` enters through Lexical's own
		 * beforeinput path, keeping revisions and undo history correct. Only
		 * an untouched (empty) draft qualifies.
		 */
		const insertIntoOwnDraft = (wrapperElement, text) => {
			const card = cardOf(wrapperElement)
			if (card === null) return false
			// Never steal Tab from an open trigger menu (its listbox lives in
			// the same overlay anchor and owns Tab while visible).
			if (card.querySelector('[role="listbox"]') !== null) return false
			if (editorTextOf(card).trim().length > 0) return false
			const editor = card.querySelector('[contenteditable="true"]')
			if (editor === null || editor === undefined) return false
			editor.focus({ preventScroll: true })
			try {
				return document.execCommand("insertText", false, text)
			} catch {
				return false
			}
		}

		/**
		 * The composer-anchored suggestion pill. Server truth (a live
		 * suggestion) comes from the poll; local truth (draft emptiness)
		 * comes from input events on this pill's own card. The pill shows
		 * while both hold, so typing hides it and clearing the draft brings
		 * it back; a cleared draft also triggers one immediate poll refresh
		 * so a just-sent message (host already invalidated the suggestion)
		 * does not flash the stale pill for a poll interval.
		 *
		 * @param props.suggestion - injected face: { sessionId, load(signal) }.
		 */
		function SuggestionPill({ suggestion }) {
			const [current, setCurrent] = useState(null)
			const [draftEmpty, setDraftEmpty] = useState(true)
			const [copied, setCopied] = useState(false)
			const wrapperRef = useRef(null)
			const draftEmptyRef = useRef(true)

			useEffect(() => {
				let stopped = false
				let timer = undefined
				const poll = async () => {
					try {
						const next = await suggestion.load()
						if (!stopped) setCurrent(next)
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

			useEffect(() => {
				const refreshOnCleared = () => {
					void suggestion
						.load()
						.then((next) => {
							setCurrent(next)
						})
						.catch(() => undefined)
				}
				const onInput = (event) => {
					const wrapper = wrapperRef.current
					if (wrapper === null || wrapper === undefined) return
					const card = cardOf(wrapper)
					if (card === null || card.contains(event.target) !== true) return
					const empty = editorTextOf(card).trim().length === 0
					if (empty === true && draftEmptyRef.current === false) refreshOnCleared()
					draftEmptyRef.current = empty
					setDraftEmpty(empty)
				}
				document.addEventListener("input", onInput, true)
				return () => document.removeEventListener("input", onInput, true)
			}, [suggestion])

			useEffect(() => {
				const onKeyDown = (event) => {
					if (current === null || draftEmpty === false) return
					if (event.key !== "Tab" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
					if (event.isComposing === true) return
					const wrapper = wrapperRef.current
					if (wrapper === null || wrapper === undefined) return
					const card = cardOf(wrapper)
					if (card === null || card.contains(event.target) !== true) return
					if (insertIntoOwnDraft(wrapper, current.text) === true) {
						event.preventDefault()
						event.stopPropagation()
						draftEmptyRef.current = false
						setDraftEmpty(false)
					}
				}
				document.addEventListener("keydown", onKeyDown, true)
				return () => document.removeEventListener("keydown", onKeyDown, true)
			}, [current, draftEmpty])

			const visible = current !== null && draftEmpty

			const accept = () => {
				if (current === null) return
				const wrapper = wrapperRef.current
				const filled = wrapper !== null && wrapper !== undefined
					? insertIntoOwnDraft(wrapper, current.text)
					: false
				if (filled === true) {
					draftEmptyRef.current = false
					setDraftEmpty(false)
					return
				}
				// Insert unsupported: copy for one paste and show the hint.
				setCopied(true)
				setTimeout(() => setCopied(false), COPIED_HINT_MS)
				try {
					void navigator.clipboard.writeText(current.text)
				} catch {
					// Clipboard may be unavailable (permissions); the hint
					// already told the user what the pill does.
				}
			}

			return createElement(
				"div",
				{ ref: wrapperRef, style: wrapperStyle },
				visible === false
					? null
					: createElement(
							"button",
							{
								type: "button",
								style: pillStyle,
								onClick: accept,
								title:
									"Tab 或点击填入输入框 · Tab or click to fill the suggestion into the composer",
							},
							createElement("span", { style: markStyle }, copied ? "✓" : "✦"),
							createElement(
								"span",
								{ style: textStyle },
								copied ? "已复制到剪贴板 · Copied to clipboard" : current.text,
							),
							createElement("span", { style: hintStyle }, copied ? "" : "Tab"),
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
