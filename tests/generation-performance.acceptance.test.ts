import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST } from "../src/app/api/generate/route";
import { ArtifactStore } from "../src/lib/artifact-store";
import { artifactManifestSchema, type LayoutVariant } from "../src/lib/schemas";

// Opt in explicitly: VK_HACKATHON_GENERATION_PERFORMANCE=1 npm run test -- tests/generation-performance.acceptance.test.ts
const describePerformance = process.env.VK_HACKATHON_GENERATION_PERFORMANCE === "1" ? describe : describe.skip;
const variants = ["compact", "balanced", "visual"] as const satisfies readonly LayoutVariant[];
const limitMs = 300_000;
const fixtures = [
  { name: "VK Tech шаблон.pptx", sha256: "cbbe3aa6a21d23cebc4d1383b93dd07a9cea460d683de1903567b616c839485d" },
  { name: "VK_WorkSpace_Клиентская_конференция_Шаблон_03.pptx", sha256: "1b8883114486c69dff706e9c4fd9382727c4506c2cfa3ec34f86987f1e852f2f" },
] as const;

describePerformance("ordinary offline generation performance acceptance", () => {
  let artifactRoot: string;
  let originalRoot: string | undefined;
  let originalProvider: string | undefined;

  beforeAll(async () => {
    const tempRoot = path.resolve(".agent-state/tmp");
    await mkdir(tempRoot, { recursive: true });
    artifactRoot = await mkdtemp(path.join(tempRoot, "generation-performance-"));
    originalRoot = process.env.VK_HACKATHON_ARTIFACT_ROOT;
    originalProvider = process.env.VK_HACKATHON_LLM_PROVIDER;
    process.env.VK_HACKATHON_ARTIFACT_ROOT = artifactRoot;
    process.env.VK_HACKATHON_LLM_PROVIDER = "deterministic";
    vi.stubGlobal("fetch", async () => { throw new Error("Offline performance gate forbids network fetch"); });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (originalRoot === undefined) delete process.env.VK_HACKATHON_ARTIFACT_ROOT;
    else process.env.VK_HACKATHON_ARTIFACT_ROOT = originalRoot;
    if (originalProvider === undefined) delete process.env.VK_HACKATHON_LLM_PROVIDER;
    else process.env.VK_HACKATHON_LLM_PROVIDER = originalProvider;
    if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
  });

  for (const fixture of fixtures) {
    for (const slideCount of [10, 15] as const) {
      it(`${fixture.name}: ${slideCount} slides ready within five minutes`, async () => {
        const template = await readFile(path.resolve("fixtures/templates/organizer", fixture.name));
        expect(createHash("sha256").update(template).digest("hex")).toBe(fixture.sha256);
        const form = new FormData();
        form.set("template", new File([new Uint8Array(template)], fixture.name, {
          type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        }));
        form.set("brief", "Краткий обзор образовательной программы: цели, аудитория, этапы, результаты и дальнейшие шаги.");
        form.set("slideCount", String(slideCount));

        const start = performance.now();
        const response = await POST(new Request("http://localhost/api/generate", { method: "POST", body: form }));
        const elapsedMs = performance.now() - start;
        const payload = await response.json() as {
          jobId?: string;
          manifest?: unknown;
          presentations?: Record<string, { slides?: unknown[]; plan?: { meta?: { provider?: string } } }>;
          audits?: Record<string, { passed?: boolean; slides?: unknown[] }>;
          code?: string;
          stage?: string;
        };
        // Content-free, bounded evidence is emitted even when the performance assertion fails.
        console.log(JSON.stringify({ gate: "generation-performance", template: fixture.name,
          templateSha256: fixture.sha256, slideCount, elapsedMs: Math.round(elapsedMs),
          limitMs, httpStatus: response.status, jobId: payload.jobId ?? null,
          status: (payload.manifest as { status?: string } | undefined)?.status ?? null,
          errorCode: payload.code ?? null, errorStage: payload.stage ?? null }));

        expect(elapsedMs).toBeLessThanOrEqual(limitMs);
        expect(response.status).toBe(200);
        expect(payload.jobId).toMatch(/^job-[0-9a-f-]+$/);
        const manifest = artifactManifestSchema.parse(payload.manifest);
        expect(manifest.status).toBe("ready");
        expect(Object.keys(payload.presentations ?? {}).sort()).toEqual([...variants].sort());
        expect(Object.keys(payload.audits ?? {}).sort()).toEqual([...variants].sort());
        for (const variant of variants) {
          expect(payload.presentations?.[variant]?.slides).toHaveLength(slideCount);
          expect(payload.presentations?.[variant]?.plan?.meta?.provider).toBe("deterministic");
          expect(payload.audits?.[variant]?.passed).toBe(true);
          expect(payload.audits?.[variant]?.slides).toHaveLength(slideCount);
        }

        const reopened = await new ArtifactStore(artifactRoot).readPublishedGenerationJob(payload.jobId!);
        expect(reopened.manifest.status).toBe("ready");
        const variantRefs = manifest.artifacts.variants;
        const auditRefs = manifest.artifacts.audit;
        if (!variantRefs || !("compact" in variantRefs) || !auditRefs || !("compact" in auditRefs)) {
          throw new Error("Ready job has no published variant or audit references");
        }
        for (const variant of variants) {
          expect(reopened.presentations[variant].slides).toHaveLength(slideCount);
          expect(reopened.audits[variant].passed).toBe(true);
          for (const reference of [variantRefs[variant], auditRefs[variant]]) {
            expect(reference).toBeTruthy();
            expect(reference?.sha256).toMatch(/^[0-9a-f]{64}$/);
            const file = path.join(artifactRoot, payload.jobId!, reference!.relativePath);
            expect((await stat(file)).size).toBe(reference!.byteSize);
            expect(createHash("sha256").update(await readFile(file)).digest("hex")).toBe(reference!.sha256);
          }
        }
      }, 360_000);
    }
  }
});
