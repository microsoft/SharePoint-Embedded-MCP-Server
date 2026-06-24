// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TENANT_ID: string;
  readonly VITE_CLIENT_ID: string;
  readonly VITE_CONTAINER_TYPE_ID: string;
  readonly VITE_CONTAINER_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
