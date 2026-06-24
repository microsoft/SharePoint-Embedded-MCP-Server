// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * MCP Resources — reference architectures exposed for client-agnostic
 * enumeration and retrieval. Each architecture is a resource whose contents are
 * a JSON manifest (id, name, description, language, file list).
 */

import { REFERENCE_ARCHITECTURES, findArchitecture } from "./reference-architectures.js";

const URI_PREFIX = "spe://reference-architectures/";

export const SPE_RESOURCES = REFERENCE_ARCHITECTURES.map((a) => ({
  uri: `${URI_PREFIX}${a.id}`,
  name: a.name,
  description: a.description,
  mimeType: "application/json",
}));

export function readResource(uri: string) {
  if (!uri.startsWith(URI_PREFIX)) {
    throw new Error(`Unknown resource URI: ${uri}`);
  }
  const id = uri.slice(URI_PREFIX.length);
  const arch = findArchitecture(id);
  if (!arch) {
    throw new Error(`Unknown reference architecture: ${id}`);
  }
  const manifest = {
    id: arch.id,
    name: arch.name,
    description: arch.description,
    language: arch.language,
    files: Object.keys(arch.files(arch.id)),
  };
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(manifest, null, 2),
      },
    ],
  };
}
