import { describe, expect, it } from "vitest";
import { POST as analyzeTemplate } from "../src/app/api/analyze/route";
import { POST as generatePresentation } from "../src/app/api/generate/route";
import { POST as exportPresentation } from "../src/app/api/export/route";
import { POST as exportPdf } from "../src/app/api/export/pdf/route";
import { POST as exportHtml } from "../src/app/api/export/html/route";
import {
  acquireHeavyOperation,
  createProcessRequestGuard,
  limitRequestBody,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_COUNT,
  MAX_TEMPLATE_BYTES,
  rejectOversizedFile,
  rejectTooManySources,
  REQUEST_BODY_LIMITS,
} from "../src/lib/request-guards";

describe("request guards", () => {
  it("keeps request caps aligned with the existing file and source limits", () => {
    expect(MAX_TEMPLATE_BYTES).toBe(50 * 1024 * 1024);
    expect(MAX_SOURCE_BYTES).toBe(12 * 1024 * 1024);
    expect(MAX_SOURCE_COUNT).toBe(12);
    expect(REQUEST_BODY_LIMITS).toEqual({
      analyze: 52 * 1024 * 1024,
      generate: 196 * 1024 * 1024,
      export: 128 * 1024 * 1024,
    });
  });

  it("rejects a declared oversized body before reading it", async () => {
    const request = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-length": "11", "content-type": "text/plain" },
      body: "small",
    });

    const result = await limitRequestBody(request, 10);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
    expect(request.bodyUsed).toBe(false);
    await expect((result as Response).json()).resolves.toMatchObject({ code: "BODY_TOO_LARGE" });
  });

  it("counts streamed bytes when Content-Length is absent", async () => {
    const request = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("ab"));
          controller.enqueue(new TextEncoder().encode("cd"));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    expect(request.headers.get("content-length")).toBeNull();
    const result = await limitRequestBody(request, 3);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
    await expect((result as Response).json()).resolves.toMatchObject({ code: "BODY_TOO_LARGE" });
  });

  it("replays an in-limit streamed body for normal request parsing", async () => {
    const request = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("ab"));
          controller.enqueue(new TextEncoder().encode("cd"));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const result = await limitRequestBody(request, 4);

    expect(result).not.toBeInstanceOf(Response);
    expect((result as Request).headers.get("content-length")).toBe("4");
    await expect((result as Request).text()).resolves.toBe("abcd");
  });

  it("rejects oversized individual files and source counts", async () => {
    expect(rejectOversizedFile({ size: MAX_TEMPLATE_BYTES }, MAX_TEMPLATE_BYTES)).toBeUndefined();
    expect(rejectOversizedFile({ size: MAX_TEMPLATE_BYTES + 1 }, MAX_TEMPLATE_BYTES)?.status).toBe(413);
    expect(rejectOversizedFile({ size: MAX_SOURCE_BYTES + 1 }, MAX_SOURCE_BYTES)?.status).toBe(413);
    expect(rejectTooManySources(MAX_SOURCE_COUNT)).toBeUndefined();
    expect(rejectTooManySources(MAX_SOURCE_COUNT + 1)?.status).toBe(413);
  });

  it("applies separate rolling request-frequency caps to generation and exports", async () => {
    let currentTime = 0;
    const guard = createProcessRequestGuard({
      maxConcurrentHeavyOperations: 40,
      now: () => currentTime,
    });
    const leases = [
      ...Array.from({ length: 5 }, () => guard.acquireHeavyOperation("generation")),
      ...Array.from({ length: 30 }, () => guard.acquireHeavyOperation("export")),
    ];

    const generationLimited = await guard.acquireHeavyOperation("generation");
    const exportLimited = await guard.acquireHeavyOperation("export");
    expect(generationLimited).toBeInstanceOf(Response);
    expect(exportLimited).toBeInstanceOf(Response);
    expect((generationLimited as Response).status).toBe(429);
    expect((generationLimited as Response).headers.get("retry-after")).toBe("60");
    expect((exportLimited as Response).status).toBe(429);
    expect((exportLimited as Response).headers.get("retry-after")).toBe("60");
    for (const lease of leases) if (!(lease instanceof Response)) lease.release();

    currentTime = 60_000;
    const afterWindow = await guard.acquireHeavyOperation("generation");
    expect(afterWindow).not.toBeInstanceOf(Response);
    if (!(afterWindow instanceof Response)) afterWindow.release();
  });

  it("shares one in-flight heavy-operation slot across route classes", async () => {
    const guard = createProcessRequestGuard({ maxConcurrentHeavyOperations: 1 });
    const generationLease = await guard.acquireHeavyOperation("generation");
    const blockedExport = await guard.acquireHeavyOperation("export");

    expect(generationLease).not.toBeInstanceOf(Response);
    expect(blockedExport).toBeInstanceOf(Response);
    expect((blockedExport as Response).status).toBe(503);
    expect((blockedExport as Response).headers.get("retry-after")).toBe("2");
    if (!(generationLease instanceof Response)) {
      generationLease.release();
      generationLease.release();
    }

    const nextLease = await guard.acquireHeavyOperation("export");
    expect(nextLease).not.toBeInstanceOf(Response);
    if (!(nextLease instanceof Response)) nextLease.release();
  });

  it("shares the process-global heavy-operation lease across all five routes", async () => {
    const heldLease = acquireHeavyOperation("generation");
    expect(heldLease).not.toBeInstanceOf(Response);
    if (heldLease instanceof Response) throw new Error("Could not acquire the process-global generation lease");

    const routes: Array<{ path: string; post(request: Request): Promise<Response> }> = [
      { path: "/api/analyze", post: analyzeTemplate },
      { path: "/api/generate", post: generatePresentation },
      { path: "/api/export", post: exportPresentation },
      { path: "/api/export/pdf", post: exportPdf },
      { path: "/api/export/html", post: exportHtml },
    ];
    const makeRequest = (path: string, contentLength = "8") => new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-length": contentLength, "content-type": "application/json" },
      body: "not json",
    });

    try {
      const blockedRoutes = await Promise.all(routes.map(async ({ path, post }) => {
        const request = makeRequest(path);
        return { request, response: await post(request) };
      }));

      for (const { request, response } of blockedRoutes) {
        expect(response.status).toBe(503);
        expect(response.headers.get("retry-after")).toBe("2");
        expect(request.bodyUsed).toBe(false);
        await expect(response.json()).resolves.toMatchObject({ code: "SERVER_BUSY" });
      }
    } finally {
      heldLease.release();
      heldLease.release();
    }

    const afterReleaseRequest = makeRequest("/api/analyze", String(REQUEST_BODY_LIMITS.analyze + 1));
    const afterReleaseResponse = await analyzeTemplate(afterReleaseRequest);
    expect(afterReleaseResponse.status).toBe(413);
    expect(afterReleaseResponse.headers.get("retry-after")).toBeNull();
    await expect(afterReleaseResponse.json()).resolves.toMatchObject({ code: "BODY_TOO_LARGE" });
  });

  it("rejects bodies above the shared PPTX, PDF, and HTML export cap before reading", async () => {
    const routes = [
      { path: "/api/export", post: exportPresentation },
      { path: "/api/export/pdf", post: exportPdf },
      { path: "/api/export/html", post: exportHtml },
    ];
    for (const { path, post } of routes) {
      const request = new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-length": String(REQUEST_BODY_LIMITS.export + 1), "content-type": "application/json" },
        body: "{}",
      });
      const response = await post(request);
      expect(response.status).toBe(413);
      expect(request.bodyUsed).toBe(false);
      await expect(response.json()).resolves.toMatchObject({ code: "BODY_TOO_LARGE" });
    }
  });
});
