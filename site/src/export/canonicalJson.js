const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export function canonicalizeJsonValue(value) {
  return canonicalize(value, "$", new WeakSet());
}

export function serializeCanonicalJson(value) {
  return `${stringifyCanonical(canonicalizeJsonValue(value), 0)}\n`;
}

function canonicalize(value, path, ancestors) {
  if (value === null) return null;

  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`Canonical JSON does not support non-finite numbers at ${path}`);
      }
      return Object.is(value, -0) ? 0 : value;
    case "undefined":
    case "bigint":
    case "symbol":
    case "function":
      throw new TypeError(`Canonical JSON does not support ${typeof value} values at ${path}`);
    default:
      break;
  }

  if (ancestors.has(value)) {
    throw new TypeError(`Canonical JSON does not support cycles at ${path}`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return canonicalizeArray(value, path, ancestors);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Canonical JSON requires a plain object at ${path}`);
    }

    return canonicalizeObject(value, path, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function canonicalizeArray(value, path, ancestors) {
  const keys = Reflect.ownKeys(value);
  const indexKeys = [];

  for (const key of keys) {
    if (typeof key === "symbol") {
      throw new TypeError(`Canonical JSON does not support symbol properties at ${path}`);
    }
    if (key === "length") continue;
    if (!isArrayIndex(key, value.length)) {
      throw new TypeError(`Canonical JSON arrays cannot have extra properties at ${propertyPath(path, key)}`);
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    validateDataProperty(descriptor, propertyPath(path, key));
    indexKeys.push(key);
  }

  if (indexKeys.length !== value.length) {
    throw new TypeError(`Canonical JSON does not support sparse arrays at ${path}`);
  }

  const output = new Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      throw new TypeError(`Canonical JSON does not support sparse arrays at ${path}`);
    }
    output[index] = canonicalize(descriptor.value, `${path}[${index}]`, ancestors);
  }
  return output;
}

function canonicalizeObject(value, path, ancestors) {
  const stringKeys = [];

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      throw new TypeError(`Canonical JSON does not support symbol properties at ${path}`);
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    validateDataProperty(descriptor, propertyPath(path, key));
    stringKeys.push(key);
  }

  stringKeys.sort(compareCodeUnits);
  const output = {};

  for (const key of stringKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !hasOwn(descriptor, "value")) {
      throw new TypeError(`Canonical JSON requires a data property at ${propertyPath(path, key)}`);
    }
    Object.defineProperty(output, key, {
      value: canonicalize(descriptor.value, propertyPath(path, key), ancestors),
      enumerable: true,
      configurable: true,
      writable: true
    });
  }

  return output;
}

function validateDataProperty(descriptor, path) {
  if (!descriptor || !hasOwn(descriptor, "value")) {
    throw new TypeError(`Canonical JSON does not support accessor properties at ${path}`);
  }
  if (!descriptor.enumerable) {
    throw new TypeError(`Canonical JSON does not support non-enumerable properties at ${path}`);
  }
}

function isArrayIndex(key, length) {
  if (key === "") return false;
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function stringifyCanonical(value, depth) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const indentation = "  ".repeat(depth + 1);
    const closingIndentation = "  ".repeat(depth);
    const items = value.map((item) => `${indentation}${stringifyCanonical(item, depth + 1)}`);
    return `[\n${items.join(",\n")}\n${closingIndentation}]`;
  }

  const keys = Object.keys(value).sort(compareCodeUnits);
  if (keys.length === 0) return "{}";
  const indentation = "  ".repeat(depth + 1);
  const closingIndentation = "  ".repeat(depth);
  const properties = keys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return `${indentation}${JSON.stringify(key)}: ${stringifyCanonical(descriptor.value, depth + 1)}`;
  });
  return `{\n${properties.join(",\n")}\n${closingIndentation}}`;
}

function propertyPath(path, key) {
  return `${path}[${JSON.stringify(key)}]`;
}
