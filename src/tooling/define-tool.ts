// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `defineTool` — the canonical factory for MCP tools in this server.
 *
 * WHY THIS EXISTS: every tool must advertise a JSON `inputSchema` (so clients
 * know how to call it) AND validate the arguments it actually receives at
 * runtime. Hand-writing both means two declarations of the same contract that
 * silently drift — a field marked `required` in the advertised schema but only
 * truthiness-checked in the handler, an `as string` cast that throws on a number,
 * a JSON Schema that says `number` while the handler coerces strings, etc.
 *
 * `defineTool` collapses that to ONE source of truth: a Zod object schema. From
 * that single declaration it derives all three things, guaranteeing they cannot
 * diverge:
 *   1. the advertised `inputSchema` — generated via `zodToJsonSchema`, so the
 *      published JSON Schema always matches what is enforced;
 *   2. runtime validation — `schema.parse()` runs before the handler body; a
 *      failure becomes a standard `fail("INVALID_ARGS", …)` envelope (`isError:
 *      true`) instead of an uncaught `TypeError`;
 *   3. the handler's argument TYPE — `handler` receives `z.infer<typeof schema>`,
 *      so validated, correctly-typed args flow in with no casts.
 *
 * Compose schemas from the shared field builders in `./fields.ts`
 * (`nonEmptyString`, `guid`, `positiveInt`, `folderPath`) so validation
 * semantics (trimming, GUID shape, integer clamping, path normalization) stay
 * identical across every tool.
 *
 * IDEMPOTENCY CONTRACT: the server dispatch (`index.ts`) calls `validateArgs`
 * once and the returned tool `handler` parses again, so any `.transform()` in a
 * schema MUST be a fixed point — `parse(parse(x))` has to equal `parse(x)`. The
 * `fields.ts` builders honor this (e.g. `folderPath` normalizes to a string, not
 * an array).
 *
 * @example
 * const schema = z.object({
 *   containerId: nonEmptyString("containerId", "The container ID."),
 *   folderPath: folderPath("folderPath", { required: true }),
 * });
 * export const createFolderTool = defineTool({
 *   name: "content_folder_create",
 *   description: "Create a folder …",
 *   schema,
 *   handler: async (args) => {
 *     // args.containerId: string, args.folderPath: string — already validated.
 *     return ok(…);
 *   },
 * });
 */

import { z, ZodError, type ZodObject, type ZodRawShape } from "zod/v3";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ValidationError } from "../errors.js";
import { fail } from "../responses.js";
import type { McpTool, McpToolAnnotations, McpToolResult } from "../types.js";

type ObjectSchema = ZodObject<ZodRawShape>;

interface DefineToolOptions<TSchema extends ObjectSchema> {
  name: string;
  description: string;
  annotations?: McpToolAnnotations;
  schema: TSchema;
  validationErrorMessage?: (error: ZodError) => string;
  handler: (args: z.infer<TSchema>) => Promise<McpToolResult>;
}

function inputSchemaFromZod(schema: ObjectSchema): McpTool["inputSchema"] {
  const json = zodToJsonSchema(schema, {
    $refStrategy: "none",
    target: "jsonSchema7",
  }) as Record<string, unknown>;

  return {
    type: "object",
    properties: (json.properties as Record<string, unknown> | undefined) ?? {},
    ...(Array.isArray(json.required) ? { required: json.required as string[] } : {}),
  };
}

function validationMessage(error: ZodError, custom?: (error: ZodError) => string): string {
  if (custom) return custom(error);
  return error.issues[0]?.message ?? "Invalid tool arguments";
}

function parseArgs<TSchema extends ObjectSchema>(
  schema: TSchema,
  args: Record<string, unknown>,
  custom?: (error: ZodError) => string,
): z.infer<TSchema> {
  try {
    return schema.parse(args);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ValidationError(validationMessage(error, custom));
    }
    throw error;
  }
}

export function defineTool<TSchema extends ObjectSchema>(options: DefineToolOptions<TSchema>): McpTool {
  const inputSchema = inputSchemaFromZod(options.schema);
  return {
    name: options.name,
    description: options.description,
    annotations: options.annotations,
    inputSchema,
    validateArgs: (args) => parseArgs(options.schema, args, options.validationErrorMessage),
    handler: async (args) => {
      let parsed: z.infer<TSchema>;
      try {
        parsed = parseArgs(options.schema, args, options.validationErrorMessage);
      } catch (error) {
        if (error instanceof ValidationError) {
          return fail(error.code, error.message, error.suggestion);
        }
        throw error;
      }
      return options.handler(parsed);
    },
  };
}

export { z };

