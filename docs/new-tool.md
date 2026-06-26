# Adding a new tool

Use this checklist when contributing a new SPE MCP tool.

1. **Define the schema**
   - Create `src/tools/<tool>.ts`.
   - Export a `McpTool` with a grouped snake_case `name`, clear `description`, JSON-object `inputSchema`, and required fields where needed.

2. **Classify the tool**
   - Mark the plane in code review notes and docs: control plane, content plane, billing, docs, or lifecycle.
   - Use read-only behavior for inspect/list/get tools.
   - Treat delete, cleanup, billing setup, deployment, permission mutation, and content writes as destructive or write operations.
   - Content-plane tools must be gated with `withContentAccess(...)` in `src/index.ts`.

3. **Validate inputs**
   - Reuse shared validation helpers where available.
   - Return actionable errors instead of throwing for user-correctable input problems.

4. **Return structured MCP results**
   - Return `{ content: [{ type: "text", text }], isError? }`.
   - Include IDs, next steps, and retry guidance in successful output.

5. **Register the tool**
   - Import it in `src/index.ts`.
   - Add it to the `TOOLS` array in the right section.
   - Wrap content-plane tools with `withContentAccess(...)`.

6. **Test it**
   - Add a same-name test file next to the tool, such as `src/tools/<tool>.test.ts`.
   - Mock Graph, Azure CLI, filesystem, or process execution as needed.
   - Update registry tests if the tool catalog changes.

7. **Update user-facing surfaces**
   - Add or update prompts in `src/prompts.ts` if the tool belongs in a guided flow.
   - Add resources/runbooks in `src/resources.ts` when clients need copy/paste guidance.
   - Update docs under `docs/` and README tool tables when ownership allows.

8. **Validate locally**
   - Run `npm run typecheck` and `npm test`.
