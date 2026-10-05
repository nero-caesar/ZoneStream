export type StreamAudienceType = "individual" | "church";

export type RedeemedSpecialAccess = {
  name: string;
  audienceType: StreamAudienceType;
  identity: string;
  sessionHash: string;
  usedAt: string;
  connectedAt?: string;
  disconnectedAt?: string;
};

export type SpecialAccessCode = {
  id: string;
  codeHash: string;
  encryptedCode: string;
  enabled: boolean;
  redeemedBy?: RedeemedSpecialAccess;
};

export type StreamAccessPolicy = {
  allAccess: boolean;
  churchAccess: boolean;
  individualAccess: boolean;
  specialAccess: boolean;
  blockedChurchAccessKeys: string[];
  specialAccessCodes: SpecialAccessCode[];
};

export type PublicSpecialAccessCode = {
  id: string;
  code: string;
  enabled: boolean;
  name?: string;
  audienceType?: StreamAudienceType;
  usedAt?: string;
  connectedAt?: string;
  disconnectedAt?: string;
  connected: boolean;
};

export type PublicSpecialAccessCodeState = {
  id: string;
  enabled: boolean;
};

export type PublicStreamAccessPolicy = {
  allAccess: boolean;
  churchAccess: boolean;
  individualAccess: boolean;
  specialAccess: boolean;
  blockedChurchAccessKeys: string[];
  specialAccessCodeStates: PublicSpecialAccessCodeState[];
};

export const DEFAULT_STREAM_ACCESS_POLICY: StreamAccessPolicy = {
  allAccess: true,
  churchAccess: true,
  individualAccess: true,
  specialAccess: true,
  blockedChurchAccessKeys: [],
  specialAccessCodes: [],
};

const POLICY_KEY = "zoneStreamAccess";

function isAudienceType(value: unknown): value is StreamAudienceType {
  return value === "individual" || value === "church";
}

function defaultStreamAccessPolicy(): StreamAccessPolicy {
  return {
    allAccess: true,
    churchAccess: true,
    individualAccess: true,
    specialAccess: true,
    blockedChurchAccessKeys: [],
    specialAccessCodes: [],
  };
}

function parseAccessFlags(record: Record<string, unknown>) {
  return {
    allAccess: record.allAccess !== false,
    churchAccess: record.churchAccess !== false,
    individualAccess: record.individualAccess !== false,
    specialAccess: record.specialAccess !== false,
    blockedChurchAccessKeys: Array.isArray(record.blockedChurchAccessKeys)
      ? record.blockedChurchAccessKeys.filter((key): key is string => typeof key === "string" && /^[a-f0-9]{64}$/i.test(key))
      : [],
  };
}

function defaultPublicStreamAccessPolicy(): PublicStreamAccessPolicy {
  return { allAccess: true, churchAccess: true, individualAccess: true, specialAccess: true, blockedChurchAccessKeys: [], specialAccessCodeStates: [] };
}

export function parsePublicStreamAccessPolicy(metadata?: string): PublicStreamAccessPolicy {
  if (!metadata) return defaultPublicStreamAccessPolicy();

  try {
    const parsed: unknown = JSON.parse(metadata);
    if (!parsed || typeof parsed !== "object") return defaultPublicStreamAccessPolicy();

    const policy = (parsed as Record<string, unknown>)[POLICY_KEY];
    if (!policy || typeof policy !== "object") return defaultPublicStreamAccessPolicy();

    const record = policy as Record<string, unknown>;
    const rawStates = Array.isArray(record.specialAccessCodeStates) ? record.specialAccessCodeStates : [];
    const specialAccessCodeStates = rawStates.flatMap((item): PublicSpecialAccessCodeState[] => {
      if (!item || typeof item !== "object") return [];
      const state = item as Record<string, unknown>;
      return typeof state.id === "string" && typeof state.enabled === "boolean"
        ? [{ id: state.id, enabled: state.enabled }]
        : [];
    });

    return { ...parseAccessFlags(record), specialAccessCodeStates };
  } catch {
    return defaultPublicStreamAccessPolicy();
  }
}

export function parseStreamAccessPolicy(
  metadata?: string,
  decryptPrivateCodes?: (encrypted: string) => unknown,
): StreamAccessPolicy {
  if (!metadata) return defaultStreamAccessPolicy();

  try {
    const parsed: unknown = JSON.parse(metadata);
    if (!parsed || typeof parsed !== "object") return defaultStreamAccessPolicy();

    const policy = (parsed as Record<string, unknown>)[POLICY_KEY];
    if (!policy || typeof policy !== "object") return defaultStreamAccessPolicy();

    const record = policy as Record<string, unknown>;
    let privateCodes: unknown;
    if (typeof record.encryptedSpecialAccessCodes === "string" && decryptPrivateCodes) {
      try {
        privateCodes = decryptPrivateCodes(record.encryptedSpecialAccessCodes);
      } catch {
        privateCodes = undefined;
      }
    }
    const rawCodes = Array.isArray(privateCodes)
      ? privateCodes
      : Array.isArray(record.specialAccessCodes)
        ? record.specialAccessCodes
        : [];
    const specialAccessCodes = rawCodes.flatMap((item): SpecialAccessCode[] => {
      if (!item || typeof item !== "object") return [];
      const code = item as Record<string, unknown>;
      if (
        typeof code.id !== "string" ||
        typeof code.codeHash !== "string" ||
        !/^[a-f0-9]{64}$/i.test(code.codeHash) ||
        typeof code.encryptedCode !== "string"
      ) {
        return [];
      }

      let redeemedBy: RedeemedSpecialAccess | undefined;
      if (code.redeemedBy && typeof code.redeemedBy === "object") {
        const redeemed = code.redeemedBy as Record<string, unknown>;
        if (
          typeof redeemed.name === "string" &&
          isAudienceType(redeemed.audienceType) &&
          typeof redeemed.identity === "string" &&
          typeof redeemed.sessionHash === "string" &&
          typeof redeemed.usedAt === "string"
        ) {
          redeemedBy = {
            name: redeemed.name,
            audienceType: redeemed.audienceType,
            identity: redeemed.identity,
            sessionHash: redeemed.sessionHash,
            usedAt: redeemed.usedAt,
            ...(typeof redeemed.connectedAt === "string" ? { connectedAt: redeemed.connectedAt } : {}),
            ...(typeof redeemed.disconnectedAt === "string" ? { disconnectedAt: redeemed.disconnectedAt } : {}),
          };
        }
      }

      return [{
        id: code.id,
        codeHash: code.codeHash,
        encryptedCode: code.encryptedCode,
        enabled: code.enabled !== false,
        ...(redeemedBy ? { redeemedBy } : {}),
      }];
    });

    return { ...parseAccessFlags(record), specialAccessCodes };
  } catch {
    return defaultStreamAccessPolicy();
  }
}

export function isPlatformViewerPaused(metadata?: string): boolean {
  if (!metadata) return false;
  try {
    const parsed: unknown = JSON.parse(metadata);
    return Boolean(parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).zoneStreamPlatformPaused === true);
  } catch {
    return false;
  }
}

export function serializeStreamAccessPolicy(policy: StreamAccessPolicy, encryptedSpecialAccessCodes: string, platformViewerPaused = false): string {
  return JSON.stringify({
    [POLICY_KEY]: {
      allAccess: policy.allAccess,
      churchAccess: policy.churchAccess,
      individualAccess: policy.individualAccess,
      specialAccess: policy.specialAccess,
      blockedChurchAccessKeys: policy.blockedChurchAccessKeys,
      specialAccessCodeStates: policy.specialAccessCodes.map(({ id, enabled }) => ({ id, enabled })),
      encryptedSpecialAccessCodes,
    },
    ...(platformViewerPaused ? { zoneStreamPlatformPaused: true } : {}),
  });
}

export function getPublicSpecialAccessCodes(
  policy: StreamAccessPolicy,
  decryptedCodes: Map<string, string>,
  connectedIdentities: Set<string> = new Set(),
): PublicSpecialAccessCode[] {
  return policy.specialAccessCodes.map((code) => ({
    id: code.id,
    code: decryptedCodes.get(code.id) ?? "••••••",
    enabled: code.enabled,
    ...(code.redeemedBy ? {
      name: code.redeemedBy.name,
      audienceType: code.redeemedBy.audienceType,
      usedAt: code.redeemedBy.usedAt,
      ...(code.redeemedBy.connectedAt ? { connectedAt: code.redeemedBy.connectedAt } : {}),
      ...(code.redeemedBy.disconnectedAt ? { disconnectedAt: code.redeemedBy.disconnectedAt } : {}),
      connected: connectedIdentities.has(code.redeemedBy.identity),
    } : { connected: false }),
  }));
}
