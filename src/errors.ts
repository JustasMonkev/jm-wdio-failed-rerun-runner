import type {
    FailedRerunJsonValue,
    FailedTestError
} from '#src/types'

export function serializeError(error: unknown, seen = new WeakSet<object>()): FailedTestError | undefined {
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

    seen.add(error)

    const err = error as Error
    const serialized: FailedTestError = {
        name: err.name,
        message: err.message,
        stack: err.stack
    }

    const cause = toJsonValue(readProperty(error, 'cause'), seen)
    if (cause !== undefined) {
        serialized.cause = cause
    }

    const details = getErrorDetails(error, seen)
    if (Object.keys(details).length > 0) {
        serialized.details = details
    }

    return serialized
}

function getErrorDetails(error: object, seen: WeakSet<object>) {
    const details: Record<string, FailedRerunJsonValue> = {}

    for (const [key, value] of Object.entries(error)) {
        if (key === 'name' || key === 'message' || key === 'stack' || key === 'cause') {
            continue
        }

        const jsonValue = toJsonValue(value, seen)
        if (jsonValue !== undefined) {
            details[key] = jsonValue
        }
    }

    return details
}

function toJsonValue(value: unknown, seen: WeakSet<object>): FailedRerunJsonValue | undefined {
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

    if (value instanceof Error) {
        return errorToJsonValue(value, seen)
    }

    seen.add(value)

    if (Array.isArray(value)) {
        return value.map((item) => toJsonValue(item, seen) ?? null)
    }

    const output: Record<string, FailedRerunJsonValue> = {}
    for (const [key, entryValue] of Object.entries(value)) {
        const jsonValue = toJsonValue(entryValue, seen)
        if (jsonValue !== undefined) {
            output[key] = jsonValue
        }
    }

    return output
}

function errorToJsonValue(error: Error, seen: WeakSet<object>): FailedRerunJsonValue | undefined {
    const serialized = serializeError(error, seen)
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
    return (value as Record<string, unknown>)[key]
}
