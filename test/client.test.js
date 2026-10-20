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
