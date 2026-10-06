// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export const MAX_TRIAL_CONTAINER_TYPES = 3;

interface BillingClassified {
  billingClassification?: string | null;
}

export function trialLimitPreflight(
  billingClassification: string | undefined,
  existingContainerTypes: ReadonlyArray<BillingClassified>,
): string | null {
  if (billingClassification !== "trial") return null;

  const trialCount = existingContainerTypes.filter(
    (containerType) => containerType.billingClassification === "trial",
  ).length;

  if (trialCount < MAX_TRIAL_CONTAINER_TYPES) return null;

  return (
    `This tenant already has ${trialCount} of ${MAX_TRIAL_CONTAINER_TYPES} trial container types, which is ` +
    "the SharePoint Embedded maximum — creating another would fail with " +
    '"Tenant has reached the maximum number of trial container types". To proceed:\n' +
    "1. **Reuse** an existing trial container type (run **container_type_list** to see them), or\n" +
    "2. **Delete** an unused trial container type (**container_type_delete**), or\n" +
    "3. Switch to **standard** billing by re-running with `billingClassification=standard` plus an Azure " +
    "subscription and resource group."
  );
}
