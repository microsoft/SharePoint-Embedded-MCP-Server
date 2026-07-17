// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared Azure CLI error classification for Conditional Access (CA) /
 * claims-challenge / interaction-required failures.
 *
 * Used by both the Azure CLI token path (azure-cli-token.ts) and the ARM control-plane
 * operations (azure-cli.ts: Syntex provider registration + Microsoft.Syntex
 * billing-account create) so that a CA step-up failure surfaces a single,
 * actionable remediation instead of a generic "command failed" or the plain
 * "not logged in" guidance.
 *
 * SCOPE NOTE (intentional): we do NOT attempt to automate a Conditional Access
 * claims-challenge step-up here. `az` cannot cleanly redeem a claims challenge
 * non-interactively, and the MCP server must not drive an interactive
 * `az login`. The supported behaviour is DETECT → SURFACE → DOCUMENT: detect the
 * CA/claims failure, tell the user exactly how to re-authenticate in their own
 * terminal (or via the SharePoint admin center step-up), then let them retry.
 * Full claims-challenge automation is future work and explicitly out of scope.
 */

/**
 * The ARM control-plane scope the SPE Builder requests for `az` token
 * acquisition and `az rest` ARM writes. Surfaced in the remediation command so
 * the user re-authenticates for the same resource that hit the CA policy.
 */
export const ARM_LOGIN_SCOPE = "https://management.core.windows.net//.default";

/** Placeholder used in remediation text when the tenant id cannot be resolved. */
const TENANT_PLACEHOLDER = "<your-tenant-id>";

/**
 * Heuristically classify whether an `az` failure message indicates a
 * Conditional Access / claims-challenge / interaction-required condition
 * (i.e. the user must perform an interactive step-up to satisfy policy).
 *
 * Matches, case-insensitively:
 *  - `interaction_required` / "interaction required" (OAuth/MSAL signal)
 *  - "claims" / "claim challenge" (CA claims challenge)
 *  - "conditional access"
 *  - "multifactor" / "multi-factor" / "MFA" (step-up auth)
 *  - WWW-Authenticate "insufficient_claims"
 *  - representative AADSTS step-up/CA codes: 50076, 50079, 50005, 53000-series
 *
 * Deliberately NARROWER than {@link isNotLoggedInError}: a plain "az login" /
 * "not logged in" message must NOT match here so callers can classify CA first
 * and fall back to the not-logged-in guidance.
 */
export function isConditionalAccessOrClaimsError(message: string): boolean {
  const m = message.toLowerCase();

  // Textual signals (provider-agnostic).
  if (
    m.includes("interaction_required") ||
    m.includes("interaction required") ||
    m.includes("interactionrequired") ||
    m.includes("conditional access") ||
    m.includes("insufficient_claims") ||
    m.includes("insufficient claims") ||
    m.includes("claim challenge") ||
    m.includes("claims challenge") ||
    m.includes("claims-challenge") ||
    m.includes("multifactor") ||
    m.includes("multi-factor") ||
    m.includes("mfa")
  ) {
    return true;
  }

  // A bare "claims" token (e.g. "...requires additional claims...") — kept
  // separate from the AADSTS check below so we still catch claims wording.
  if (m.includes("claims")) {
    return true;
  }

  // Representative AADSTS step-up / Conditional Access error codes.
  //  - AADSTS50076: MFA required for the resource.
  //  - AADSTS50079: user must enrol for MFA (proof-up).
  //  - AADSTS50005: device authentication / Conditional Access.
  //  - AADSTS53000–53003: device not compliant / blocked by CA policy.
  if (
    m.includes("aadsts50076") ||
    m.includes("aadsts50079") ||
    m.includes("aadsts50005") ||
    /aadsts5300[0-9]/.test(m)
  ) {
    return true;
  }

  return false;
}

/**
 * Error raised when an `az` token or ARM operation fails because Conditional
 * Access requires an interactive step-up. Distinct type so callers/tests can
 * identify it and so the high-level ARM helpers can enrich it with the tenant id
 * without re-classifying.
 */
export class ConditionalAccessError extends Error {
  readonly tenantId?: string;
  constructor(message: string, tenantId?: string) {
    super(message);
    this.name = "ConditionalAccessError";
    this.tenantId = tenantId;
  }
}

/**
 * Build the actionable remediation text for a Conditional Access step-up.
 * Pure/synchronous so it is trivially unit-testable; `tenantId` is interpolated
 * into the exact `az login` command (placeholder when unknown).
 */
export function conditionalAccessGuidance(tenantId?: string): string {
  const tenant = tenantId && tenantId.length > 0 ? tenantId : TENANT_PLACEHOLDER;
  return (
    "Conditional Access requires step-up authentication to complete this Azure (ARM) operation. " +
    "Re-authenticate interactively in your own terminal, then retry the operation:\n\n" +
    `  az login --scope ${ARM_LOGIN_SCOPE} --tenant ${tenant}\n\n` +
    "If interactive browser sign-in still fails the policy (e.g. an auth-context / \"p1\" step-up that " +
    "silent token acquisition reports as InteractionRequired with a claims challenge), complete the " +
    "step-up via the SharePoint admin center, then retry. See the \"Conditional Access / step-up\" note " +
    "in the standard-billing setup docs (mcp-server/README.md). " +
    "Note: full claims-challenge automation is not supported by the Azure CLI and is intentionally out of scope."
  );
}

/** Construct a {@link ConditionalAccessError} carrying the remediation guidance. */
export function asConditionalAccessError(tenantId?: string): ConditionalAccessError {
  return new ConditionalAccessError(conditionalAccessGuidance(tenantId), tenantId);
}

/**
 * If `error` indicates a Conditional Access / claims step-up, return a
 * {@link ConditionalAccessError} with actionable guidance (enriched with the
 * tenant id when available); otherwise return `error` unchanged.
 *
 * `resolveTenantId` is an optional best-effort async lookup (e.g. `az account
 * show`) used only when the tenant id is not already known. Any failure to
 * resolve it falls back to the placeholder — we never mask the original CA
 * signal just because the tenant id is unavailable.
 */
export async function enrichConditionalAccess(
  error: unknown,
  resolveTenantId?: () => Promise<string | undefined>,
): Promise<unknown> {
  const message = error instanceof Error ? error.message : String(error);
  if (!isConditionalAccessOrClaimsError(message)) {
    return error;
  }
  let tenantId: string | undefined;
  if (error instanceof ConditionalAccessError && error.tenantId) {
    tenantId = error.tenantId;
  } else if (resolveTenantId) {
    try {
      tenantId = await resolveTenantId();
    } catch {
      tenantId = undefined;
    }
  }
  return asConditionalAccessError(tenantId);
}
