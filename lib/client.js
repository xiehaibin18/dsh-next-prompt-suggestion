/**
 * Next-prompt suggestion, browser half.
 *
 * One `conversation.input.overlay` entry per Session: polls the host half's
 * exact route and, while a live suggestion exists, takes over the composer's
 * placeholder - the Mentat shape. A ghost text node with the native
 * placeholder's own class name replaces `[data-composer-placeholder]` while
 * the suggestion lives; because React mounts that native node only for an
 * empty draft, placeholder semantics give the show/hide behavior for free:
 * typing swaps the native node out (the ghost follows), clearing brings it
 * back, and a new turn drops the suggestion server-side. Tab inside the
 * composer fills the suggestion into the empty draft through the focused
 * editor's own input path.
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

const GHOST_ATTRIBUTE = "data-next-prompt-suggestion-ghost"

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
		 * Insert text into this composer's draft. The event bus is a flat
		 * table and `slash/input-insert-text` requires an exact
		 * draft-revision match we cannot read from outside, so v0.2 fills
		 * the focused Lexical editor directly through the DOM: the caret is
		 * already there when the user pressed Tab, and
		 * `execCommand("insertText")` enters through Lexical's own
		 * beforeinput path, keeping revisions and undo history correct.
		 * Only an untouched (empty) draft qualifies.
		 */
		const insertIntoDraft = (card, text) => {
			// Never steal Tab from an open trigger menu (its listbox lives
			// in the same overlay anchor and owns Tab while visible).
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
		 * Mirror the native placeholder with the suggestion text while a
		 * suggestion is live. The native `[data-composer-placeholder]` node
		 * is React-mounted exactly while the draft is empty; the ghost
		 * adopts its class name (identical styling for free) and the native
		 * node is hidden via visibility. A MutationObserver on the composer
		 * card re-applies on every placeholder (re)mount - typing unmounts
		 * it, clearing remounts it - so the ghost's presence tracks the
		 * native placeholder's presence without any local draft state.
		 */
		const createPlaceholderTakeover = (card) => {
			const state = { ghost: null, native: null, observer: null, text: null, applying: false }

			const releaseNative = () => {
				if (state.native !== null) {
					state.native.style.visibility = ""
					state.native = null
				}
			}

			const removeGhost = () => {
				if (state.ghost !== null) {
					state.ghost.remove()
					state.ghost = null
				}
			}

			const apply = () => {
				if (state.applying) return
				state.applying = true
				try {
					const native = card.querySelector("[data-composer-placeholder]")
					if (native === null || state.text === null) {
						removeGhost()
						releaseNative()
						return
					}
					if (state.native !== native) releaseNative()
					state.native = native
					native.style.visibility = "hidden"
					if (state.ghost === null || state.ghost.parentNode !== native.parentNode) {
						removeGhost()
						const parent = native.parentNode
						if (parent === null) return
						const ghost = document.createElement("div")
						ghost.className = native.className
						ghost.setAttribute("aria-hidden", "true")
						ghost.setAttribute(GHOST_ATTRIBUTE, "true")
						ghost.style.pointerEvents = "none"
						parent.insertBefore(ghost, native.nextSibling)
						state.ghost = ghost
					}
					if (state.ghost.textContent !== state.text) state.ghost.textContent = state.text
				} finally {
					state.applying = false
				}
			}

			return {
				set text(value) {
					state.text = value
					apply()
				},
				start() {
					state.observer = new MutationObserver(apply)
					state.observer.observe(card, { subtree: true, childList: true, characterData: true })
				},
				dispose() {
					if (state.observer !== null) state.observer.disconnect()
					removeGhost()
					releaseNative()
				},
			}
		}

		/**
		 * The placeholder takeover entry: owns no visible chrome of its own.
		 *
		 * @param props.suggestion - injected face: { sessionId, load(signal) }.
		 */
		function SuggestionPlaceholder({ suggestion }) {
			const [current, setCurrent] = useState(null)
			const takeoverRef = useRef(null)
			const cardRef = useRef(null)
			// The overlay entry mounts inside the composer card, so a stable
			// hidden wrapper locates the card even while this entry renders
			// nothing.
			const wrapperRef = useRef(null)

			const resolveCard = () => {
				const element = wrapperRef.current
				if (element === null || element === undefined) return null
				const card = cardOf(element)
				cardRef.current = card
				return card
			}

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
				const card = resolveCard()
				if (card === null) return undefined
				const takeover = createPlaceholderTakeover(card)
				takeoverRef.current = takeover
				takeover.start()
				takeover.text = current === null ? null : current.text
				return () => {
					takeoverRef.current = null
					takeover.dispose()
				}
				// Re-created when the suggestion crosses the null boundary;
				// text-only refreshes flow through the effect below.
			}, [current === null])

			useEffect(() => {
				const takeover = takeoverRef.current
				if (takeover !== null) takeover.text = current === null ? null : current.text
			}, [current])

			useEffect(() => {
				const onKeyDown = (event) => {
					if (current === null) return
					if (event.key !== "Tab" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
					if (event.isComposing === true) return
					const card = cardRef.current !== null ? cardRef.current : resolveCard()
					if (card === null || card.contains(event.target) !== true) return
					if (insertIntoDraft(card, current.text) === true) {
						event.preventDefault()
						event.stopPropagation()
					}
				}
				document.addEventListener("keydown", onKeyDown, true)
				return () => document.removeEventListener("keydown", onKeyDown, true)
			}, [current])

			return createElement("div", { ref: wrapperRef, style: { display: "none" } })
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
					SuggestionPlaceholder,
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
