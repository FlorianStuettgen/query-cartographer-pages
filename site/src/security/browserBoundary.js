const CONTROL_OR_BIDI_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const SAFE_CLASS_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/u;
export const TRUSTED_TYPES_POLICY_NAME = "query-cartographer-rendering";

const trustedMarkupPolicy = globalThis.trustedTypes?.createPolicy(TRUSTED_TYPES_POLICY_NAME, {
  createHTML(value) {
    return String(value);
  }
}) ?? null;

/**
 * Make invisible control and bidirectional-formatting characters explicit on
 * human-facing HTML/SVG/canvas surfaces. Raw editor and export bytes are kept
 * separately and are never passed through this display-only transformation.
 */
export function visibleText(value) {
  return String(value ?? "").replace(CONTROL_OR_BIDI_PATTERN, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0xffff
      ? `\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}`
      : `\\u{${codePoint.toString(16).toUpperCase()}}`;
  });
}

/** Escape untrusted text for an HTML or SVG text node in a reviewed template. */
export function escapeHtml(value) {
  return visibleText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/** Escape untrusted text for a quoted HTML or SVG attribute value. */
export function escapeHtmlAttribute(value) {
  return escapeHtml(value);
}

/**
 * Restrict values used as CSS class fragments to an explicit token grammar.
 * Product-controlled enums keep their original spelling; anything else is
 * represented by the non-semantic fallback instead of becoming markup.
 */
export function safeClassToken(value, fallback = "unknown") {
  const token = String(value ?? "");
  const fallbackToken = String(fallback ?? "");
  if (!SAFE_CLASS_TOKEN_PATTERN.test(fallbackToken)) {
    throw new TypeError("Class-token fallback must use the safe token grammar");
  }
  return SAFE_CLASS_TOKEN_PATTERN.test(token) ? token : fallbackToken;
}

/** Escape an exact value interpolated inside a quoted CSS attribute selector. */
export function escapeCssString(value) {
  return Array.from(String(value ?? ""), (character) => {
    if (/^[A-Za-z0-9_-]$/u.test(character)) return character;
    return `\\${character.codePointAt(0).toString(16).toUpperCase()} `;
  }).join("");
}

/**
 * The sole maintained structured-markup sink. Callers must construct markup
 * from product-owned structure and the escaping helpers above. Chromium's CSP
 * requires the named Trusted Types policy; other browsers retain the same
 * centralized code path without overstating equivalent enforcement.
 */
export function replaceTrustedMarkup(element, markup) {
  if (!element || !("innerHTML" in element)) {
    throw new TypeError("A markup-capable element is required");
  }
  element.innerHTML = trustedMarkupPolicy
    ? trustedMarkupPolicy.createHTML(String(markup ?? ""))
    : String(markup ?? "");
}

/** Prefer DOM construction and textContent for simple empty/status regions. */
export function replaceWithTextState(element, text, className = "empty-state") {
  if (!element?.ownerDocument || typeof element.replaceChildren !== "function") {
    throw new TypeError("A DOM element is required");
  }
  const child = element.ownerDocument.createElement("div");
  child.className = safeClassToken(className, "empty-state");
  child.textContent = visibleText(text);
  element.replaceChildren(child);
}

/**
 * Constrain download filenames to one inert basename with the extension that
 * matches the requested export format. This permits the historic `x.md` test
 * artifact while rejecting path, markup, control, and platform separator data.
 */
export function assertSafeDownloadFilename(filename, extension) {
  const value = String(filename ?? "");
  const extensionToken = String(extension ?? "");
  if (!/^[A-Za-z0-9]+$/u.test(extensionToken)) {
    throw new TypeError("Export extension must use the safe token grammar");
  }
  const expectedSuffix = `.${extensionToken}`;
  if (
    value.length < expectedSuffix.length + 1
    || value.length > 128
    || !value.endsWith(expectedSuffix)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
    || value === "."
    || value === ".."
  ) {
    throw new TypeError("Export filename must be a safe basename with the expected extension");
  }
  return value;
}
