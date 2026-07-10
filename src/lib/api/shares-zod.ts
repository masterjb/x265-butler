// 14-04 Task 3: zod boundary for /api/shares + /api/shares/[id].
//
// audit-fix SR1 — path hardening: traversal-reject + NUL-byte-reject +
// double-slash collapse via transform.
// audit-fix SR2 — extensions_csv: strict-parse + dedupe + lowercase +
// empty-after-norm reject.
// audit-fix SR3 — name allowlist: Unicode-letter/number + safe punct only
// (prevents log-line injection — pino structured-log fields with raw control
// chars otherwise contaminate the JSON stream).
//
// shareRepo (14-01) already validates min length / non-empty / absolute path.
// This boundary layers MORE-conservative checks BEFORE the repo so 400s carry
// structured fieldErrors and never reach the repo's generic throws.
//
// `shareUpdateSchema` keeps the same refinements but every field optional —
// PATCH supports filter-only OR path-only OR name-only patches.

import { z } from 'zod';
import { ShareNestedPathError } from '@/src/lib/db';

const namePattern = /^[\p{L}\p{N} _\-.()]+$/u;
const extensionsCharset = /^[a-zA-Z0-9,\s]+$/;

const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(namePattern, { message: 'name_invalid_chars' });

const pathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => p.startsWith('/'), { message: 'path_must_be_absolute' })
  .refine((p) => !p.split('/').some((seg) => seg === '..'), {
    message: 'path_traversal_rejected',
  })
  // eslint-disable-next-line no-control-regex
  .refine((p) => !/\x00/.test(p), { message: 'path_nul_byte_rejected' })
  .transform((p) => p.replace(/\/{2,}/g, '/'));

const minSizeMbSchema = z.number().int().min(0).max(102_400);

const extensionsCsvSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(extensionsCharset, { message: 'extensions_csv_invalid_chars' })
  .transform((s) =>
    Array.from(
      new Set(
        s
          .split(',')
          .map((e) => e.trim().toLowerCase())
          .filter(Boolean),
      ),
    ).join(','),
  )
  .refine((s) => s.length > 0, {
    message: 'extensions_csv_empty_after_normalization',
  });

const maxDepthSchema = z.number().int().min(0).max(50).nullable();

export const shareCreateSchema = z.object({
  name: nameSchema,
  path: pathSchema,
  min_size_mb: minSizeMbSchema,
  extensions_csv: extensionsCsvSchema,
  max_depth: maxDepthSchema,
});

export const shareUpdateSchema = z
  .object({
    name: nameSchema.optional(),
    path: pathSchema.optional(),
    min_size_mb: minSizeMbSchema.optional(),
    extensions_csv: extensionsCsvSchema.optional(),
    max_depth: maxDepthSchema.optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'empty_patch_body',
  });

export const idParamSchema = z.coerce.number().int().positive();

export type ShareCreateBody = z.infer<typeof shareCreateSchema>;
export type ShareUpdateBody = z.infer<typeof shareUpdateSchema>;

/**
 * Collapse a ZodError into a flat fieldErrors object suitable for
 * `{ error: 'validation_failed', fieldErrors }` API responses.
 *
 * Top-level refinements (no path) land under the conventional `_` key so
 * callers can detect them without losing first-class field-level mapping.
 */
export function fieldErrorsFromZod(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0]?.toString() ?? '_';
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

/**
 * Map repo-thrown errors into structured HTTP responses. Returns null when
 * the error is not recognized so the route can fall through to its 500 path.
 */
export function mapShareRepoErrorToHttp(
  err: unknown,
): { status: number; body: Record<string, unknown> } | null {
  if (err instanceof ShareNestedPathError) {
    return {
      status: 409,
      body: {
        error: 'share_path_nested',
        conflictingShareName: err.conflictingShareName,
        conflictingSharePath: err.conflictingSharePath,
        direction: err.direction,
      },
    };
  }
  const e = err as { code?: string; message?: string };
  if (e?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    if (e.message?.includes('shares.name')) {
      return { status: 409, body: { error: 'share_name_duplicate' } };
    }
    if (e.message?.includes('shares.path')) {
      return { status: 409, body: { error: 'share_path_duplicate' } };
    }
  }
  return null;
}
