import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import vm from "node:vm"

const loadClientBundle = () => {
	const registrations = []
	const sandbox = {
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
	vm.runInNewContext(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"), sandbox, {
		filename: "lib/client.js",
	})
	return { registrations, window: sandbox.window }
}

const reactStub = () => ({
	createElement: (type, props, ...children) => ({ type, props, children }),
	useEffect: () => {},
	useRef: (value) => ({ current: value }),
	useState: (value) => [value, () => {}],
})

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
