import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import {
  artifactManifestSchema,
  auditReportSchema,
  generationPlanningSchema,
  presentationDocumentSchema,
  renderEvidenceSchema,
  type ArtifactInput,
  type InputSourceArtifact,
  type ArtifactReference,
  type TemplateImageArtifact,
  type ArtifactManifest,
  type ArtifactReferences,
  type AuditReport,
  type DesignSystem,
  type ExportFormat,
  type LayoutVariant,
  type NormalizedContent,
  type PresentationDocument,
  type PresentationPlan,
  generationStageTraceSchema,
  designSystemSchema,
} from "./schemas";
import {
  publishedVariantRankingSchema,
  type PublishedVariantRanking,
} from "./agent-contracts";
import type { RenderEvidenceBundle } from "./render-evidence";

export const ARTIFACT_RELATIVE_PATHS = {
  template: "input/template.pptx",
  parsedDesignSystem: "parsed/design-system.json",
  parsedRenderEvidence: "parsed/render-evidence.json",
  renderDirectory: "parsed/renders",
  renderPdf: "parsed/renders/template.pdf",
  planning: "planning/plan.json",
  variantsDirectory: "variants",
  audit: "audit/report.json",
  orchestrationDirectory: "orchestration",
  juryRanking: "orchestration/jury-ranking.json",
  stageTrace: "orchestration/stage-trace.json",
  auditsDirectory: "audit",
  manifest: "manifest.json",
} as const;

export type SavedGenerationArtifactsForJury = {
  plan: PresentationPlan;
  variants: Record<LayoutVariant, PresentationDocument>;
  audits: Record<LayoutVariant, AuditReport>;
  references: {
    plan: ArtifactReference;
    variants: Record<LayoutVariant, ArtifactReference>;
    audits: Record<LayoutVariant, ArtifactReference>;
  };
};

export function renderSlideRelativePath(slideNumber: number) {
  if (!Number.isInteger(slideNumber) || slideNumber <= 0) throw new Error("Invalid render slide number");
  return `${ARTIFACT_RELATIVE_PATHS.renderDirectory}/slide-${slideNumber}.png`;
}

export function variantRelativePath(variant: LayoutVariant) {
  if (variant !== "compact" && variant !== "balanced" && variant !== "visual") {
    throw new Error("Invalid generation variant");
  }
  return `${ARTIFACT_RELATIVE_PATHS.variantsDirectory}/${variant}.json`;
}

export function auditRelativePath(variant: LayoutVariant) {
  if (variant !== "compact" && variant !== "balanced" && variant !== "visual") {
    throw new Error("Invalid generation variant");
  }
  return `${ARTIFACT_RELATIVE_PATHS.auditsDirectory}/${variant}.json`;
}

export function exportRelativePath(variant: LayoutVariant, format: ExportFormat) {
  if (variant !== "compact" && variant !== "balanced" && variant !== "visual") {
    throw new Error("Invalid generation variant");
  }
  if (format !== "pptx" && format !== "pdf" && format !== "html") {
    throw new Error("Invalid export format");
  }
  const extension = format === "pptx" ? ".pptx" : format === "pdf" ? ".pdf" : ".html";
  return `exports/${variant}/${format}${extension}`;
}

const EMPTY_ARTIFACT_REFERENCES: ArtifactReferences = {
  parsed: null,
  templateImages: [],
  renderEvidence: null,
  renders: null,
  planning: null,
  variants: null,
  exports: null,
  audit: null,
  orchestration: null,
};

export function getArtifactRoot() {
  const configuredRoot = process.env.VK_HACKATHON_ARTIFACT_ROOT?.trim();
  return path.resolve(configuredRoot || path.join(process.cwd(), ".data", "vk-tech-hackathon", "jobs"));
}

export function sha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function imageMimeFromTarget(target: string): TemplateImageArtifact["mimeType"] | undefined {
  const extension = target.split(".").pop()?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  if (extension === "svg") return "image/svg+xml";
  return undefined;
}

function mimeExtension(mime: TemplateImageArtifact["mimeType"]) {
  return mime === "image/jpeg" ? "jpg" : mime.split("/")[1].replace("svg+xml", "svg");
}

function dataUrlDigest(url: string, mime: string) {
  const prefix = `data:${mime};base64,`;
  if (!url.startsWith(prefix)) return undefined;
  const encoded = url.slice(prefix.length);
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return undefined;
  const bytes = Buffer.from(encoded, "base64");
  return bytes.toString("base64") === encoded ? sha256(bytes) : undefined;
}

export class ArtifactStore {
  readonly root: string;

  constructor(root = getArtifactRoot()) {
    this.root = path.resolve(root);
  }

  async createJob(template: { name: string; buffer: Buffer }, sources: InputSourceArtifact[] = []) {
    const jobId = "job-" + randomUUID();
    const now = new Date().toISOString();
    const templateInput: ArtifactInput = {
      name: template.name || "template.pptx",
      byteSize: template.buffer.byteLength,
      sha256: sha256(template.buffer),
      relativePath: ARTIFACT_RELATIVE_PATHS.template,
    };
    const manifest = artifactManifestSchema.parse({
      version: 2,
      jobId,
      status: "analyzing",
      createdAt: now,
      updatedAt: now,
      inputs: { template: templateInput, sources },
      artifacts: EMPTY_ARTIFACT_REFERENCES,
    });

    await mkdir(this.jobDirectory(jobId), { recursive: true });
    await writeAtomic(this.jobPath(jobId, ARTIFACT_RELATIVE_PATHS.template), template.buffer);
    await this.writeManifest(manifest);
    return { jobId, manifest };
  }

  async linkInputSourceArtifacts(jobId: string, normalizedContent: NormalizedContent) {
    const content = generationPlanningSchema.shape.normalizedContent.parse(normalizedContent);
    const manifest = await this.readManifest(jobId);
    const chunksBySource = new Map<string, string[]>();
    for (const chunk of content.sourceChunks) {
      const ids = chunksBySource.get(chunk.sourceId) ?? [];
      ids.push(chunk.chunkId);
      chunksBySource.set(chunk.sourceId, ids);
    }
    const factsBySource = new Map<string, string[]>();
    for (const fact of content.facts ?? []) {
      const ids = factsBySource.get(fact.sourceId) ?? [];
      ids.push(fact.factId);
      factsBySource.set(fact.sourceId, ids);
    }
    const sources = manifest.inputs.sources.map((source) => ({
      ...source,
      sourceChunkIds: [...new Set(chunksBySource.get(source.id) ?? [])].sort(),
      factIds: [...new Set(factsBySource.get(source.id) ?? [])].sort(),
    }));
    assertInputArtifactGraph(sources, content);
    return this.writeManifest({ ...manifest, updatedAt: new Date().toISOString(), inputs: { ...manifest.inputs, sources } });
  }

  async saveDesignSystem(jobId: string, designSystem: DesignSystem) {
    const parsedDesignSystem = designSystemSchema.parse(designSystem);
    const manifest = await this.readManifest(jobId);
    const templateBytes = await readFile(this.jobPath(jobId, manifest.inputs.template.relativePath));
    if (sha256(templateBytes) !== manifest.inputs.template.sha256 || templateBytes.byteLength !== manifest.inputs.template.byteSize) {
      throw new Error("Template input failed integrity validation");
    }
    const imageArtifacts = await this.persistTemplateImages(jobId, templateBytes, parsedDesignSystem);
    const contents = jsonBuffer(parsedDesignSystem);
    await writeAtomic(this.jobPath(jobId, ARTIFACT_RELATIVE_PATHS.parsedDesignSystem), contents);
    return this.writeManifest({
      ...manifest,
      updatedAt: new Date().toISOString(),
      artifacts: { ...manifest.artifacts, parsed: artifactReference(ARTIFACT_RELATIVE_PATHS.parsedDesignSystem, contents), templateImages: imageArtifacts },
    });
  }

  private async persistTemplateImages(jobId: string, templateBytes: Buffer, design: DesignSystem): Promise<TemplateImageArtifact[]> {
    const allowed = (design.imageAssets ?? []).filter((asset) => asset.allowed);
    if (!allowed.length) return [];
    const zip = await JSZip.loadAsync(templateBytes);
    const saved = new Set<string>();
    const artifacts: TemplateImageArtifact[] = [];
    for (const asset of allowed) {
      const mimeType = imageMimeFromTarget(asset.target);
      const entry = zip.file(asset.target);
      if (!mimeType || !entry || !/^ppt\/media\/[A-Za-z0-9_.-]+$/.test(asset.target)) {
        throw new Error("Template image relationship has an unsupported media target");
      }
      const bytes = await entry.async("nodebuffer");
      const digest = sha256(bytes);
      if (bytes.byteLength !== asset.byteSize || digest !== asset.sha256) {
        throw new Error("Template image bytes differ from parsed relationship evidence");
      }
      const relativePath = `parsed/template-images/${digest}.${mimeExtension(mimeType)}`;
      if (!saved.has(relativePath)) {
        const assetPath = this.jobPath(jobId, relativePath);
        try {
          const existing = await readFile(assetPath);
          if (sha256(existing) !== digest || existing.length !== bytes.length) {
            throw new Error("Immutable template image asset differs from source bytes");
          }
        } catch (error) {
          if (!isMissingFileError(error)) throw error;
          await writeAtomic(assetPath, bytes);
        }
        saved.add(relativePath);
      }
      const placements = design.layouts.flatMap((layout) => layout.elements
        .filter((element) => element.type === "image" && element.sourceFile === asset.sourceFile
          && element.relationshipId === asset.relationshipId)
        .map((element) => ({ layoutId: layout.id, sourceElementId: element.id,
          ...(element.crop ? { crop: element.crop } : {}),
          ...(element.rotation ? { rotation: element.rotation } : {}) })));
      artifacts.push({ ...artifactReference(relativePath, bytes), mimeType, target: asset.target,
        sourceFile: asset.sourceFile, relationshipId: asset.relationshipId, sources: asset.sources, placements });
    }
    return artifacts;
  }

  async savePlanning(jobId: string, normalizedContent: NormalizedContent, presentationPlan: PresentationPlan) {
    const planning = generationPlanningSchema.parse({ normalizedContent, presentationPlan });
    const manifest = await this.readManifest(jobId);
    assertInputArtifactGraph(manifest.inputs.sources, planning.normalizedContent, planning.presentationPlan);
    const contents = jsonBuffer(planning);
    await writeAtomic(this.jobPath(jobId, ARTIFACT_RELATIVE_PATHS.planning), contents);
    return this.writeManifest({
      ...manifest,
      updatedAt: new Date().toISOString(),
      artifacts: { ...manifest.artifacts, planning: artifactReference(ARTIFACT_RELATIVE_PATHS.planning, contents) },
      ...(presentationPlan.meta?.groundingSummary ? { groundingSummary: presentationPlan.meta.groundingSummary } : {}),
      ...(presentationPlan.meta?.skillVersions ? { skillVersions: presentationPlan.meta.skillVersions } : {}),
    });
  }

  async saveVariant(jobId: string, variant: LayoutVariant, presentation: PresentationDocument) {
    const parsedPresentation = presentationDocumentSchema.parse(presentation);
    const relativePath = variantRelativePath(variant);
    const contents = jsonBuffer(parsedPresentation);
    await writeAtomic(this.jobPath(jobId, relativePath), contents);
    const manifest = await this.readManifest(jobId);
    const variants = mergeVariantReference(manifest.artifacts.variants, variant, artifactReference(relativePath, contents));
    return this.writeManifest({
      ...manifest,
      updatedAt: new Date().toISOString(),
      artifacts: { ...manifest.artifacts, variants },
    });
  }

  async saveVariants(jobId: string, presentations: Record<LayoutVariant, PresentationDocument>) {
    const references = emptyVariantReferences();
    for (const variant of Object.keys(references) as LayoutVariant[]) {
      const parsedPresentation = presentationDocumentSchema.parse(presentations[variant]);
      const relativePath = variantRelativePath(variant);
      const contents = jsonBuffer(parsedPresentation);
      await writeAtomic(this.jobPath(jobId, relativePath), contents);
      references[variant] = artifactReference(relativePath, contents);
    }
    const manifest = await this.readManifest(jobId);
    return this.writeManifest({
      ...manifest,
      updatedAt: new Date().toISOString(),
      artifacts: { ...manifest.artifacts, variants: references },
    });
  }

  async saveExport(jobId: string, variant: LayoutVariant, format: ExportFormat, contents: Buffer | Uint8Array) {
    const bytes = Buffer.isBuffer(contents)
      ? contents
      : Buffer.from(contents.buffer, contents.byteOffset, contents.byteLength);
    if (bytes.byteLength <= 0) throw new Error("Export contents are empty");
    const manifest = await this.readManifest(jobId);
    if (manifest.status !== "ready") throw new ArtifactGenerationJobNotReadyError("Generation job is not ready");
    await this.validateTemplateImages(jobId, manifest);
    const relativePath = exportRelativePath(variant, format);
    await writeAtomic(this.jobPath(jobId, relativePath), bytes);
    const reference = artifactReference(relativePath, bytes);
    const exports = mergeExportReference(manifest.artifacts.exports, variant, format, reference);
    const nextManifest = await this.writeManifest({
      ...manifest,
      updatedAt: new Date().toISOString(),
      artifacts: { ...manifest.artifacts, exports },
    });
    return { manifest: nextManifest, reference };
  }

  async saveAuditReport(jobId: string, audit: AuditReport, variant?: LayoutVariant) {
    const parsedAudit = auditReportSchema.parse(audit);
    const relativePath = variant ? auditRelativePath(variant) : ARTIFACT_RELATIVE_PATHS.audit;
    const contents = jsonBuffer(parsedAudit);
    await writeAtomic(this.jobPath(jobId, relativePath), contents);
    const manifest = await this.readManifest(jobId);
    const auditReferences = variant
      ? mergeVariantReference(manifest.artifacts.audit, variant, artifactReference(relativePath, contents))
      : artifactReference(relativePath, contents);
    return this.writeManifest({
      ...manifest,
      updatedAt: new Date().toISOString(),
      artifacts: { ...manifest.artifacts, audit: auditReferences },
    });
  }

  async saveAudits(jobId: string, audits: Record<LayoutVariant, AuditReport>) {
    const references = emptyVariantReferences();
    await Promise.all((Object.keys(references) as LayoutVariant[]).map(async (variant) => {
      const parsedAudit = auditReportSchema.parse(audits[variant]);
      const relativePath = auditRelativePath(variant);
      const contents = jsonBuffer(parsedAudit);
      await writeAtomic(this.jobPath(jobId, relativePath), contents);
      references[variant] = artifactReference(relativePath, contents);
    }));
    const manifest = await this.readManifest(jobId);
    return this.writeManifest({
      ...manifest,
      updatedAt: new Date().toISOString(),
      artifacts: { ...manifest.artifacts, audit: references },
    });
  }

  async readGenerationArtifactsForJury(jobId: string): Promise<SavedGenerationArtifactsForJury> {
    const manifest = await this.readManifest(jobId);
    const planReference = manifest.artifacts.planning;
    const variantReferences = manifest.artifacts.variants;
    const auditReferences = manifest.artifacts.audit;
    if (!planReference || planReference.relativePath !== ARTIFACT_RELATIVE_PATHS.planning
      || !hasAllVariantReferences(variantReferences) || !hasAllVariantReferences(auditReferences)) {
      throw new ArtifactIncompleteGenerationJobError("Generation plan, variants and audits must be saved before jury evaluation");
    }
    const [planning, compact, balanced, visual, compactAudit, balancedAudit, visualAudit] = await Promise.all([
      this.readPublishedJsonArtifact(jobId, manifest, planReference, generationPlanningSchema),
      this.readPublishedJsonArtifact(jobId, manifest, variantReferences.compact, presentationDocumentSchema),
      this.readPublishedJsonArtifact(jobId, manifest, variantReferences.balanced, presentationDocumentSchema),
      this.readPublishedJsonArtifact(jobId, manifest, variantReferences.visual, presentationDocumentSchema),
      this.readPublishedJsonArtifact(jobId, manifest, auditReferences.compact, auditReportSchema),
      this.readPublishedJsonArtifact(jobId, manifest, auditReferences.balanced, auditReportSchema),
      this.readPublishedJsonArtifact(jobId, manifest, auditReferences.visual, auditReportSchema),
    ]);
    const variants = { compact, balanced, visual };
    const audits = { compact: compactAudit, balanced: balancedAudit, visual: visualAudit };
    for (const variant of ["compact", "balanced", "visual"] as const) {
      if (variants[variant].variant !== variant) {
        throw new ArtifactIncompleteGenerationJobError("Published variant identity does not match its artifact reference");
      }
      if (!audits[variant].passed) throw new Error("fatal_deterministic_audit");
    }
    return {
      plan: planning.presentationPlan,
      variants,
      audits,
      references: {
        plan: planReference,
        variants: variantReferences,
        audits: auditReferences,
      },
    };
  }

  async saveGenerationOrchestration(jobId: string, ranking: PublishedVariantRanking, stageTrace: unknown) {
    const parsedRanking = publishedVariantRankingSchema.parse(ranking);
    const parsedStageTrace = generationStageTraceSchema.parse(stageTrace);
    const saved = await this.readGenerationArtifactsForJury(jobId);
    assertJuryReferencesMatchSavedArtifacts(parsedRanking, saved.references);
    assertJuryStageTraceMatchesSavedArtifacts(parsedStageTrace, parsedRanking);
    const manifest = await this.readManifest(jobId);
    const rankingContents = jsonBuffer(parsedRanking);
    const stageTraceContents = jsonBuffer(parsedStageTrace);
    await Promise.all([
      writeAtomic(this.jobPath(jobId, ARTIFACT_RELATIVE_PATHS.juryRanking), rankingContents),
      writeAtomic(this.jobPath(jobId, ARTIFACT_RELATIVE_PATHS.stageTrace), stageTraceContents),
    ]);
    return this.writeManifest({
      ...manifest,
      updatedAt: new Date().toISOString(),
      artifacts: {
        ...manifest.artifacts,
        orchestration: {
          ranking: artifactReference(ARTIFACT_RELATIVE_PATHS.juryRanking, rankingContents),
          stageTrace: artifactReference(ARTIFACT_RELATIVE_PATHS.stageTrace, stageTraceContents),
        },
      },
    });
  }

  async saveRenderArtifacts(jobId: string, evidence: RenderEvidenceBundle) {
    const manifest = await this.readManifest(jobId);
    const pdfRelativePath = ARTIFACT_RELATIVE_PATHS.renderPdf;
    const pdfPath = this.jobPath(jobId, pdfRelativePath);
    if (!samePath(evidence.pdfPath, pdfPath)) {
      throw new Error("Render evidence PDF path does not match the job render directory");
    }
    if (evidence.slideCount !== evidence.slides.length) {
      throw new Error("Render evidence slide count does not match rendered slide metadata");
    }

    const pdfContents = await readFile(pdfPath);
    if (pdfContents.length <= 0) throw new Error("Rendered PDF is empty");
    if (evidence.pdfBytes !== pdfContents.byteLength || evidence.pdfSha256 !== sha256(pdfContents)) {
      throw new Error("Render evidence PDF metadata does not match the saved file");
    }

    const slideReferences = [];
    for (let slideNumber = 1; slideNumber <= evidence.slideCount; slideNumber += 1) {
      const supplied = evidence.slides.find((slide) => slide.slideNumber === slideNumber);
      if (!supplied) throw new Error(`Render evidence is missing slide ${slideNumber}`);
      const relativePath = renderSlideRelativePath(slideNumber);
      const outputPath = this.jobPath(jobId, relativePath);
      if (!samePath(supplied.outputPath, outputPath)) {
        throw new Error(`Render evidence slide ${slideNumber} path does not match the job render directory`);
      }
      const contents = await readFile(outputPath);
      if (contents.length <= 0) throw new Error(`Rendered slide ${slideNumber} is empty`);
      if (supplied.outputBytes !== contents.byteLength || supplied.outputSha256 !== sha256(contents)) {
        throw new Error(`Render evidence metadata does not match saved slide ${slideNumber}`);
      }
      slideReferences.push({
        ...artifactReference(relativePath, contents),
        slideNumber,
      });
    }

    const renderEvidence = renderEvidenceSchema.parse({
      version: 1,
      renderer: evidence.renderer,
      rendererPath: evidence.rendererPath,
      rendererVersion: evidence.rendererVersion,
      rasterizer: evidence.rasterizer,
      rasterizerPath: evidence.rasterizerPath,
      pageCounter: evidence.pageCounter,
      pageCounterPath: evidence.pageCounterPath,
      inputPath: manifest.inputs.template.relativePath,
      pdf: artifactReference(pdfRelativePath, pdfContents),
      outputFormat: evidence.outputFormat,
      slideCount: evidence.slideCount,
      width: evidence.width,
      height: evidence.height,
      slides: slideReferences,
    });
    const evidenceContents = jsonBuffer(renderEvidence);
    await writeAtomic(this.jobPath(jobId, ARTIFACT_RELATIVE_PATHS.parsedRenderEvidence), evidenceContents);
    const nextManifest = await this.writeManifest({
      ...manifest,
      updatedAt: new Date().toISOString(),
      artifacts: {
        ...manifest.artifacts,
        renderEvidence: artifactReference(ARTIFACT_RELATIVE_PATHS.parsedRenderEvidence, evidenceContents),
        renders: {
          pdf: artifactReference(pdfRelativePath, pdfContents),
          slides: slideReferences,
        },
      },
    });
    return { manifest: nextManifest, renderEvidence };
  }

  async cleanupRenderArtifacts(jobId: string) {
    const manifest = await this.readManifest(jobId);
    await rm(this.jobPath(jobId, ARTIFACT_RELATIVE_PATHS.renderDirectory), { recursive: true, force: true });
    await rm(this.jobPath(jobId, ARTIFACT_RELATIVE_PATHS.parsedRenderEvidence), { force: true });
    return this.writeManifest({
      ...manifest,
      updatedAt: new Date().toISOString(),
      artifacts: {
        ...manifest.artifacts,
        renderEvidence: null,
        renders: null,
      },
    });
  }

  async markReady(jobId: string) {
    const manifest = await this.readManifest(jobId);
    if (!manifest.artifacts.parsed) {
      throw new Error("Parsed design system was not saved");
    }
    if (!manifest.artifacts.renderEvidence || !manifest.artifacts.renders) {
      throw new Error("Render evidence was not saved");
    }
    await this.validateTemplateImages(jobId, manifest);
    return this.writeManifest({
      ...manifest,
      status: "ready",
      updatedAt: new Date().toISOString(),
    });
  }

  async markGenerationReady(jobId: string) {
    const manifest = await this.readManifest(jobId);
    if (!manifest.artifacts.parsed) {
      throw new Error("Parsed design system was not saved");
    }
    if (!manifest.artifacts.planning || !hasAllVariantReferences(manifest.artifacts.variants) || !hasAllVariantReferences(manifest.artifacts.audit) || !manifest.artifacts.orchestration) {
      throw new Error("Generation artifacts were not saved");
    }
    const saved = await this.readGenerationArtifactsForJury(jobId);
    await this.validateTemplateImages(jobId, manifest, Object.values(saved.variants));
    const [ranking, stageTrace] = await Promise.all([
      this.readPublishedJsonArtifact(jobId, manifest, manifest.artifacts.orchestration.ranking, publishedVariantRankingSchema),
      this.readPublishedJsonArtifact(jobId, manifest, manifest.artifacts.orchestration.stageTrace, generationStageTraceSchema),
    ]);
    assertJuryReferencesMatchSavedArtifacts(ranking, saved.references);
    assertJuryStageTraceMatchesSavedArtifacts(stageTrace, ranking);
    return this.writeManifest({
      ...manifest,
      status: "ready",
      updatedAt: new Date().toISOString(),
    });
  }

  async markFailed(jobId: string, error: unknown) {
    const manifest = await this.readManifest(jobId);
    const failedManifest: ArtifactManifest = {
      ...manifest,
      status: "failed",
      updatedAt: new Date().toISOString(),
      error: safeErrorText(error),
    };
    return this.writeManifest(failedManifest);
  }

  async markGenerationFailed(jobId: string, error: unknown) {
    const manifest = await this.readManifest(jobId);
    await Promise.all([
      rm(this.jobPath(jobId, ARTIFACT_RELATIVE_PATHS.planning), { force: true }),
      rm(this.jobPath(jobId, ARTIFACT_RELATIVE_PATHS.variantsDirectory), { recursive: true, force: true }),
      rm(this.jobPath(jobId, ARTIFACT_RELATIVE_PATHS.auditsDirectory), { recursive: true, force: true }),
      rm(this.jobPath(jobId, ARTIFACT_RELATIVE_PATHS.orchestrationDirectory), { recursive: true, force: true }),
    ]);
    return this.writeManifest({
      ...manifest,
      status: "failed",
      updatedAt: new Date().toISOString(),
      artifacts: {
        ...manifest.artifacts,
        planning: null,
        variants: null,
        audit: null,
        orchestration: null,
      },
      error: safeErrorText(error),
    });
  }

  async readManifest(jobId: string) {
    try {
      const contents = await readFile(this.jobPath(jobId, ARTIFACT_RELATIVE_PATHS.manifest), "utf8");
      return artifactManifestSchema.parse(JSON.parse(contents));
    } catch (error) {
      if (isMissingFileError(error)) throw new ArtifactJobNotFoundError("Artifact job was not found");
      throw error;
    }
  }

  async readPublishedArtifact(jobId: string, relativePath: string) {
    const manifest = await this.readManifest(jobId);
    return this.readPublishedArtifactFromManifest(jobId, manifest, relativePath);
  }

  async readPublishedVariantPresentation(jobId: string, variant: LayoutVariant) {
    const manifest = await this.readManifest(jobId);
    const reference = variantReferenceFor(manifest.artifacts.variants, variant);
    if (!reference) throw new ArtifactNotFoundError("Variant artifact is not published in the job manifest");
    const artifact = await this.readPublishedArtifactFromManifest(jobId, manifest, reference.relativePath);
    try {
      const document = presentationDocumentSchema.parse(JSON.parse(artifact.contents.toString("utf8")));
      await this.validateTemplateImages(jobId, manifest, [document]);
      return {
        manifest,
        document,
      };
    } catch {
      throw new ArtifactNotFoundError("Variant artifact is not a valid presentation document");
    }
  }

  async readPublishedGenerationJob(jobId: string) {
    const manifest = await this.readManifest(jobId);
    if (manifest.status !== "ready") {
      throw new ArtifactGenerationJobNotReadyError("Generation job is not ready");
    }
    if (!isPublishedGenerationManifest(manifest)) {
      throw new ArtifactIncompleteGenerationJobError("Generation job does not have a complete published artifact set");
    }

    try {
      const orchestration = manifest.artifacts.orchestration;
      if (!orchestration) throw new ArtifactIncompleteGenerationJobError("Generation job does not have persisted jury artifacts");
      const [designSystem, planning, compact, balanced, visual, compactAudit, balancedAudit, visualAudit, ranking, stageTrace] = await Promise.all([
        this.readPublishedJsonArtifact(jobId, manifest, manifest.artifacts.parsed, designSystemSchema),
        this.readPublishedJsonArtifact(jobId, manifest, manifest.artifacts.planning, generationPlanningSchema),
        this.readPublishedJsonArtifact(jobId, manifest, manifest.artifacts.variants.compact, presentationDocumentSchema),
        this.readPublishedJsonArtifact(jobId, manifest, manifest.artifacts.variants.balanced, presentationDocumentSchema),
        this.readPublishedJsonArtifact(jobId, manifest, manifest.artifacts.variants.visual, presentationDocumentSchema),
        this.readPublishedJsonArtifact(jobId, manifest, manifest.artifacts.audit.compact, auditReportSchema),
        this.readPublishedJsonArtifact(jobId, manifest, manifest.artifacts.audit.balanced, auditReportSchema),
        this.readPublishedJsonArtifact(jobId, manifest, manifest.artifacts.audit.visual, auditReportSchema),
        this.readPublishedJsonArtifact(jobId, manifest, orchestration.ranking, publishedVariantRankingSchema),
        this.readPublishedJsonArtifact(jobId, manifest, orchestration.stageTrace, generationStageTraceSchema),
      ]);
      const presentations = { compact, balanced, visual };
      await this.validateTemplateImages(jobId, manifest, Object.values(presentations));
      const audits = { compact: compactAudit, balanced: balancedAudit, visual: visualAudit };
      if (Object.values(audits).some((audit) => !audit.passed)) {
        throw new ArtifactIncompleteGenerationJobError("Ready job contains a failed deterministic audit");
      }
      const references = {
        plan: manifest.artifacts.planning,
        variants: manifest.artifacts.variants,
        audits: manifest.artifacts.audit,
      };
      assertJuryReferencesMatchSavedArtifacts(ranking, references);
      assertJuryStageTraceMatchesSavedArtifacts(stageTrace, ranking);
      const canonicalSlideIds = planning.presentationPlan.slides.map((slide) => slide.id);
      for (const variant of ["compact", "balanced", "visual"] as const) {
        const variantSlideIds = presentations[variant].slides.map((slide) => slide.id);
        const auditSlideIds = audits[variant].slides.map((slide) => slide.slideId);
        if (!sameItemsInOrder(canonicalSlideIds, variantSlideIds) || !sameItemsInOrder(canonicalSlideIds, auditSlideIds)) {
          throw new ArtifactIncompleteGenerationJobError("Ready job variant and audit slides do not match the canonical plan");
        }
      }
      return {
        manifest,
        designSystem,
        presentations,
        audits,
        ranking,
        stageTrace,
      };
    } catch {
      // A ready manifest is not enough: every reopen payload must still match the
      // exact published bytes and its schema before anything is returned.
      throw new ArtifactIncompleteGenerationJobError("Generation job contains invalid published artifacts");
    }
  }

  private async readPublishedArtifactFromManifest(jobId: string, manifest: ArtifactManifest, relativePath: string) {
    const requestedPath = normalizeArtifactPath(relativePath);
    if (!publishedArtifactPaths(manifest).has(requestedPath)) {
      throw new ArtifactNotFoundError("Artifact is not published in the job manifest");
    }

    const jobRoot = await realpath(this.jobDirectory(jobId));
    const filePath = this.jobPath(jobId, requestedPath);
    const resolvedFile = await realpath(filePath);
    const relative = path.relative(jobRoot, resolvedFile);
    if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
      throw new Error("Artifact path escapes the job directory");
    }
    const contents = await readFile(resolvedFile);
    const reference = publishedArtifactReferences(manifest).get(requestedPath);
    if (reference && (reference.byteSize !== contents.byteLength || reference.sha256 !== sha256(contents))) {
      throw new ArtifactNotFoundError("Artifact contents do not match the published manifest reference");
    }
    return { relativePath: requestedPath, contents };
  }

  private async validateTemplateImages(jobId: string, manifest: ArtifactManifest, documents: PresentationDocument[] = []) {
    if (!manifest.artifacts.parsed) throw new Error("Template design artifact is missing");
    const design = await this.readPublishedJsonArtifact(jobId, manifest, manifest.artifacts.parsed, designSystemSchema);
    const expected = (design.imageAssets ?? []).filter((asset) => asset.allowed);
    const artifacts = manifest.artifacts.templateImages;
    // Version 1 jobs were published before per-image artifacts existed. Their
    // parsed design and published variants still carry the original media.
    if (manifest.version === 1 && artifacts.length === 0) return;
    if (artifacts.length !== expected.length) throw new Error("Template image artifact graph is incomplete");
    const byRelationship = new Map<string, TemplateImageArtifact>();
    for (const artifact of artifacts) {
      const key = `${artifact.sourceFile}|${artifact.relationshipId}|${artifact.target}`;
      if (byRelationship.has(key)) throw new Error("Template image relationship is duplicated");
      const evidence = expected.find((asset) => `${asset.sourceFile}|${asset.relationshipId}|${asset.target}` === key);
      if (!evidence || evidence.sha256 !== artifact.sha256 || evidence.byteSize !== artifact.byteSize
        || artifact.mimeType !== imageMimeFromTarget(artifact.target)
        || artifact.relativePath !== `parsed/template-images/${artifact.sha256}.${mimeExtension(artifact.mimeType)}`) {
        throw new Error("Template image artifact graph differs from parser evidence");
      }
      const expectedPlacements = design.layouts.flatMap((layout) => layout.elements
        .filter((element) => element.type === "image" && element.sourceFile === artifact.sourceFile
          && element.relationshipId === artifact.relationshipId)
        .map((element) => ({ layoutId: layout.id, sourceElementId: element.id,
          ...(element.crop ? { crop: element.crop } : {}),
          ...(element.rotation ? { rotation: element.rotation } : {}) })));
      if (JSON.stringify(artifact.placements) !== JSON.stringify(expectedPlacements)) {
        throw new Error("Template image placement graph differs from parsed design");
      }
      const bytes = (await this.readPublishedArtifactFromManifest(jobId, manifest, artifact.relativePath)).contents;
      if (bytes.length !== artifact.byteSize || sha256(bytes) !== artifact.sha256) {
        throw new Error("Template image asset failed integrity validation");
      }
      byRelationship.set(key, artifact);
    }
    const placements = new Map<string, { sha256: string; crop: unknown; rotation: unknown }[]>();
    for (const layout of design.layouts) for (const element of layout.elements) {
      if (element.type !== "image" || !element.imageDataUrl) continue;
      if (!element.relationshipId || !element.sourceFile) throw new Error("Template image placement has no relationship provenance");
      const artifact = artifacts.find((item) => item.sourceFile === element.sourceFile && item.relationshipId === element.relationshipId);
      if (!artifact || dataUrlDigest(element.imageDataUrl, artifact.mimeType) !== artifact.sha256) {
        throw new Error("Template image placement differs from its saved asset");
      }
      const key = JSON.stringify([layout.id, element.id]);
      placements.set(key, [...(placements.get(key) ?? []), {
        sha256: artifact.sha256, crop: element.crop, rotation: element.rotation,
      }]);
    }
    for (const document of documents) for (const slide of document.slides) for (const element of slide.canvas.elements) {
      if (element.type !== "image" || !element.sourceTemplateElementId) continue;
      const candidates = placements.get(JSON.stringify([slide.templateLayoutId, element.sourceTemplateElementId])) ?? [];
      if (!element.dataUrl || !candidates.some((placement) => artifacts.some((asset) => asset.sha256 === placement.sha256
        && dataUrlDigest(element.dataUrl!, asset.mimeType) === asset.sha256)
        && JSON.stringify(element.crop) === JSON.stringify(placement.crop)
        && element.rotation === placement.rotation)) {
        throw new Error("Published image placement differs from template asset, crop or rotation");
      }
    }
  }

  private async readPublishedJsonArtifact<T>(
    jobId: string,
    manifest: ArtifactManifest,
    reference: ArtifactReference,
    schema: { parse(value: unknown): T },
  ) {
    const artifact = await this.readPublishedArtifactFromManifest(jobId, manifest, reference.relativePath);
    return schema.parse(JSON.parse(artifact.contents.toString("utf8")));
  }

  jobDirectory(jobId: string) {
    return this.safePath(jobId, ".");
  }

  jobPath(jobId: string, relativePath: string) {
    return this.safePath(jobId, relativePath);
  }

  private async writeManifest(manifest: ArtifactManifest) {
    const validated = artifactManifestSchema.parse(manifest);
    await writeJsonAtomic(this.jobPath(validated.jobId, ARTIFACT_RELATIVE_PATHS.manifest), validated);
    return validated;
  }

  private safePath(jobId: string, relativePath: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(jobId)) {
      throw new Error("Invalid artifact job id");
    }
    if (!relativePath || path.isAbsolute(relativePath)) {
      throw new Error("Invalid artifact path");
    }
    if (relativePath !== ".") {
      if (/(^|[\\/])\.\.(?:[\\/]|$)/.test(relativePath)) {
        throw new Error("Artifact path escapes the job directory");
      }
      normalizeArtifactPath(relativePath);
    }
    const jobRoot = path.resolve(this.root, jobId);
    const resolved = path.resolve(jobRoot, relativePath);
    const relative = path.relative(jobRoot, resolved);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
      throw new Error("Artifact path escapes the job directory");
    }
    return resolved;
  }
}

function assertInputArtifactGraph(
  sources: InputSourceArtifact[],
  content: NormalizedContent,
  plan?: PresentationPlan,
) {
  const sourceIds = new Set(sources.map((source) => source.id));
  const chunkIds = new Set(sources.flatMap((source) => source.sourceChunkIds));
  const factIds = new Set(sources.flatMap((source) => source.factIds));
  for (const chunk of content.sourceChunks) {
    if (!sourceIds.has(chunk.sourceId) || !chunkIds.has(chunk.chunkId)) {
      throw new Error(`input_artifact_graph_missing_source_chunk:${chunk.chunkId}`);
    }
  }
  for (const fact of content.facts ?? []) {
    if (!sourceIds.has(fact.sourceId) || !chunkIds.has(fact.chunkId) || !factIds.has(fact.factId)) {
      throw new Error(`input_artifact_graph_missing_fact:${fact.factId}`);
    }
  }
  if (!plan) return;
  for (const claim of plan.slides.flatMap((slide) => slide.claims ?? [])) {
    if (claim.grounding !== "grounded") continue;
    if (claim.sourceRefs.sourceChunkIds.some((id) => !chunkIds.has(id)) || claim.sourceRefs.factIds.some((id) => !factIds.has(id))) {
      throw new Error(`grounding_input_artifact_graph_dangling_ref:${claim.id}`);
    }
  }
}

export class ArtifactNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactNotFoundError";
  }
}

export class ArtifactJobNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactJobNotFoundError";
  }
}

export class ArtifactGenerationJobNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactGenerationJobNotReadyError";
  }
}

export class ArtifactIncompleteGenerationJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactIncompleteGenerationJobError";
  }
}

export function createArtifactStore(root?: string) {
  return new ArtifactStore(root);
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  await writeAtomic(filePath, jsonBuffer(value));
}

function jsonBuffer(value: unknown) {
  return Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");
}

function artifactReference(relativePath: string, contents: Buffer): ArtifactReference {
  return { relativePath, byteSize: contents.byteLength, sha256: sha256(contents) };
}

function assertJuryReferencesMatchSavedArtifacts(
  ranking: PublishedVariantRanking,
  references: SavedGenerationArtifactsForJury["references"],
) {
  const matches = (
    received: { artifactId: string; kind: string; relativePath: string; byteSize: number; sha256: string },
    expected: ArtifactReference,
    artifactId: string,
    kind: string,
  ) => received.artifactId === artifactId
    && received.kind === kind
    && received.relativePath === expected.relativePath
    && received.byteSize === expected.byteSize
    && received.sha256 === expected.sha256;
  if (!matches(ranking.sourceArtifactRefs.canonicalPlan, references.plan, "artifact-planning-canonical", "plan")) {
    throw new Error("Jury ranking is not bound to the saved canonical plan");
  }
  for (const variant of ["compact", "balanced", "visual"] as const) {
    const variantRef = ranking.sourceArtifactRefs.variants.find((entry) => entry.variant === variant)?.artifact;
    const auditRef = ranking.sourceArtifactRefs.audits.find((entry) => entry.variant === variant)?.artifact;
    if (!variantRef || !matches(variantRef, references.variants[variant], `artifact-variants-${variant}`, "variant")) {
      throw new Error("Jury ranking is not bound to the saved variant set");
    }
    if (!auditRef || !matches(auditRef, references.audits[variant], `artifact-audits-${variant}`, "audit")) {
      throw new Error("Jury ranking is not bound to the saved audit set");
    }
  }
}

function assertJuryStageTraceMatchesSavedArtifacts(
  stageTrace: ReturnType<typeof generationStageTraceSchema.parse>,
  ranking: PublishedVariantRanking,
) {
  const juryStages = stageTrace.filter((stage) => stage.stage === "final-jury");
  const juryStage = juryStages[0];
  const expectedInputs = [
    ranking.sourceArtifactRefs.canonicalPlan.artifactId,
    ...ranking.sourceArtifactRefs.variants.map((entry) => entry.artifact.artifactId),
    ...ranking.sourceArtifactRefs.audits.map((entry) => entry.artifact.artifactId),
  ];
  if (juryStages.length !== 1 || !juryStage || juryStage.status !== "completed"
    || !juryStage.agentIds.includes("final-jury")
    || expectedInputs.some((artifactId) => !juryStage.inputArtifactIds.includes(artifactId))
    || !juryStage.outputArtifactIds.includes("artifact-jury-ranking")) {
    throw new Error("Persisted final-jury trace does not identify the saved ranking inputs");
  }
}

function sameItemsInOrder(left: string[], right: string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function samePath(left: string, right: string) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function normalizeArtifactPath(relativePath: string) {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error("Invalid artifact path");
  const segments = relativePath.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Invalid artifact path");
  }
  return segments.join("/");
}

function publishedArtifactPaths(manifest: ArtifactManifest) {
  const paths = new Set<string>([ARTIFACT_RELATIVE_PATHS.manifest, manifest.inputs.template.relativePath]);
  const addReference = (reference: ArtifactReference | null) => {
    if (reference) paths.add(reference.relativePath);
  };
  addReference(manifest.artifacts.parsed);
  manifest.artifacts.templateImages.forEach(addReference);
  addReference(manifest.artifacts.renderEvidence);
  addReference(manifest.artifacts.renders?.pdf || null);
  manifest.artifacts.renders?.slides.forEach((slide) => paths.add(slide.relativePath));
  addReference(manifest.artifacts.planning);
  addVariantReferences(manifest.artifacts.variants, addReference);
  addVariantReferences(manifest.artifacts.audit, addReference);
  addReference(manifest.artifacts.orchestration?.ranking || null);
  addReference(manifest.artifacts.orchestration?.stageTrace || null);
  addExportReferences(manifest.artifacts.exports, addReference, (relativePath) => paths.add(relativePath));
  return paths;
}

function publishedArtifactReferences(manifest: ArtifactManifest) {
  const references = new Map<string, ArtifactReference>();
  const addReference = (reference: ArtifactReference | null) => {
    if (reference) references.set(reference.relativePath, reference);
  };
  addReference(manifest.inputs.template);
  addReference(manifest.artifacts.parsed);
  manifest.artifacts.templateImages.forEach(addReference);
  addReference(manifest.artifacts.renderEvidence);
  addReference(manifest.artifacts.renders?.pdf || null);
  manifest.artifacts.renders?.slides.forEach(addReference);
  addReference(manifest.artifacts.planning);
  addVariantReferences(manifest.artifacts.variants, addReference);
  addVariantReferences(manifest.artifacts.audit, addReference);
  addReference(manifest.artifacts.orchestration?.ranking || null);
  addReference(manifest.artifacts.orchestration?.stageTrace || null);
  addExportReferences(manifest.artifacts.exports, addReference, () => undefined);
  return references;
}

function isGenerationArtifactPath(relativePath: string) {
  return relativePath === ARTIFACT_RELATIVE_PATHS.planning
    || relativePath === ARTIFACT_RELATIVE_PATHS.audit
    || relativePath.startsWith(ARTIFACT_RELATIVE_PATHS.variantsDirectory + "/")
    || relativePath.startsWith(ARTIFACT_RELATIVE_PATHS.auditsDirectory + "/");
}

function emptyVariantReferences(): {
  compact: ArtifactReference | null;
  balanced: ArtifactReference | null;
  visual: ArtifactReference | null;
} {
  return { compact: null, balanced: null, visual: null };
}

function mergeVariantReference(
  current: ArtifactReferences["variants"],
  variant: LayoutVariant,
  reference: ArtifactReference,
) {
  const references = isVariantReferenceMap(current)
    ? { ...current }
    : emptyVariantReferences();
  references[variant] = reference;
  return references;
}

function isVariantReferenceMap(value: ArtifactReferences["variants"]): value is Exclude<ArtifactReferences["variants"], ArtifactReference | null> {
  return Boolean(value && "compact" in value && "balanced" in value && "visual" in value);
}

type CompleteVariantReferences = Record<LayoutVariant, ArtifactReference>;

function hasAllVariantReferences(value: ArtifactReferences["variants"]): value is CompleteVariantReferences {
  return isVariantReferenceMap(value)
    && Boolean(value.compact && value.balanced && value.visual);
}

function isPublishedGenerationManifest(manifest: ArtifactManifest): manifest is ArtifactManifest & {
  artifacts: ArtifactManifest["artifacts"] & {
    parsed: ArtifactReference;
    planning: ArtifactReference;
    variants: { compact: ArtifactReference; balanced: ArtifactReference; visual: ArtifactReference };
    audit: { compact: ArtifactReference; balanced: ArtifactReference; visual: ArtifactReference };
    orchestration: NonNullable<ArtifactManifest["artifacts"]["orchestration"]>;
  };
} {
  const { parsed, planning, variants, audit, orchestration } = manifest.artifacts;
  if (!parsed || parsed.relativePath !== ARTIFACT_RELATIVE_PATHS.parsedDesignSystem) return false;
  if (!planning || planning.relativePath !== ARTIFACT_RELATIVE_PATHS.planning) return false;
  if (!hasAllVariantReferences(variants) || !hasAllVariantReferences(audit) || !orchestration) return false;
  if (orchestration.ranking.relativePath !== ARTIFACT_RELATIVE_PATHS.juryRanking
    || orchestration.stageTrace.relativePath !== ARTIFACT_RELATIVE_PATHS.stageTrace) return false;
  return (Object.keys(variants) as LayoutVariant[]).every((variant) => variants[variant]?.relativePath === variantRelativePath(variant))
    && (Object.keys(audit) as LayoutVariant[]).every((variant) => audit[variant]?.relativePath === auditRelativePath(variant));
}

function addVariantReferences(
  value: ArtifactReferences["variants"],
  addReference: (reference: ArtifactReference | null) => void,
) {
  if (isVariantReferenceMap(value)) {
    addReference(value.compact);
    addReference(value.balanced);
    addReference(value.visual);
    return;
  }
  addReference(value);
}

function emptyExportReferences() {
  return {
    compact: { pptx: null, pdf: null, html: null },
    balanced: { pptx: null, pdf: null, html: null },
    visual: { pptx: null, pdf: null, html: null },
  };
}

function mergeExportReference(
  current: ArtifactReferences["exports"],
  variant: LayoutVariant,
  format: ExportFormat,
  reference: ArtifactReference,
) {
  const exports = isExportReferenceMap(current)
    ? {
      compact: { ...current.compact },
      balanced: { ...current.balanced },
      visual: { ...current.visual },
    }
    : emptyExportReferences();
  exports[variant][format] = reference;
  return exports;
}

function isExportReferenceMap(value: ArtifactReferences["exports"]): value is Exclude<ArtifactReferences["exports"], string | null> {
  return Boolean(value && typeof value === "object" && "compact" in value && "balanced" in value && "visual" in value);
}

function addExportReferences(
  value: ArtifactReferences["exports"],
  addReference: (reference: ArtifactReference | null) => void,
  addLegacyPath: (relativePath: string) => void,
) {
  if (typeof value === "string") {
    addLegacyPath(value);
    return;
  }
  if (!isExportReferenceMap(value)) return;
  (Object.keys(value) as LayoutVariant[]).forEach((variant) => {
    addReference(value[variant].pptx);
    addReference(value[variant].pdf);
    addReference(value[variant].html);
  });
}

function variantReferenceFor(value: ArtifactReferences["variants"], variant: LayoutVariant) {
  return isVariantReferenceMap(value) ? value[variant] : null;
}

async function writeAtomic(filePath: string, contents: Buffer) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = filePath + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporaryPath, contents, { flag: "wx" });
    await rename(temporaryPath, filePath);
  } finally {
    await Promise.all([
      unlink(temporaryPath).catch(() => undefined),
      rm(temporaryPath, { force: true }).catch(() => undefined),
    ]);
  }
}

function isMissingFileError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function safeErrorText(error: unknown) {
  const raw = error instanceof Error ? error.message : "Template analysis failed";
  const compact = raw.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return (compact || "Template analysis failed").slice(0, 240);
}
