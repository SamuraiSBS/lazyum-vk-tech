const MIB = 1024 * 1024;

// Keep these aligned with template-parser.ts and content-parser.ts. Those
// parsers remain the source of validation too; the route checks avoid copying
// an oversized File into a Buffer before invoking them.
export const MAX_TEMPLATE_BYTES = 50 * MIB;
export const MAX_SOURCE_BYTES = 12 * MIB;
export const MAX_SOURCE_COUNT = 12;

export const REQUEST_BODY_LIMITS = {
  analyze: MAX_TEMPLATE_BYTES + 2 * MIB,
  generate: MAX_TEMPLATE_BYTES + MAX_SOURCE_COUNT * MAX_SOURCE_BYTES + 2 * MIB,
  // Inline slide images can make edited-document JSON larger than its PPTX.
  // Keep this below the 196-MiB proxy cap while bounding the buffered body.
  export: 128 * MIB,
} as const;

const DEFAULT_GENERATION_REQUESTS_PER_WINDOW = 5;
const DEFAULT_EXPORT_REQUESTS_PER_WINDOW = 30;
const DEFAULT_RATE_WINDOW_MS = 60_000;
const DEFAULT_CONCURRENT_HEAVY_OPERATIONS = 1;

export type HeavyOperationLease = { release(): void };
export type HeavyOperationClass = "generation" | "export";

export type RequestGuardOptions = {
  maxGenerationRequestsPerWindow?: number;
  maxExportRequestsPerWindow?: number;
  maxConcurrentHeavyOperations?: number;
  windowMs?: number;
  now?: () => number;
};

/**
 * Creates a process-local rolling-window rate guard and shared heavy-operation
 * semaphore. Deliberately does not key on forwarded headers: without a
 * trusted client address, those values are caller-controlled.
 */
export function createProcessRequestGuard(options: RequestGuardOptions = {}) {
  const maxRequestsPerWindow: Record<HeavyOperationClass, number> = {
    generation: options.maxGenerationRequestsPerWindow ?? DEFAULT_GENERATION_REQUESTS_PER_WINDOW,
    export: options.maxExportRequestsPerWindow ?? DEFAULT_EXPORT_REQUESTS_PER_WINDOW,
  };
  const maxConcurrentHeavyOperations = options.maxConcurrentHeavyOperations ?? DEFAULT_CONCURRENT_HEAVY_OPERATIONS;
  const windowMs = options.windowMs ?? DEFAULT_RATE_WINDOW_MS;
  const now = options.now ?? (() => performance.now());
  for (const [name, value] of Object.entries({ ...maxRequestsPerWindow, maxConcurrentHeavyOperations, windowMs })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  }

  const requestTimes: Record<HeavyOperationClass, number[]> = { generation: [], export: [] };
  let activeHeavyOperations = 0;

  return {
    acquireHeavyOperation(operationClass: HeavyOperationClass): HeavyOperationLease | Response {
      const currentTime = now();
      const classRequestTimes = requestTimes[operationClass];
      while (classRequestTimes.length > 0 && classRequestTimes[0] <= currentTime - windowMs) classRequestTimes.shift();

      if (classRequestTimes.length >= maxRequestsPerWindow[operationClass]) {
        const retryAfterSeconds = Math.max(1, Math.ceil((classRequestTimes[0] + windowMs - currentTime) / 1000));
        return guardErrorResponse(429, "RATE_LIMITED", "Request rate limit exceeded", retryAfterSeconds);
      }
      classRequestTimes.push(currentTime);

      if (activeHeavyOperations >= maxConcurrentHeavyOperations) {
        return guardErrorResponse(503, "SERVER_BUSY", "Server is busy", 2);
      }

      activeHeavyOperations += 1;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          activeHeavyOperations = Math.max(0, activeHeavyOperations - 1);
        },
      };
    },
  };
}

const PROCESS_REQUEST_GUARD_KEY = Symbol.for("vk-tech-hackathon.request-guards.process.v1");
type ProcessGlobalWithRequestGuard = typeof globalThis & {
  [key: symbol]: ReturnType<typeof createProcessRequestGuard> | undefined;
};

const processGlobal = globalThis as ProcessGlobalWithRequestGuard;
const processRequestGuard = processGlobal[PROCESS_REQUEST_GUARD_KEY]
  ?? (processGlobal[PROCESS_REQUEST_GUARD_KEY] = createProcessRequestGuard());

export function acquireHeavyOperation(operationClass: HeavyOperationClass): HeavyOperationLease | Response {
  return processRequestGuard.acquireHeavyOperation(operationClass);
}

/**
 * Reads at most maxBytes from the incoming stream, then replays those bounded
 * chunks through a replacement Request for formData()/json(). This catches
 * chunked bodies too; Content-Length is only an early-rejection hint.
 */
export async function limitRequestBody(request: Request, maxBytes: number): Promise<Request | Response> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("maxBytes must be a positive integer");

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength)) {
      return guardErrorResponse(400, "INVALID_CONTENT_LENGTH", "Invalid request content length");
    }
    if (Number(contentLength) > maxBytes) return bodyTooLargeResponse();
  }
  if (!request.body) return request;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return bodyTooLargeResponse();
      }
      chunks.push(value);
    }
  } catch {
    return guardErrorResponse(400, "INVALID_REQUEST_BODY", "Request body could not be read");
  } finally {
    reader.releaseLock();
  }

  const headers = new Headers(request.headers);
  headers.delete("transfer-encoding");
  headers.set("content-length", String(totalBytes));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const init = {
    method: request.method,
    headers,
    body,
    signal: request.signal,
    duplex: "half",
  } as RequestInit & { duplex: "half" };
  try {
    return new Request(request.url, init);
  } catch {
    return guardErrorResponse(400, "INVALID_REQUEST_BODY", "Request body could not be read");
  }
}

export function rejectOversizedFile(
  file: Pick<File, "size">,
  maximumBytes: number,
): Response | undefined {
  return file.size > maximumBytes ? bodyTooLargeResponse() : undefined;
}

export function rejectTooManySources(sourceCount: number): Response | undefined {
  return sourceCount > MAX_SOURCE_COUNT
    ? guardErrorResponse(413, "BODY_TOO_LARGE", `At most ${MAX_SOURCE_COUNT} source files are allowed`)
    : undefined;
}

function bodyTooLargeResponse() {
  return guardErrorResponse(413, "BODY_TOO_LARGE", "Request body is too large");
}

function guardErrorResponse(status: number, code: string, error: string, retryAfterSeconds?: number) {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  if (retryAfterSeconds !== undefined) headers.set("retry-after", String(retryAfterSeconds));
  return new Response(JSON.stringify({ error, code }), { status, headers });
}
