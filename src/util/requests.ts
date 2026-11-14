export interface RequestLike {
  bytes: number;
  resourceType: string;
}

/** True when both URLs share an origin. Unparseable URLs count as first-party. */
export function sameOrigin(candidate: string, pageUrl: string): boolean {
  try {
    return new URL(candidate).origin === new URL(pageUrl).origin;
  } catch {
    return true;
  }
}

/**
 * Total transferred bytes, optionally for one resource type. Resource types are
 * matched case-insensitively because Lighthouse and CDP spell them differently.
 */
export function sumRequestBytes(requests: readonly RequestLike[], resourceType?: string): number {
  return requests
    .filter(
      (request) =>
        resourceType === undefined || request.resourceType.toLowerCase() === resourceType.toLowerCase(),
    )
    .reduce((total, request) => total + request.bytes, 0);
}
