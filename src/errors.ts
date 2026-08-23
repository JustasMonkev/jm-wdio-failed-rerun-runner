import type {
    FailedRerunJsonValue,
    FailedTestError
} from '#src/types'

// Signals a mistake in how the runner was invoked, rather than a fault inside it.
// The CLI prints these as a single line instead of a stack trace.
export class FailedRerunUsageError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'FailedRerunUsageError'
    }
}

// Guards against an error object whose own structure is hostile. This runs inside the
// WebdriverIO `afterTest` hook, so throwing here would lose the very failure record the
// rerun depends on.
const MAX_DEPTH = 200

export function serializeError(error: unknown, seen = new WeakSet<object>(), depth = 0): FailedTestError | undefined {
    if (typeof error === 'string' && error) {
        return {
            message: error
        }
    }

    if (!error || typeof error !== 'object') {
        return undefined
    }

    if (seen.has(error)) {
        return {
            message: '[Circular]'
        }
    }

    // `seen` tracks the ANCESTOR PATH, not every object ever visited. Leaving entries
    // behind would report a value merely reachable twice - two properties pointing at
    // one shared object, say - as circular, silently dropping real diagnostic data.
    if (depth >= MAX_DEPTH) {
        return {
            message: '[Max depth exceeded]'
        }
    }

    seen.add(error)

    try {
        const serialized: FailedTestError = {
            name: readStringProperty(error, 'name'),
            message: readStringProperty(error, 'message'),
            stack: readStringProperty(error, 'stack')
        }

        const cause = toJsonValue(readProperty(error, 'cause'), seen, depth + 1)
        if (cause !== undefined) {
            serialized.cause = cause
        }

        const details = getErrorDetails(error, seen, depth + 1)
        if (Object.keys(details).length > 0) {
            serialized.details = details
        }

        return serialized
    } finally {
        seen.delete(error)
    }
}

// `instanceof` walks the prototype chain, and a Proxy can throw from its getPrototypeOf
// trap. That would escape serializeError and cost us the failure record.
function isError(value: object) {
    try {
        return value instanceof Error
    } catch {
        return false
    }
}

function readStringProperty(value: object, key: string) {
    const read = readProperty(value, key)
    return typeof read === 'string' ? read : undefined
}

// A property can be an accessor that throws, and a Proxy can throw from `ownKeys` or
// `get`. Neither should be able to take down the run.
function safeEntries(value: object): Array<[string, unknown]> {
    let keys: string[]
    try {
        keys = Object.keys(value)
    } catch {
        return []
    }

    const entries: Array<[string, unknown]> = []
    for (const key of keys) {
        try {
            entries.push([key, (value as Record<string, unknown>)[key]])
        } catch {
            entries.push([key, '[Unreadable]'])
        }
    }

    return entries
}

function getErrorDetails(error: object, seen: WeakSet<object>, depth: number) {
    const details: Record<string, FailedRerunJsonValue> = {}

    for (const [key, value] of safeEntries(error)) {
        if (key === 'name' || key === 'message' || key === 'stack' || key === 'cause') {
            continue
        }

        const jsonValue = toJsonValue(value, seen, depth)
        if (jsonValue !== undefined) {
            details[key] = jsonValue
        }
    }

    return details
}

function toJsonValue(value: unknown, seen: WeakSet<object>, depth = 0): FailedRerunJsonValue | undefined {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return value
    }

    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : String(value)
    }

    if (!value || typeof value !== 'object') {
        return undefined
    }

    if (seen.has(value)) {
        return '[Circular]'
    }

    if (depth >= MAX_DEPTH) {
        return '[Max depth exceeded]'
    }

    if (isError(value)) {
        return errorToJsonValue(value as Error, seen, depth)
    }

    seen.add(value)

    try {
        // A revoked Proxy answers isError safely but throws from Array.isArray, and a
        // hostile object's traversal can throw too. The catch below covers both: nothing
        // about an error's payload may cost us the failure record.
        if (Array.isArray(value)) {
            return Array.from(value, (item) => toJsonValue(item, seen, depth + 1) ?? null)
        }

        const output: Record<string, FailedRerunJsonValue> = {}
        for (const [key, entryValue] of safeEntries(value)) {
            const jsonValue = toJsonValue(entryValue, seen, depth + 1)
            if (jsonValue !== undefined) {
                output[key] = jsonValue
            }
        }

        return output
    } catch {
        return '[Unreadable]'
    } finally {
        seen.delete(value)
    }
}

function errorToJsonValue(error: Error, seen: WeakSet<object>, depth: number): FailedRerunJsonValue | undefined {
    const serialized = serializeError(error, seen, depth)
    if (!serialized) {
        return undefined
    }

    const output: Record<string, FailedRerunJsonValue> = {}
    for (const [key, value] of Object.entries(serialized)) {
        if (value !== undefined) {
            output[key] = value
        }
    }

    return output
}

function readProperty(value: object, key: string) {
    try {
        return (value as Record<string, unknown>)[key]
    } catch {
        return undefined
    }
}
