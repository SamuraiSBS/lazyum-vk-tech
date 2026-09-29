import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const PptxGenJS = require("@studydeck/pptxgenjs") as new () => any;
const baseUrl = process.env.DEP07_BASE_URL;
const authorization = process.env.DEP07_BASIC_AUTH;
const badAuthorization = `Basic ${Buffer.from("dep07-invalid:wrong-password", "utf8").toString("base64")}`;
const describeRuntime = baseUrl && authorization ? describe : describe.skip;

// Opt in with DEP07_BASE_URL and DEP07_BASIC_AUTH. This only calls a local,
// already running deterministic container; it never provisions Docker resources.
describeRuntime("DEP-07 production-container flow", () => {
  it("publishes and reopens three audited variants, then downloads every export", async () => {
    const health = await fetch(`${baseUrl}/api/health`);
    const readyWithoutAuth = await fetch(`${baseUrl}/api/ready`);
    const readyWithBadAuth = await fetch(`${baseUrl}/api/ready`, { headers: { authorization: badAuthorization } });
    const ready = await fetch(`${baseUrl}/api/ready`, { headers: { authorization: `Basic ${authorization}` } });
    const generateWithoutAuth = await fetch(`${baseUrl}/api/generate`, { method: "POST" });
    const generateWithBadAuth = await fetch(`${baseUrl}/api/generate`, { method: "POST", headers: { authorization: badAuthorization } });
    const readyBody = await ready.json() as Record<string, any>;
    console.log(JSON.stringify({ phase: "preflight", health: health.status, unauthenticatedReady: readyWithoutAuth.status, badCredentialReady: readyWithBadAuth.status, authenticatedReady: ready.status, unauthenticatedGenerate: generateWithoutAuth.status, badCredentialGenerate: generateWithBadAuth.status, checks: readyBody.checks }));
    expect(health.status).toBe(200);
    expect(readyWithoutAuth.status).toBe(401);
    expect(readyWithBadAuth.status).toBe(401);
    expect(ready.status).toBe(200);
    expect(generateWithoutAuth.status).toBe(401);
    expect(generateWithBadAuth.status).toBe(401);
    expect(readyBody.checks?.artifactVolume).toBe(true);
    expect(Object.values(readyBody.checks?.rendererBinaries ?? {})).toEqual([true, true, true]);

    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_WIDE";
    pptx.author = "DEP-07 isolated acceptance";
    const slide = pptx.addSlide();
    slide.background = { color: "F3F7F5" };
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 0.25, fill: { color: "176B60" }, line: { color: "176B60" } });
    slide.addText("Полевой шаблон DEP-07", { x: 0.75, y: 0.8, w: 10.5, h: 0.65, fontFace: "Arial", fontSize: 32, bold: true, color: "174A43" });
    slide.addText("Отдельная композиция для локальной приёмки", { x: 0.75, y: 1.7, w: 9, h: 0.6, fontFace: "Arial", fontSize: 20, color: "174A43" });
    slide.addShape(pptx.ShapeType.ellipse, { x: 9.7, y: 3.8, w: 1.9, h: 1.9, fill: { color: "65AF91" }, line: { color: "176B60" } });
    const template = await pptx.write({ outputType: "nodebuffer" }) as Buffer;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLZ4QAAAABJRU5ErkJggg==", "base64");
    const form = new FormData();
    form.set("template", new File([new Uint8Array(template)], "dep07-unseen-template.pptx", { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }));
    form.set("brief", "Локальная проверка пяти слайдов о пилоте сервиса: цели, участники, этапы, риски и результаты.");
    form.set("slideCount", "5");
    form.append("materials", new File([new Uint8Array(png)], "pilot-image.png", { type: "image/png" }));

    const start = performance.now();
    const generated = await fetch(`${baseUrl}/api/generate`, { method: "POST", headers: { authorization: `Basic ${authorization}` }, body: form });
    const generationMs = Math.round(performance.now() - start);
    const payload = await generated.json() as Record<string, any>;
    console.log(JSON.stringify({ phase: "generate", status: generated.status, elapsedMs: generationMs, templateBytes: template.length, templateSha256: sha(template), pngBytes: png.length, pngSha256: sha(png), jobId: payload.jobId, manifestStatus: payload.manifest?.status, error: payload.error ?? null }));
    expect(generated.status).toBe(200);
    expect(payload.jobId).toMatch(/^job-/);
    expect(payload.manifest?.status).toBe("ready");
    expect(Object.keys(payload.presentations).sort()).toEqual(["balanced", "compact", "visual"]);
    expect(Object.keys(payload.audits).sort()).toEqual(["balanced", "compact", "visual"]);
    for (const variant of ["compact", "balanced", "visual"]) {
      expect(payload.audits[variant].passed).toBe(true);
      expect(payload.presentations[variant].slides).toHaveLength(5);
    }

    const reopened = await fetch(`${baseUrl}/api/jobs/${payload.jobId}`, { headers: { authorization: `Basic ${authorization}` } });
    const reopenedPayload = await reopened.json() as Record<string, any>;
    console.log(JSON.stringify({ phase: "reopen", status: reopened.status, jobId: reopenedPayload.manifest?.jobId, manifestStatus: reopenedPayload.manifest?.status ?? null }));
    expect(reopened.status).toBe(200);
    expect(reopenedPayload.manifest?.jobId).toBe(payload.jobId);
    expect(Object.keys(reopenedPayload.presentations).sort()).toEqual(["balanced", "compact", "visual"]);
    expect(Object.keys(reopenedPayload.audits).sort()).toEqual(["balanced", "compact", "visual"]);
    const unauthorizedJob = await fetch(`${baseUrl}/api/jobs/${payload.jobId}`);
    const unauthorizedArtifact = await fetch(`${baseUrl}/api/artifacts/${payload.jobId}/manifest.json`);
    console.log(JSON.stringify({ phase: "access", unauthorizedJob: unauthorizedJob.status, unauthorizedArtifact: unauthorizedArtifact.status }));
    expect(unauthorizedJob.status).toBe(401);
    expect(unauthorizedArtifact.status).toBe(401);

    for (const [format, route, magic] of [
      ["pptx", "/api/export", "504b"],
      ["pdf", "/api/export/pdf", "25504446"],
      ["html", "/api/export/html", "3c"],
    ] as const) {
      const response = await fetch(`${baseUrl}${route}`, { method: "POST", headers: { authorization: `Basic ${authorization}`, "content-type": "application/json" }, body: JSON.stringify({ jobId: payload.jobId, variant: "balanced" }) });
      const bytes = Buffer.from(await response.arrayBuffer());
      console.log(JSON.stringify({ phase: `export-${format}`, status: response.status, jobId: response.headers.get("x-vk-hackathon-job-id"), artifactPath: response.headers.get("x-vk-hackathon-artifact-path"), bytes: bytes.length, sha256: sha(bytes), elapsedMs: Math.round(performance.now() - start) }));
      expect(response.status).toBe(200);
      expect(bytes.subarray(0, magic.length / 2).toString("hex")).toBe(magic);
      expect(response.headers.get("x-vk-hackathon-job-id")).toBe(payload.jobId);
      expect(response.headers.get("x-vk-hackathon-artifact-path")).toBe(`exports/balanced/${format}.${format}`);
    }
    console.log(JSON.stringify({ phase: "full-flow", elapsedMs: Math.round(performance.now() - start), underFiveMinutes: performance.now() - start <= 300_000, jobId: payload.jobId }));
  }, 900_000);
});

function sha(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}
