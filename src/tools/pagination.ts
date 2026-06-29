// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared pagination helpers (TOOL-003).
 *
 * List/search tools accept `top` (page size) and `skip` (offset) and return a
 * structured `{ items, totalCount, hasMore, nextToken }` envelope alongside the
 * human-readable markdown summary, so MCP agents can traverse large tenants
 * deterministically instead of overflowing a single markdown table.
 *
 * `nextToken` is the opaque resumable cursor — it encodes the next `skip` value
 * and can be passed back as `skip` (or `continuationToken`) on the next call.
 */

export interface PageArgs {
  top: number;
  skip: number;
}

export interface PageResult<T> {
  items: T[];
  totalCount: number;
  hasMore: boolean;
  /** Opaque cursor for the next page, or undefined when there is no next page. */
  nextToken?: string;
}

const DEFAULT_TOP = 50;
const MAX_TOP = 200;

function toPositiveInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/**
 * Parse `top`/`limit` and `skip`/`continuationToken`/`nextToken` from raw tool
 * args, clamping `top` to `[1, maxTop]`.
 */
export function parsePageArgs(
  args: Record<string, unknown>,
  opts: { defaultTop?: number; maxTop?: number } = {},
): PageArgs {
  const defaultTop = opts.defaultTop ?? DEFAULT_TOP;
  const maxTop = opts.maxTop ?? MAX_TOP;

  // `maxResults` is accepted as a back-compat alias for `top`.
  const rawTop = args.top ?? args.limit ?? args.maxResults;
  const top = Math.min(Math.max(toPositiveInt(rawTop, defaultTop), 1), maxTop);

  // A continuation token / nextToken is just an encoded skip offset.
  const rawSkip = args.skip ?? args.continuationToken ?? args.nextToken;
  const skip = toPositiveInt(rawSkip, 0);

  return { top, skip };
}

/** Slice an already-materialized collection into a page (client-side). */
export function paginate<T>(items: T[], { top, skip }: PageArgs): PageResult<T> {
  const totalCount = items.length;
  const page = items.slice(skip, skip + top);
  const nextSkip = skip + page.length;
  const hasMore = nextSkip < totalCount;
  return {
    items: page,
    totalCount,
    hasMore,
    ...(hasMore ? { nextToken: String(nextSkip) } : {}),
  };
}

/**
 * Build a page envelope when the underlying source already applied the window
 * server-side (e.g. Microsoft Search `from`/`size`). `total` is the full result
 * count reported by the source.
 */
export function pageFromServerWindow<T>(
  items: T[],
  { skip }: PageArgs,
  total: number,
): PageResult<T> {
  const nextSkip = skip + items.length;
  const hasMore = nextSkip < total;
  return {
    items,
    totalCount: total,
    hasMore,
    ...(hasMore ? { nextToken: String(nextSkip) } : {}),
  };
}

/** A short markdown footer describing the current page, when paginating. */
export function pageFooter(page: PageResult<unknown>, skip: number): string {
  if (skip === 0 && !page.hasMore) return "";
  const from = page.items.length === 0 ? 0 : skip + 1;
  const to = skip + page.items.length;
  let line = `\n_Showing ${from}–${to} of ${page.totalCount}._`;
  if (page.hasMore) line += ` Pass \`skip: ${page.nextToken}\` for the next page.`;
  return line;
}
