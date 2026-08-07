# Vendored Agent Plugins schemas

The JSON schemas under `1.0.0/` are unmodified copies from the
[Agent Plugins specification repository](https://github.com/agentplugins/agent-plugins-spec)
at commit [`bd383552095128f6effe895b9257cfd580a6d179`](https://github.com/agentplugins/agent-plugins-spec/commit/bd383552095128f6effe895b9257cfd580a6d179):

- `schemas/1.0.0/plugin.schema.json`
- `schemas/1.0.0/mcp.schema.json`

They are vendored so CI validates manifests deterministically without network
access. Agent Plugins schemas are software material licensed under Apache-2.0;
the upstream license is reproduced in `LICENSE-Apache-2.0.txt`.

SHA-256 at the pinned upstream commit:

- `plugin.schema.json`: `0A4AAD95CE337878AD38802EBF0DAA3FDE76ABE3F65400C86BCBB1EC0B3AB883`
- `mcp.schema.json`: `6539175BFCDF43085855183E86DA40EA94B166547A72B47AE9A0A390516D3ACB`

These test fixtures are repository-only and are not included in the published
`@microsoft/spe-mcp` npm package.
