import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import vm from "node:vm"

const clientSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8")

const createClientSandbox = (environment = {}) => {
	const registrations = []
	const sandbox = {
		AbortController,
		clearTimeout,
		setTimeout,
		...environment,
		window: {
			__ModuleLoader__: {
				mode: "queue",
				pendingQueue: [],
				load(registration) {
					registrations.push(registration)
				},
			},
		},
	}
	return { sandbox, registrations }
}

const runClientScript = (context) => {
	vm.runInContext(clientSource, context, { filename: "lib/client.js" })
}

const loadClientBundle = (environment) => {
	const created = createClientSandbox(environment)
	runClientScript(vm.createContext(created.sandbox))
	return { registrations: created.registrations, window: created.sandbox.window }
}

const reactStub = () => ({
	createElement: (type, props, ...children) => ({ type, props, children }),
	useEffect: () => {},
	useRef: (value) => ({ current: value }),
	useState: (value) => [value, () => {}],
})

const attributeMatches = (element, selector) => {
	const conditions = [...selector.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)]
	const tag = selector.replace(/\[[^\]]+\]/g, "").trim()
	if (tag.length > 0 && element.tagName !== tag.toUpperCase()) return false
	return conditions.every((match) => {
		const [, name, expected] = match
		if (!element.hasAttribute(name)) return false
		return expected === undefined || element.getAttribute(name) === expected
	})
}

class FakeElement {
	constructor(tagName, documentRef) {
		this.tagName = tagName.toUpperCase()
		this.ownerDocument = documentRef
		this.attributes = new Map()
		this.children = []
		this.parentNode = null
		this.style = {}
		this.className = ""
		this.textContent = ""
		this.focusCalls = 0
	}

	setAttribute(name, value) {
		this.attributes.set(name, String(value))
	}

	getAttribute(name) {
		return this.attributes.get(name) ?? null
	}

	hasAttribute(name) {
		return this.attributes.has(name)
	}

	append(...children) {
		for (const child of children) {
			child.parentNode = this
			this.children.push(child)
		}
	}

	insertBefore(node, reference) {
		const index = this.children.indexOf(reference)
		node.parentNode = this
		if (index < 0) this.children.push(node)
		else this.children.splice(index, 0, node)
	}

	remove() {
		if (this.parentNode === null) return
		const index = this.parentNode.children.indexOf(this)
		if (index >= 0) this.parentNode.children.splice(index, 1)
		this.parentNode = null
	}

	contains(candidate) {
		if (candidate === this) return true
		return this.children.some((child) => child.contains(candidate))
	}

	matches(selector) {
		return attributeMatches(this, selector)
	}

	closest(selector) {
		let current = this
		while (current !== null) {
			if (current.matches(selector)) return current
			current = current.parentNode
		}
		return null
	}

	querySelector(selector) {
		for (const child of this.children) {
			if (child.matches(selector)) return child
			const nested = child.querySelector(selector)
			if (nested !== null) return nested
		}
		return null
	}

	focus() {
		this.focusCalls += 1
		this.ownerDocument.activeElement = this
	}
}

const createComposerDom = ({ current, draft = "", placeholder = true }) => {
	const listeners = new Map()
	const execCalls = []
	const observers = []
	const documentRef = {
		activeElement: null,
		addEventListener(name, listener) {
			const entries = listeners.get(name) ?? []
			entries.push(listener)
			listeners.set(name, entries)
		},
		removeEventListener(name, listener) {
			const entries = listeners.get(name) ?? []
			const index = entries.indexOf(listener)
			if (index >= 0) entries.splice(index, 1)
		},
		createElement(tagName) {
			return new FakeElement(tagName, documentRef)
		},
		execCommand(command, _showUi, text) {
			execCalls.push({ command, text })
			if (command !== "insertText") return false
			const composerEditor = cardElement.querySelector('[data-composer-input][contenteditable="true"]')
			if (composerEditor === null) return false
			composerEditor.textContent = text
			return true
		},
		dispatch(name, event) {
			for (const listener of listeners.get(name) ?? []) listener(event)
		},
	}
	class FakeMutationObserver {
		constructor(callback) {
			this.callback = callback
			this.disconnected = false
			observers.push(this)
		}

		observe() {}

		disconnect() {
			this.disconnected = true
		}
	}

	const cardElement = new FakeElement("div", documentRef)
	cardElement.setAttribute("data-composer-card", "")
	const overlay = new FakeElement("div", documentRef)
	overlay.setAttribute("data-composer-overlay", "")
	const wrapper = new FakeElement("div", documentRef)
	overlay.append(wrapper)
	const editor = new FakeElement("div", documentRef)
	editor.setAttribute("data-composer-input", "")
	editor.setAttribute("contenteditable", "true")
	editor.textContent = draft
	const paragraph = new FakeElement("p", documentRef)
	editor.append(paragraph)
	const toolbar = new FakeElement("button", documentRef)
	toolbar.setAttribute("data-composer-toolbar", "")
	const nativePlaceholder = placeholder ? new FakeElement("div", documentRef) : null
	if (nativePlaceholder !== null) nativePlaceholder.setAttribute("data-composer-placeholder", "")
	cardElement.append(overlay, editor, ...(nativePlaceholder === null ? [] : [nativePlaceholder]), toolbar)
	documentRef.activeElement = editor
	const dom = {
		document: documentRef,
		MutationObserver: FakeMutationObserver,
		card: cardElement,
		overlay,
		wrapper,
		editor,
		paragraph,
		toolbar,
		nativePlaceholder,
		execCalls,
		current,
		mutations() {
			for (const observer of observers) {
				if (!observer.disconnected) observer.callback([], observer)
			}
		},
	}
	return dom
}

const createReactHarness = (current, documentRef, mountTarget) => {
	const effects = []
	const react = {
		createElement: (type, props, ...children) => {
			if (typeof type !== "string") return { type, props: props ?? {}, children }
			const element = documentRef.createElement(type)
			if (props?.className !== undefined) element.className = props.className
			if (props?.style !== undefined) Object.assign(element.style, props.style)
			if (props?.ref !== undefined) props.ref.current = element
			element.append(...children.filter((child) => child instanceof FakeElement))
			return element
		},
		useEffect: (effect) => {
			effects.push(effect)
		},
		useRef: (value) => ({ current: value }),
		useState: () => [current, () => {}],
	}
	return {
		react,
		mount(component, props) {
			const tree = component(props)
			mountTarget.append(tree)
			for (const effect of effects.splice(0)) effect()
		},
	}
}

/**
 * Minimal stateful React harness: re-renders on setState and runs effects
 * with dependency tracking, so the polling loop's success/failure branches
 * can be driven without a real React.
 */
const createDynamicReactHarness = (documentRef, mountTarget) => {
	const slots = []
	let hookCursor = 0
	let runEffects = []
	let lastEffects = []
	let currentTree = null
	let mountedComponent = null
	let mountedProps = null

	const depsEqual = (a, b) =>
		Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))

	const react = {
		createElement: (type, props, ...children) => {
			if (typeof type !== "string") return { type, props: props ?? {}, children }
			const element = documentRef.createElement(type)
			if (props?.className !== undefined) element.className = props.className
			if (props?.style !== undefined) Object.assign(element.style, props.style)
			if (props?.ref !== undefined) props.ref.current = element
			element.append(...children.filter((child) => child instanceof FakeElement))
			return element
		},
		useRef: (value) => {
			const index = hookCursor++
			if (slots[index] === undefined) slots[index] = { current: value }
			return slots[index]
		},
		useState: (initial) => {
			const index = hookCursor++
			if (slots[index] === undefined) slots[index] = { value: initial }
			const slot = slots[index]
			const setState = (next) => {
				slot.value = typeof next === "function" ? next(slot.value) : next
				render()
			}
			return [slot.value, setState]
		},
		useEffect: (effect, deps) => {
			runEffects.push({ index: hookCursor++, effect, deps })
		},
	}

	const render = () => {
		runEffects = []
		hookCursor = 0
		if (currentTree !== null) currentTree.remove()
		currentTree = mountedComponent(mountedProps)
		mountTarget.append(currentTree)
		const previousByIndex = new Map(lastEffects.map((entry) => [entry.index, entry]))
		const mountedIndexes = new Set()
		for (const entry of runEffects) {
			mountedIndexes.add(entry.index)
			const previous = previousByIndex.get(entry.index)
			if (previous !== undefined && depsEqual(previous.deps, entry.deps)) {
				entry.cleanup = previous.cleanup
				continue
			}
			previous?.cleanup?.()
			entry.cleanup = entry.effect()
		}
		for (const [index, previous] of previousByIndex) {
			if (mountedIndexes.has(index) === false) previous.cleanup?.()
		}
		lastEffects = runEffects
	}

	return {
		react,
		mount(component, props) {
			mountedComponent = component
			mountedProps = props
			render()
		},
		unmount() {
			for (const entry of lastEffects) entry.cleanup?.()
			lastEffects = []
			if (currentTree !== null) currentTree.remove()
			currentTree = null
		},
	}
}

const mountSuggestion = (dom) => {
	const { registrations } = loadClientBundle({
		document: dom.document,
		MutationObserver: dom.MutationObserver,
		fetch: async () => {
			throw new Error("fetch is not used by this fixture")
		},
	})
	const reactHarness = createReactHarness(dom.current, dom.document, dom.overlay)
	const exports = registrations[0].factory((specifier) => {
		if (specifier === "react") return reactHarness.react
		throw new Error(`unexpected client dependency: ${specifier}`)
	})
	let component = null
	const ctx = {
		slots: {
			inject: (_slotName, register) => register(),
			register: (_entry, registeredComponent) => {
				component = registeredComponent
				return _entry
			},
		},
	}
	exports.apply(ctx, {})
	reactHarness.mount(component, {
		suggestion: {
			sessionId: "session-1",
			load: () => new Promise(() => {}),
		},
	})
	return component
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

const tabEvent = (dom, target = dom.editor, overrides = {}) => {
	const event = {
		key: "Tab",
		shiftKey: false,
		altKey: false,
		ctrlKey: false,
		metaKey: false,
		isComposing: false,
		target,
		defaultPrevented: false,
		propagationStopped: false,
		preventDefault() {
			this.defaultPrevented = true
		},
		stopPropagation() {
			this.propagationStopped = true
		},
		...overrides,
	}
	dom.document.dispatch("keydown", event)
	return event
}

test("client bundle registers through __ModuleLoader__ with the package id", () => {
	const { registrations } = loadClientBundle()
	assert.equal(registrations.length, 1)
	assert.equal(registrations[0].id, "dsh-next-prompt-suggestion")
	assert.equal(typeof registrations[0].factory, "function")
})

test("client factory returns Cordis plugin exports requiring only react", () => {
	const { registrations } = loadClientBundle()
	const exports = registrations[0].factory(reactStub)
	assert.equal(exports.name, "next-prompt-suggestion/client")
	// Cross-realm arrays fail deepEqual prototype checks; compare element-wise.
	assert.equal(exports.inject.length, 1)
	assert.equal(exports.inject[0], "slots")
	assert.equal(typeof exports.apply, "function")
})

test("client apply registers the overlay entry with a per-session inject face", () => {
	const { registrations } = loadClientBundle()
	const exports = registrations[0].factory(reactStub)
	const registered = []
	const captured = []
	const ctx = {
		slots: {
			inject: (slotName, register) => {
				registered.push(slotName)
				register()
			},
			register: (entry, component) => {
				captured.push({ entry, component })
				return entry
			},
		},
	}
	exports.apply(ctx, {})
	assert.deepEqual(registered, ["conversation.input.overlay"])
	assert.equal(captured.length, 1)
	assert.equal(captured[0].entry.id, "next-prompt-suggestion")
	assert.equal(captured[0].entry.name, "conversation.input.overlay")
	assert.equal(typeof captured[0].component, "function")
	const face = captured[0].entry.inject("session-1")
	assert.equal(face.suggestion.sessionId, "session-1")
	assert.equal(typeof face.suggestion.load, "function")
})

test("client apply skips registration when the plugin is disabled", () => {
	const { registrations } = loadClientBundle()
	const exports = registrations[0].factory(reactStub)
	let injectCalls = 0
	const ctx = {
		slots: {
			inject: () => {
				injectCalls += 1
			},
			register: () => undefined,
		},
	}
	exports.apply(ctx, { enabled: false })
	assert.equal(injectCalls, 0)
})

const mountProductionSuggestion = async ({ dom, parkedTimers, server, fetchCalls }) => {
	const { registrations } = loadClientBundle({
		document: dom.document,
		MutationObserver: dom.MutationObserver,
		URLSearchParams,
		setTimeout: (callback) => {
			parkedTimers.push(callback)
			return parkedTimers.length
		},
		fetch: async (url) => {
			fetchCalls.push(String(url))
			return server.respond(String(url))
		},
	})
	const harness = createDynamicReactHarness(dom.document, dom.overlay)
	const exports = registrations[0].factory((specifier) => {
		if (specifier === "react") return harness.react
		throw new Error(`unexpected client dependency: ${specifier}`)
	})
	let component = null
	let entry = null
	const ctx = {
		slots: {
			inject: (_slotName, register) => register(),
			register: (registeredEntry, registeredComponent) => {
				entry = registeredEntry
				component = registeredComponent
				return registeredEntry
			},
		},
	}
	exports.apply(ctx, {})
	const suggestionFace = entry.inject("session-1").suggestion
	harness.mount(component, { suggestion: suggestionFace })
	return { harness, flushRetry: () => parkedTimers.shift()?.() }
}

const settleAll = async () => {
	for (let index = 0; index < 6; index += 1) await settle()
}

test("a failed probe clears the suggestion; the forced refresh restores it without waiting", async () => {
	const dom = createComposerDom({ current: null, placeholder: true })
	// Park retry timers instead of firing them: the test drives the loop's
	// turns directly and must not leave real timers behind.
	const parkedTimers = []
	const fetchCalls = []
	let pendingReject = null
	// The server version stays constant across the outage: only the forced
	// (version-less) recovery request can restore the suggestion promptly.
	const server = {
		failHangingRequest() {
			pendingReject?.(new Error("network lost"))
		},
		respond(url) {
			const knownVersion = new URL(url, "http://localhost").searchParams.get("v")
			if (knownVersion !== null && Number(knownVersion) === 1) {
				// Long poll: hold until the test fails the connection.
				return new Promise((_resolve, reject) => {
					pendingReject = reject
				})
			}
			return {
				ok: true,
				status: 200,
				json: async () => ({ suggestion: { text: "run the tests" }, v: 1 }),
			}
		},
	}
	const { harness, flushRetry } = await mountProductionSuggestion({ dom, parkedTimers, server, fetchCalls })

	const ghost = () => dom.card.querySelector('[data-next-prompt-suggestion-ghost="true"]')
	await settleAll()
	dom.mutations()
	assert.notEqual(ghost(), null)
	assert.equal(ghost().textContent, "run the tests")
	assert.equal(fetchCalls.length, 2)
	assert.ok(fetchCalls[0].includes("v=0"))
	assert.ok(fetchCalls[1].includes("v=1"))

	// The hanging probe fails; the previously shown suggestion must be
	// dropped instead of surviving the outage.
	server.failHangingRequest()
	await settleAll()
	assert.equal(ghost(), null)
	let event = tabEvent(dom)
	assert.equal(event.defaultPrevented, false)
	assert.equal(dom.execCalls.length, 0)

	// The forced (version-less) recovery request restores the unchanged
	// suggestion immediately instead of hanging on the known version.
	assert.equal(parkedTimers.length, 1)
	flushRetry()
	await settleAll()
	// The recovery request carries no version, and the loop immediately
	// re-opens the versioned long poll afterwards.
	assert.equal(fetchCalls.length, 4)
	assert.equal(new URL(fetchCalls[2], "http://localhost").searchParams.has("v"), false)
	assert.notEqual(ghost(), null)
	assert.equal(ghost().textContent, "run the tests")
	event = tabEvent(dom)
	assert.equal(event.defaultPrevented, true)
	assert.deepEqual(dom.execCalls, [{ command: "insertText", text: "run the tests" }])
	assert.ok(fetchCalls[3].includes("v=1"))

	harness.unmount()
})

test("after a host restart resets the version to zero, recovery never hangs on v=0", async () => {
	const dom = createComposerDom({ current: null, placeholder: true })
	const parkedTimers = []
	const fetchCalls = []
	let pendingReject = null
	let serverState = { text: "before restart" }
	let serverVersion = 5
	const server = {
		failHangingRequest() {
			pendingReject?.(new Error("network lost"))
		},
		restart() {
			serverState = { text: "fresh after restart" }
			serverVersion = 0
		},
		respond(url) {
			const knownVersion = new URL(url, "http://localhost").searchParams.get("v")
			if (knownVersion !== null && Number(knownVersion) === serverVersion) {
				return new Promise((_resolve, reject) => {
					pendingReject = reject
				})
			}
			return {
				ok: true,
				status: 200,
				json: async () => ({ suggestion: { text: serverState.text }, v: serverVersion }),
			}
		},
	}
	const { harness, flushRetry } = await mountProductionSuggestion({ dom, parkedTimers, server, fetchCalls })

	const ghost = () => dom.card.querySelector('[data-next-prompt-suggestion-ghost="true"]')
	await settleAll()
	assert.notEqual(ghost(), null)
	assert.ok(fetchCalls[1].includes("v=5"))

	server.failHangingRequest()
	await settleAll()
	assert.equal(ghost(), null)

	// A restarted host may expose exactly version 0; resetting the client's
	// version to 0 instead of forcing a full snapshot would hang here.
	server.restart()
	assert.equal(parkedTimers.length, 1)
	flushRetry()
	await settleAll()
	assert.equal(new URL(fetchCalls[2], "http://localhost").searchParams.has("v"), false)
	assert.notEqual(ghost(), null)
	assert.equal(ghost().textContent, "fresh after restart")
	assert.ok(fetchCalls[3].includes("v=0"))

	harness.unmount()
})

test("client classic script can reload twice in the same JavaScript global context", () => {
	const created = createClientSandbox()
	const context = vm.createContext(created.sandbox)
	runClientScript(context)
	runClientScript(context)
	assert.equal(created.registrations.length, 2)
	assert.equal(created.registrations[0].id, "dsh-next-prompt-suggestion")
	assert.equal(created.registrations[1].id, "dsh-next-prompt-suggestion")
	const exports = created.registrations[1].factory(reactStub)
	assert.equal(exports.name, "next-prompt-suggestion/client")
})

test("Tab in the focused editable inserts the visible suggestion", () => {
	const dom = createComposerDom({ current: { text: "run focused tests" } })
	mountSuggestion(dom)
	assert.ok(dom.card.querySelector("[data-next-prompt-suggestion-ghost]") !== null)

	const event = tabEvent(dom, dom.paragraph)
	assert.equal(event.defaultPrevented, true)
	assert.equal(event.propagationStopped, true)
	assert.deepEqual(dom.execCalls, [{ command: "insertText", text: "run focused tests" }])
	assert.equal(dom.editor.textContent, "run focused tests")
	assert.equal(dom.document.activeElement, dom.editor)
})

test("Tab from a composer toolbar control keeps normal navigation and does not insert", () => {
	const dom = createComposerDom({ current: { text: "must not insert" } })
	mountSuggestion(dom)
	dom.document.activeElement = dom.toolbar

	const event = tabEvent(dom, dom.toolbar)
	assert.equal(event.defaultPrevented, false)
	assert.equal(event.propagationStopped, false)
	assert.deepEqual(dom.execCalls, [])
	assert.equal(dom.document.activeElement, dom.toolbar)
	assert.equal(dom.editor.textContent, "")
})

test("Tab requires focus and event ownership in the actual editable composer", () => {
	const dom = createComposerDom({ current: { text: "must not insert" } })
	mountSuggestion(dom)
	dom.document.activeElement = dom.toolbar

	const event = tabEvent(dom, dom.editor)
	assert.equal(event.defaultPrevented, false)
	assert.deepEqual(dom.execCalls, [])
	assert.equal(dom.document.activeElement, dom.toolbar)
})

test("Tab rejects a nonempty draft even if a placeholder snapshot remains", () => {
	const dom = createComposerDom({ current: { text: "must not insert" }, draft: "already typed" })
	mountSuggestion(dom)

	const event = tabEvent(dom, dom.paragraph)
	assert.equal(event.defaultPrevented, false)
	assert.deepEqual(dom.execCalls, [])
	assert.equal(dom.editor.textContent, "already typed")
})

test("Tab rejects when the native placeholder or owned ghost suggestion is absent", async (t) => {
	await t.test("missing native placeholder", () => {
		const dom = createComposerDom({ current: { text: "must not insert" }, placeholder: false })
		mountSuggestion(dom)
		const event = tabEvent(dom, dom.paragraph)
		assert.equal(event.defaultPrevented, false)
		assert.deepEqual(dom.execCalls, [])
	})

	await t.test("detached ghost", () => {
		const dom = createComposerDom({ current: { text: "must not insert" } })
		mountSuggestion(dom)
		const ghost = dom.card.querySelector("[data-next-prompt-suggestion-ghost]")
		assert.ok(ghost !== null)
		ghost.remove()
		const event = tabEvent(dom, dom.paragraph)
		assert.equal(event.defaultPrevented, false)
		assert.deepEqual(dom.execCalls, [])
	})
})

test("Tab preserves an open composer menu", () => {
	const dom = createComposerDom({ current: { text: "must not insert" } })
	mountSuggestion(dom)
	const listbox = dom.document.createElement("div")
	listbox.setAttribute("role", "listbox")
	dom.card.append(listbox)

	const event = tabEvent(dom, dom.editor)
	assert.equal(event.defaultPrevented, false)
	assert.deepEqual(dom.execCalls, [])
})

test("Tab ignores modifier and composition variants", async (t) => {
	const variants = [
		{ name: "shift", value: { shiftKey: true } },
		{ name: "alt", value: { altKey: true } },
		{ name: "control", value: { ctrlKey: true } },
		{ name: "meta", value: { metaKey: true } },
		{ name: "composition", value: { isComposing: true } },
	]
	for (const variant of variants) {
		await t.test(variant.name, () => {
			const dom = createComposerDom({ current: { text: "must not insert" } })
			mountSuggestion(dom)
			const event = tabEvent(dom, dom.editor, variant.value)
			assert.equal(event.defaultPrevented, false)
			assert.deepEqual(dom.execCalls, [])
		})
	}
})

test("clearing the draft restores placeholder visibility and Tab acceptance", () => {
	const dom = createComposerDom({ current: { text: "restored suggestion" }, draft: "temporary", placeholder: false })
	mountSuggestion(dom)
	assert.equal(dom.card.querySelector("[data-next-prompt-suggestion-ghost]"), null)

	dom.editor.textContent = ""
	const nativePlaceholder = dom.document.createElement("div")
	nativePlaceholder.setAttribute("data-composer-placeholder", "")
	dom.card.insertBefore(nativePlaceholder, dom.toolbar)
	dom.mutations()

	assert.ok(dom.card.querySelector("[data-next-prompt-suggestion-ghost]") !== null)
	const event = tabEvent(dom, dom.paragraph)
	assert.equal(event.defaultPrevented, true)
	assert.deepEqual(dom.execCalls, [{ command: "insertText", text: "restored suggestion" }])
	assert.equal(dom.editor.textContent, "restored suggestion")
})
