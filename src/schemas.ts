import * as z from 'zod'

import type {
    FailedRerunJsonValue,
    FailedTestError,
    FailedTestRecord,
    FailedRerunServiceOptions
} from '#src/types'

export const failedRerunAttemptTypeSchema = z.enum(['initial', 'rerun'])
export const failedRerunFrameworkSchema = z.enum(['mocha', 'cucumber'])

export const failedRerunJsonValueSchema: z.ZodType<FailedRerunJsonValue> = z.lazy(() => z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(failedRerunJsonValueSchema),
    z.record(z.string(), failedRerunJsonValueSchema)
]))

export const failedTestErrorSchema: z.ZodType<FailedTestError> = z.object({
    name: z.string().optional(),
    message: z.string().optional(),
    stack: z.string().optional(),
    cause: failedRerunJsonValueSchema.optional(),
    details: z.record(z.string(), failedRerunJsonValueSchema).optional()
}).strict()

export const failedTestRecordSchema: z.ZodType<FailedTestRecord> = z.object({
    attempt: failedRerunAttemptTypeSchema,
    framework: failedRerunFrameworkSchema,
    spec: z.string().min(1),
    fullTitle: z.string().min(1),
    title: z.string().optional(),
    cid: z.string().optional(),
    error: failedTestErrorSchema.optional()
}).strict()

export const failedRerunServiceOptionsSchema: z.ZodType<FailedRerunServiceOptions> = z.object({
    manifestPath: z.string({
        error: 'FailedTestRerunService requires a manifestPath option'
    }).min(1, {
        error: 'FailedTestRerunService requires a manifestPath option'
    }),
    attempt: failedRerunAttemptTypeSchema.optional()
}).strict()

export const jsonSerializableValueSchema = failedRerunJsonValueSchema
