import { analyzeQuery } from "../sql/analyzer.js";
import {
  buildCanonicalJsonExport,
  canonicalizeCanonicalJsonExport,
  serializeCanonicalJsonExport
} from "./exportContract.js";
import { serializeDeterministicMarkdownExport } from "./markdownContract.js";

export const BROWSER_EXPORT_FORMATS = Object.freeze({
  json: "json",
  markdown: "markdown"
});

export const BROWSER_EXPORT_MIME_TYPES = Object.freeze({
  [BROWSER_EXPORT_FORMATS.json]: "application/json;charset=utf-8",
  [BROWSER_EXPORT_FORMATS.markdown]: "text/markdown;charset=utf-8"
});

export const BROWSER_DOWNLOAD_STATES = Object.freeze({
  notStarted: "not-started",
  dispatchAttempted: "dispatch-attempted",
  dispatchReturned: "dispatch-returned"
});

export class BrowserExportDownloadError extends Error {
  constructor({ phase, dispatchState, primaryError, cleanupErrors = [] }) {
    const primaryMessage = errorMessage(primaryError);
    const cleanupSummary = cleanupErrors.length
      ? `; cleanup failures: ${cleanupErrors.map(({ phase: cleanupPhase, error }) => `${cleanupPhase}: ${errorMessage(error)}`).join(", ")}`
      : "";
    super(`Browser export ${phase} failed: ${primaryMessage}${cleanupSummary}`, { cause: primaryError });
    this.name = "BrowserExportDownloadError";
    this.phase = phase;
    this.dispatchState = dispatchState;
    this.primaryError = primaryError;
    this.cleanupErrors = Object.freeze(cleanupErrors.map(({ phase: cleanupPhase, error }) => (
      Object.freeze({ phase: cleanupPhase, error })
    )));
  }
}

const BROWSER_EXPORT_EXTENSIONS = Object.freeze({
  [BROWSER_EXPORT_FORMATS.json]: "json",
  [BROWSER_EXPORT_FORMATS.markdown]: "md"
});

export function buildBrowserExportArtifact(document, format) {
  assertSupportedFormat(format);
  const canonical = canonicalizeCanonicalJsonExport(document);
  const stem = `query-cartographer-${canonical.analysis.id}`;
  const content = format === BROWSER_EXPORT_FORMATS.json
    ? serializeCanonicalJsonExport(canonical)
    : serializeDeterministicMarkdownExport(canonical);

  return Object.freeze({
    format,
    filename: `${stem}.${BROWSER_EXPORT_EXTENSIONS[format]}`,
    mimeType: BROWSER_EXPORT_MIME_TYPES[format],
    content
  });
}

export function buildBrowserExportArtifactFromInputs(sql, schemaText = "", format) {
  if (typeof sql !== "string") throw new TypeError("Browser export SQL must be a string");
  if (typeof schemaText !== "string") throw new TypeError("Browser export schema must be a string");
  assertSupportedFormat(format);

  const analysis = analyzeQuery(sql, schemaText);
  const canonical = buildCanonicalJsonExport(analysis);
  return buildBrowserExportArtifact(canonical, format);
}

export function createBrowserExportHandler({
  format,
  readSql,
  readSchema,
  download = downloadBrowserExport,
  downloadOptions,
  onSuccess = () => {},
  onError = () => {}
}) {
  assertSupportedFormat(format);
  assertFunction(readSql, "readSql");
  assertFunction(readSchema, "readSchema");
  assertFunction(download, "download");
  assertFunction(onSuccess, "onSuccess");
  assertFunction(onError, "onError");

  return function handleBrowserExport() {
    try {
      const artifact = buildBrowserExportArtifactFromInputs(readSql(), readSchema(), format);
      download(artifact, downloadOptions);
      onSuccess(artifact);
      return Object.freeze({ ok: true, artifact });
    } catch (error) {
      onError(error);
      return Object.freeze({ ok: false, error });
    }
  };
}

export function downloadBrowserExport(artifact, {
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  BlobCtor = globalThis.Blob,
  URLRef = globalThis.URL,
  onCleanupError = null
} = {}) {
  assertArtifact(artifact);
  if (!documentRef?.body || typeof documentRef.createElement !== "function") {
    throw new TypeError("Browser document download APIs are unavailable");
  }
  if (!windowRef || typeof windowRef.setTimeout !== "function") {
    throw new TypeError("Browser scheduling APIs are unavailable");
  }
  if (typeof BlobCtor !== "function") throw new TypeError("Browser Blob API is unavailable");
  if (!URLRef || typeof URLRef.createObjectURL !== "function" || typeof URLRef.revokeObjectURL !== "function") {
    throw new TypeError("Browser object URL APIs are unavailable");
  }
  if (onCleanupError !== null && typeof onCleanupError !== "function") {
    throw new TypeError("onCleanupError must be a function or null");
  }

  const createElement = documentRef.createElement.bind(documentRef);
  const append = documentRef.body.append.bind(documentRef.body);
  const schedule = windowRef.setTimeout.bind(windowRef);
  const createObjectURL = URLRef.createObjectURL.bind(URLRef);
  const revokeObjectURL = URLRef.revokeObjectURL.bind(URLRef);
  let dispatchState = BROWSER_DOWNLOAD_STATES.notStarted;
  let blob;

  try {
    blob = new BlobCtor([artifact.content], { type: artifact.mimeType });
  } catch (error) {
    throw lifecycleError("blob", dispatchState, error);
  }

  let url;
  try {
    url = createObjectURL(blob);
  } catch (error) {
    throw lifecycleError("create-object-url", dispatchState, error);
  }

  let link = null;
  let operationPhase = "create-element";
  let primaryFailure = null;
  const cleanupErrors = [];
  let revocationAttempted = false;

  const recordFailure = (phase, error) => {
    if (!primaryFailure) primaryFailure = { phase, error };
    else cleanupErrors.push({ phase, error });
  };
  const revokeOnce = () => {
    if (revocationAttempted) return;
    revocationAttempted = true;
    revokeObjectURL(url);
  };

  try {
    operationPhase = "create-element";
    link = createElement("a");
    operationPhase = "assign-href";
    link.href = url;
    operationPhase = "assign-download";
    link.download = artifact.filename;
    operationPhase = "assign-hidden";
    link.hidden = true;
    operationPhase = "append";
    append(link);
    operationPhase = "click";
    dispatchState = BROWSER_DOWNLOAD_STATES.dispatchAttempted;
    link.click();
    dispatchState = BROWSER_DOWNLOAD_STATES.dispatchReturned;
  } catch (error) {
    recordFailure(operationPhase, error);
  } finally {
    if (link) {
      try {
        link.remove();
      } catch (error) {
        recordFailure("remove", error);
      }
    }

    try {
      schedule(() => {
        try {
          revokeOnce();
        } catch (error) {
          const deferredError = primaryFailure
            ? lifecycleError(primaryFailure.phase, dispatchState, primaryFailure.error, [...cleanupErrors, { phase: "revoke", error }])
            : lifecycleError("revoke", dispatchState, error);
          if (onCleanupError) onCleanupError(deferredError);
          else throw deferredError;
        }
      }, 0);
    } catch (error) {
      recordFailure("schedule-revoke", error);
      try {
        revokeOnce();
      } catch (revokeError) {
        recordFailure("revoke", revokeError);
      }
    }
  }

  if (primaryFailure) {
    throw lifecycleError(primaryFailure.phase, dispatchState, primaryFailure.error, cleanupErrors);
  }

  return Object.freeze({
    dispatchState,
    revocation: "scheduled"
  });
}

function lifecycleError(phase, dispatchState, primaryError, cleanupErrors = []) {
  return new BrowserExportDownloadError({ phase, dispatchState, primaryError, cleanupErrors });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function assertSupportedFormat(format) {
  if (!Object.values(BROWSER_EXPORT_FORMATS).includes(format)) {
    throw new TypeError(`Unsupported browser export format: ${String(format)}`);
  }
}

function assertArtifact(artifact) {
  if (!artifact || typeof artifact !== "object") throw new TypeError("Export artifact must be an object");
  assertSupportedFormat(artifact.format);
  if (typeof artifact.filename !== "string" || !artifact.filename) throw new TypeError("Export filename is required");
  if (artifact.mimeType !== BROWSER_EXPORT_MIME_TYPES[artifact.format]) {
    throw new TypeError("Export MIME type does not match its format");
  }
  if (typeof artifact.content !== "string") throw new TypeError("Export content must be text");
}

function assertFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
}
