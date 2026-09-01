/**
 * Capability model.
 *
 * Vendor support is capability-driven (architecture map §23). Adapters
 * declare capabilities; unsupported operations must throw
 * CapabilityNotSupportedError — never silently no-op.
 */

export const ROUTER_CAPABILITIES = [
  'CAP_AUTH',
  'CAP_DEAUTH',
  'CAP_RATE_LIMIT',
  'CAP_SESSION_CONTROL',
  'CAP_USAGE',
  'CAP_HEALTH',
  'CAP_CLIENT_DISCOVERY',
  'CAP_POLICY_READBACK',
] as const;

export type RouterCapability = (typeof ROUTER_CAPABILITIES)[number];

export interface CapabilitySet {
  readonly capabilities: readonly RouterCapability[];
  supports(capability: RouterCapability): boolean;
}

export function capabilitySet(capabilities: readonly RouterCapability[]): CapabilitySet {
  return {
    capabilities,
    supports: (capability: RouterCapability): boolean => capabilities.includes(capability),
  };
}
