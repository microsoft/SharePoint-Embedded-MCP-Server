// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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

