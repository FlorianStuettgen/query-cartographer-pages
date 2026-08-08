import { normalizeIdentifier, tokenize, tokensToText } from "./tokenizer.js";

export const IDENTITY_SCHEMA_VERSION = "v1";
export const IDENTITY_NAMESPACE = "q02a";
export const CANONICAL_SOURCE_MODEL_ID_PATTERN = /^q02a-v1-source-model-[0-9a-f]{16}(?:-r(?:0[2-9]|[1-9][0-9]+))?$/;
const STABLE_DIGEST_BITS = 16;

export function canonicalClauseText(value) {
  const tokens = tokenize(String(value || ""));
  if (tokens.length === 0) return "";

  const normalizedTokens = tokens.map((token) => {
    if (token.type === "word" || token.type === "identifier") {
      return {
        ...token,
        value: token.normalized
      };
    }
    return token;
  });

  return tokensToText(normalizedTokens).replace(/\s+/g, " ").trim();
}

export function canonicalIdentifier(value) {
  return normalizeIdentifier(String(value || "")).trim();
}

export function normalizeValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeValue(value[key])]));
  }
  return value;
}

export function stableDigest(value) {
  const text = JSON.stringify(normalizeValue(value));
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  let hash = FNV_OFFSET;

  for (const char of text) {
    hash ^= BigInt(char.codePointAt(0) || 0);
    hash = (hash * FNV_PRIME) & 0xFFFFFFFFFFFFFFFFn;
  }

  return hash.toString(16).padStart(16, "0");
}

export function buildStableEntityId({ namespace = IDENTITY_NAMESPACE, kind, schemaVersion = IDENTITY_SCHEMA_VERSION, signature }) {
  const digest = stableDigest(signature);
  return `${namespace}-${schemaVersion}-${kind}-${digest.slice(0, STABLE_DIGEST_BITS)}`;
}

export function attachStableIdentity(records, {
  namespace = IDENTITY_NAMESPACE,
  schemaVersion = IDENTITY_SCHEMA_VERSION
} = {}) {
  const byLegacy = new Map();
  const byStable = new Map();
  const byLegacySet = new Map();
  const collisions = [];
  const byBase = new Map();
  const entities = [];

  for (const record of records) {
    const legacyId = record.id || "";
    const kind = record.kind || "entity";
    const signature = normalizeValue(record.signature);
    const stableIdBase = buildStableEntityId({
      namespace,
      schemaVersion,
      kind,
      signature
    });
    const count = byBase.get(stableIdBase) || 0;
    byBase.set(stableIdBase, count + 1);
    const stableOccurrence = count + 1;

    const stableId = count === 0
      ? stableIdBase
      : `${stableIdBase}-r${String(count + 1).padStart(2, "0")}`;

    byLegacy.set(legacyId, stableId);
    byStable.set(stableId, legacyId);
    byLegacySet.set(legacyId, [
      ...(byLegacySet.get(legacyId) || []),
      stableId
    ]);

    if (count > 0) {
      collisions.push({
        stableIdBase,
        stableId,
        legacyId,
        stableOccurrence: count + 1
      });
    }

    const payload = {
      id: legacyId,
      kind,
      stableId,
      stableIdBase,
      stableOccurrence,
      stableNamespace: namespace,
      stableVersion: schemaVersion,
      stableDigest: stableIdBase.split("-").pop()
    };
    entities.push(payload);

    if (record.target) {
      record.target.id = legacyId;
      record.target.legacyId = legacyId;
      record.target.stableId = stableId;
      record.target.stableIdBase = stableIdBase;
      record.target.stableOccurrence = stableOccurrence;
      record.target.stableNamespace = namespace;
      record.target.stableVersion = schemaVersion;
      record.target.stableDigest = stableIdBase.split("-").pop();
    }
  }

  const legacyToStableGroups = Object.fromEntries(
    [...byLegacySet.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([legacyId, stableIds]) => [
      legacyId,
      [...new Set(stableIds)].sort()
    ])
  );

  const stableToLegacy = Object.fromEntries([...byStable.entries()].sort(([left], [right]) => left.localeCompare(right)));

  return {
    schemaVersion,
    namespace,
    entities,
    legacyToStable: Object.fromEntries([...byLegacy.entries()].sort(([left], [right]) => left.localeCompare(right))),
    legacyToStableGroups,
    stableToLegacy,
    collisions
  };
}

export function canonicalIdForEntity(entity) {
  if (!entity) return "";
  return entity.stableId || entity.id || "";
}

function normalizeCandidateId(value) {
  return String(value ?? "").trim();
}

function hasOwn(map, value) {
  return map && Object.prototype.hasOwnProperty.call(map, value);
}

export function resolveCanonicalId(candidate, identity = null) {
  const normalized = normalizeCandidateId(candidate);
  if (!normalized) return { status: "unsupported", reason: "Empty input", canonicalId: "", legacyId: "" };
  if (!identity || !identity.legacyToStable || !identity.stableToLegacy) {
    return { status: "unsupported", reason: "Missing identity maps", canonicalId: "", legacyId: "" };
  }

  if (identity.legacyToStableGroups) {
    const candidates = identity.legacyToStableGroups[normalized];
    if (Array.isArray(candidates)) {
      if (candidates.length > 1) {
        return {
          status: "ambiguous",
          reason: `Ambiguous legacy ID '${normalized}'`,
          canonicalId: "",
          legacyId: "",
          input: normalized
        };
      }
      if (candidates.length === 1) {
        return {
          status: "resolved",
          canonicalId: candidates[0],
          legacyId: normalized,
          input: normalized
        };
      }
    }
  }

  if (hasOwn(identity.stableToLegacy, normalized)) {
    return {
      status: "resolved",
      canonicalId: normalized,
      legacyId: identity.stableToLegacy[normalized],
      input: normalized
    };
  }

  if (hasOwn(identity.legacyToStable, normalized)) {
    return {
      status: "resolved",
      canonicalId: identity.legacyToStable[normalized],
      legacyId: normalized,
      input: normalized
    };
  }

  return { status: "unsupported", reason: "Unknown id", canonicalId: "", legacyId: "", input: normalized };
}

export function resolveLegacyId(candidate, identity = null) {
  const result = resolveCanonicalId(candidate, identity);
  if (result.status !== "resolved") return { status: result.status, reason: result.reason, canonicalId: "", legacyId: "" };

  return {
    status: "resolved",
    canonicalId: result.canonicalId,
    legacyId: result.legacyId,
    input: result.input
  };
}

export function resolveRegistryId(candidate, identity = null) {
  return resolveCanonicalId(candidate, identity);
}
