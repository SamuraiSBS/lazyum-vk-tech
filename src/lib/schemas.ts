import { z } from "zod";
import { agentIdSchema, MAX_AGENT_RENDER_ARTIFACT_BYTES } from "./agent-contracts";

const colorSchema = z.string().regex(/^#[0-9A-F]{6}$/i, "Expected an RGB hex color");

export const evidenceSourceSchema = z.object({
  sourceFile: z.string().min(1),
  xmlPath: z.string().min(1).optional(),
  elementId: z.string().min(1).optional(),
  relationshipId: z.string().min(1).optional(),
}).refine(
  (source) => Boolean(source.xmlPath || source.elementId),
  "Evidence source must identify an XML attribute/element or element id",
);
export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;

const evidenceFields = {
  confidence: z.number().min(0).max(1),
  sources: z.array(evidenceSourceSchema).min(1),
};

export const colorEvidenceSchema = z.object({ value: colorSchema, ...evidenceFields });
export type ColorEvidence = z.infer<typeof colorEvidenceSchema>;

export const stringEvidenceSchema = z.object({ value: z.string().min(1), ...evidenceFields });
export type StringEvidence = z.infer<typeof stringEvidenceSchema>;

export const numberEvidenceSchema = z.object({ value: z.number().finite(), ...evidenceFields });
export type NumberEvidence = z.infer<typeof numberEvidenceSchema>;

export const relationshipEvidenceSchema = z.object({
  kind: z.enum(["slide-layout", "layout-master"]),
  sourceFile: z.string().min(1),
  relationshipFile: z.string().min(1),
  relationshipId: z.string().min(1),
  relationshipType: z.string().min(1),
  targetFile: z.string().min(1),
});
export type RelationshipEvidence = z.infer<typeof relationshipEvidenceSchema>;

export const imageAssetEvidenceSchema = z.object({
  relationshipId: z.string().min(1),
  sourceFile: z.string().min(1),
  target: z.string().min(1),
  allowed: z.boolean(),
  byteSize: z.number().int().nonnegative().optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i, "Expected a SHA-256 hex digest").optional(),
  sources: z.array(evidenceSourceSchema).min(1),
}).refine(
  (asset) => !asset.allowed || (asset.byteSize !== undefined && asset.sha256 !== undefined),
  "Allowed image assets must include byteSize and sha256",
);
export type ImageAssetEvidence = z.infer<typeof imageAssetEvidenceSchema>;

export const designSystemEvidenceSchema = z.object({
  colors: z.array(colorEvidenceSchema).max(24),
  typography: z.object({
    headingFonts: z.array(stringEvidenceSchema).max(12),
    bodyFonts: z.array(stringEvidenceSchema).max(12),
    fontSizes: z.array(numberEvidenceSchema).max(30),
    fontWeights: z.array(numberEvidenceSchema).max(12),
  }),
  spacing: z.object({
    horizontalMargins: z.array(numberEvidenceSchema).max(30),
    verticalMargins: z.array(numberEvidenceSchema).max(30),
    gaps: z.array(numberEvidenceSchema).max(30),
  }),
  shapes: z.object({
    types: z.array(stringEvidenceSchema).max(20),
    radii: z.array(numberEvidenceSchema).max(20),
    strokes: z.array(colorEvidenceSchema).max(24),
  }),
  backgrounds: z.array(colorEvidenceSchema).max(80),
});
export type DesignSystemEvidence = z.infer<typeof designSystemEvidenceSchema>;

export const templateElementTypeSchema = z.enum([
  "text",
  "shape",
  "image",
  "line",
  "table",
  "chart",
  "placeholder",
  "group",
  "unknown",
]);

// OOXML a:srcRect percentages are placement-specific and may be negative.
export const canvasImageCropSchema = z.object({
  left: z.number().finite().min(-100).max(100),
  top: z.number().finite().min(-100).max(100),
  right: z.number().finite().min(-100).max(100),
  bottom: z.number().finite().min(-100).max(100),
}).strict().refine((crop) => crop.left + crop.right < 100 && crop.top + crop.bottom < 100, {
  message: "Opposing image crop percentages must leave a visible region",
});

export const templateElementSchema = z.object({
  id: z.string().min(1),
  type: templateElementTypeSchema,
  name: z.string().default(""),
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  w: z.number().positive(),
  h: z.number().positive(),
  text: z.string().default(""),
  fontFamily: z.string().optional(),
  fontSize: z.number().positive().optional(),
  fontWeight: z.number().int().positive().optional(),
  fill: colorSchema.optional(),
  stroke: colorSchema.optional(),
  radius: z.number().nonnegative().optional(),
  placeholderType: z.string().optional(),
  relationshipId: z.string().optional(),
  imageDataUrl: z.string().optional(),
  crop: canvasImageCropSchema.optional(),
  inheritedFrom: z.string().optional(),
  sourceFile: z.string().min(1).optional(),
  zIndex: z.number().int().nonnegative(),
});
export type TemplateElement = z.infer<typeof templateElementSchema>;

export const templateLayoutSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  source: z.enum(["layout", "slide"]),
  sourceFile: z.string().min(1),
  layoutSourceFile: z.string().optional(),
  masterSourceFile: z.string().optional(),
  width: z.number().positive(),
  height: z.number().positive(),
  background: colorSchema.optional(),
  elements: z.array(templateElementSchema).max(300),
  textSlots: z.number().int().nonnegative(),
  placeholderCount: z.number().int().nonnegative(),
  visualSlots: z.number().int().nonnegative(),
  cardCount: z.number().int().nonnegative(),
  composition: z.enum(["title", "split", "cards", "timeline", "visual", "text", "blank"]),
  recurringElementIds: z.array(z.string()),
});
export type TemplateLayout = z.infer<typeof templateLayoutSchema>;

export const designSystemSchema = z.object({
  version: z.literal(1),
  sourceName: z.string().min(1),
  slideSize: z.object({
    width: z.number().positive(),
    height: z.number().positive(),
    aspectRatio: z.number().positive(),
  }),
  colors: z.array(colorSchema).min(1).max(24),
  typography: z.object({
    headingFonts: z.array(z.string()).max(12),
    bodyFonts: z.array(z.string()).max(12),
    fontSizes: z.array(z.number().positive()).max(30),
    fontWeights: z.array(z.number().int().positive()).max(12),
  }),
  spacing: z.object({
    horizontalMargins: z.array(z.number().nonnegative()).max(30),
    verticalMargins: z.array(z.number().nonnegative()).max(30),
    gaps: z.array(z.number().nonnegative()).max(30),
  }),
  shapes: z.object({
    types: z.array(z.string()).max(20),
    radii: z.array(z.number().nonnegative()).max(20),
    strokes: z.array(colorSchema).max(24),
  }),
  masters: z.array(z.object({
    sourceFile: z.string().min(1),
    name: z.string().min(1),
    elementCount: z.number().int().nonnegative(),
  })).max(20),
  layouts: z.array(templateLayoutSchema).min(1).max(80),
  recurringElements: z.array(z.object({
    signature: z.string(),
    count: z.number().int().positive(),
    description: z.string(),
  })).max(30),
  visualPatterns: z.array(z.string()).max(30),
  evidence: designSystemEvidenceSchema.optional(),
  relationships: z.array(relationshipEvidenceSchema).max(200).optional(),
  imageAssets: z.array(imageAssetEvidenceSchema).max(5000).optional(),
  warnings: z.array(z.string()).max(200),
});
export type DesignSystem = z.infer<typeof designSystemSchema>;

export const artifactJobStatusSchema = z.enum(["analyzing", "ready", "failed"]);
export type ArtifactJobStatus = z.infer<typeof artifactJobStatusSchema>;

const artifactRelativePathSchema = z.string().min(1).refine(
  (value) => {
    const normalized = value.replaceAll("\\\\", "/");
    return !/^(?:[A-Za-z]:\/|\/)/.test(normalized)
      && !normalized.includes("\0")
      && normalized.split("/").every((segment) => segment && segment !== "." && segment !== "..");
  },
  "Expected a safe relative artifact path",
);

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/i, "Expected a SHA-256 hex digest");

export const artifactReferenceSchema = z.object({
  relativePath: artifactRelativePathSchema,
  byteSize: z.number().int().nonnegative(),
  sha256: sha256Schema,
});
export type ArtifactReference = z.infer<typeof artifactReferenceSchema>;

const agentRenderVariantSchema = z.enum(["compact", "balanced", "visual"]);
const agentRenderRefSchema = artifactReferenceSchema.extend({
  byteSize: z.number().int().positive().max(MAX_AGENT_RENDER_ARTIFACT_BYTES),
});
export const agentVariantRenderSetSchema = z.object({
  version: z.literal(1),
  runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  variants: z.record(agentRenderVariantSchema, z.object({
    pptx: agentRenderRefSchema,
    pdf: agentRenderRefSchema,
    pages: z.array(agentRenderRefSchema).min(5).max(15),
  }).strict()),
}).strict().superRefine((manifest, context) => {
  for (const variant of agentRenderVariantSchema.options) {
    const set = manifest.variants[variant];
    if (!set) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Missing ${variant} render set` });
      continue;
    }
    const expected = (name: string) => `render-evidence/${variant}/${name}`;
    if (set.pptx.relativePath !== expected("deck.pptx") || set.pdf.relativePath !== expected("deck.pdf")) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid ${variant} deck paths` });
    }
    set.pages.forEach((page, index) => {
      if (page.relativePath !== expected(`slide-${index + 1}.png`)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid ${variant} page path` });
      }
    });
  }
});
export type AgentVariantRenderSet = z.infer<typeof agentVariantRenderSetSchema>;

export const generationVariantReferencesSchema = z.object({
  compact: artifactReferenceSchema.nullable(),
  balanced: artifactReferenceSchema.nullable(),
  visual: artifactReferenceSchema.nullable(),
});
export type GenerationVariantReferences = z.infer<typeof generationVariantReferencesSchema>;

export const exportFormatSchema = z.enum(["pptx", "pdf", "html"]);
export type ExportFormat = z.infer<typeof exportFormatSchema>;

export const exportFormatReferencesSchema = z.object({
  pptx: artifactReferenceSchema.nullable(),
  pdf: artifactReferenceSchema.nullable(),
  html: artifactReferenceSchema.nullable(),
});
export type ExportFormatReferences = z.infer<typeof exportFormatReferencesSchema>;

export const exportVariantReferencesSchema = z.object({
  compact: exportFormatReferencesSchema,
  balanced: exportFormatReferencesSchema,
  visual: exportFormatReferencesSchema,
});
export type ExportVariantReferences = z.infer<typeof exportVariantReferencesSchema>;

// These two files are the only persisted view of the deterministic agent run.
// The detailed dry-run graph can contain bounded planning/evidence payloads, so
// it deliberately remains transient and is never admitted into a job manifest.
export const generationOrchestrationReferencesSchema = z.object({
  ranking: artifactReferenceSchema,
  stageTrace: artifactReferenceSchema,
}).strict();
export type GenerationOrchestrationReferences = z.infer<typeof generationOrchestrationReferencesSchema>;

const legacyOrGenerationVariantReferencesSchema = z.union([
  artifactReferenceSchema,
  generationVariantReferencesSchema,
]);

const legacyOrExportVariantReferencesSchema = z.union([
  artifactRelativePathSchema,
  exportVariantReferencesSchema,
]);

export const artifactInputSchema = artifactReferenceSchema.extend({
  name: z.string().min(1),
});
export type ArtifactInput = z.infer<typeof artifactInputSchema>;

// Input source records intentionally contain provenance only. They never carry
// extracted text, binary bytes, prompts, or provider payloads.
export const inputSourceArtifactSchema = z.object({
  id: z.string().regex(/^source-[a-f0-9]{24}$/i),
  type: z.string().min(1).max(160),
  name: z.string().min(1).max(240),
  origin: z.literal("uploaded"),
  sha256: sha256Schema,
  byteSize: z.number().int().nonnegative(),
  sourceChunkIds: z.array(z.string().min(1)).max(50_000),
  factIds: z.array(z.string().min(1)).max(50_000),
}).strict();
export type InputSourceArtifact = z.infer<typeof inputSourceArtifactSchema>;

export const renderSlideEvidenceSchema = artifactReferenceSchema.extend({
  slideNumber: z.number().int().positive(),
});
export type RenderSlideEvidence = z.infer<typeof renderSlideEvidenceSchema>;

export const renderEvidenceSchema = z.object({
  version: z.literal(1),
  renderer: z.literal("libreoffice-impress-headless"),
  rendererPath: z.string().min(1),
  rendererVersion: z.string().min(1),
  rasterizer: z.literal("poppler-pdftoppm"),
  rasterizerPath: z.string().min(1),
  pageCounter: z.literal("poppler-pdfinfo"),
  pageCounterPath: z.string().min(1),
  inputPath: artifactRelativePathSchema,
  pdf: artifactReferenceSchema,
  outputFormat: z.literal("png"),
  slideCount: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  slides: z.array(renderSlideEvidenceSchema).min(1),
});
export type RenderEvidenceArtifact = z.infer<typeof renderEvidenceSchema>;

const renderComparisonRelativePathSchema = z.string().min(1).refine(
  (value) => {
    const normalized = value.replaceAll("\\", "/");
    return !/^(?:[A-Za-z]:\/|\/)/.test(normalized)
      && !normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
      && !normalized.includes("\0");
  },
  "Expected a safe relative render-comparison path",
);

const renderComparisonSha256Schema = z.string().regex(/^[0-9a-f]{64}$/i, "Expected a SHA-256 hex digest");

export const renderGoldenPageSchema = z.object({
  slideNumber: z.number().int().positive(),
  byteSize: z.number().int().positive(),
  sha256: renderComparisonSha256Schema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type RenderGoldenPage = z.infer<typeof renderGoldenPageSchema>;

export const renderGoldenRepresentativeSchema = renderGoldenPageSchema.extend({
  goldenPath: renderComparisonRelativePathSchema,
});
export type RenderGoldenRepresentative = z.infer<typeof renderGoldenRepresentativeSchema>;

export const renderGoldenFixtureSchema = z.object({
  inputPath: renderComparisonRelativePathSchema,
  pageCount: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  pageSetSha256: renderComparisonSha256Schema,
  pages: z.array(renderGoldenPageSchema).min(1),
  representatives: z.array(renderGoldenRepresentativeSchema).min(1),
}).superRefine((fixture, context) => {
  if (fixture.pages.length !== fixture.pageCount) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Golden page metadata must cover every rendered page" });
  }
  if (fixture.representatives.length > 3) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Golden representatives must contain at most three pages" });
  }
});
export type RenderGoldenFixture = z.infer<typeof renderGoldenFixtureSchema>;

export const renderGoldenManifestSchema = z.object({
  version: z.literal(1),
  renderer: z.literal("libreoffice-impress-headless"),
  rasterizer: z.literal("poppler-pdftoppm"),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fixtures: z.array(renderGoldenFixtureSchema).min(1),
});
export type RenderGoldenManifest = z.infer<typeof renderGoldenManifestSchema>;

export const renderArtifactReferencesSchema = z.object({
  pdf: artifactReferenceSchema,
  slides: z.array(renderSlideEvidenceSchema).min(1),
});
export type RenderArtifactReferences = z.infer<typeof renderArtifactReferencesSchema>;

export const artifactReferencesSchema = z.object({
  parsed: artifactReferenceSchema.nullable(),
  renderEvidence: artifactReferenceSchema.nullable(),
  renders: renderArtifactReferencesSchema.nullable(),
  planning: artifactReferenceSchema.nullable(),
  variants: legacyOrGenerationVariantReferencesSchema.nullable(),
  // Version 1 manifests may contain the old single exported relative path.
  // Keep accepting it while new jobs publish the per-variant artifact graph.
  exports: legacyOrExportVariantReferencesSchema.nullable(),
  audit: legacyOrGenerationVariantReferencesSchema.nullable(),
  orchestration: generationOrchestrationReferencesSchema.nullable(),
});
export type ArtifactReferences = z.infer<typeof artifactReferencesSchema>;

export const failedPlannerPolicySchema = z.object({
  status: z.literal("rejected"),
  rejectedField: z.string().min(1).max(120),
  reason: z.string().min(1).max(240),
  modelName: z.string().min(1).max(240).optional(),
  modelUri: z.string().min(1).max(240).optional(),
  totalParametersB: z.number().finite().positive().optional(),
  openWeights: z.boolean().optional(),
  license: z.string().min(1).max(120).optional(),
}).strict();
export type FailedPlannerPolicy = z.infer<typeof failedPlannerPolicySchema>;

// Failed live-provider attempts are intentionally represented by bounded,
// content-free evidence. This must remain safe to persist in a job manifest.
export const providerAttemptDiagnosticSchema = z.object({
  stage: z.enum(["transport", "http", "response_shape", "content", "json_parse", "truncation"]),
  code: z.enum(["provider_configuration_failed", "provider_timeout", "provider_http", "invalid_json"]),
  attempt: z.number().int().positive().max(3),
  httpStatus: z.number().int().min(100).max(599).optional(),
  contentPresent: z.boolean().optional(),
  contentType: z.enum(["string", "null", "array", "object", "number", "boolean", "undefined"]).optional(),
  contentLength: z.number().int().nonnegative().max(1_000_000).optional(),
  finishReason: z.string().min(1).max(120).optional(),
  responseShapeKeys: z.array(z.string().regex(/^[A-Za-z0-9_.-]+$/).max(80)).max(20).optional(),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  }).strict().optional(),
}).strict();
export type ProviderAttemptDiagnostic = z.infer<typeof providerAttemptDiagnosticSchema>;

const plannerSchemaPathSegmentSchema = z.union([
  z.enum(["title", "slides", "id", "purpose", "content", "visualIntent", "evidence", "contentIndex", "sourceChunkIds", "factIds", "verbatimEvidence"]),
  z.number().int().nonnegative().max(15),
]);

// Content-free evidence for schema validation after the provider response has
// been parsed. Unknown response keys are never admitted into persisted paths.
export const plannerSchemaDiagnosticSchema = z.object({
  stage: z.literal("planning"),
  attempt: z.number().int().positive().max(3),
  issues: z.array(z.object({
    path: z.array(plannerSchemaPathSegmentSchema).min(1).max(6),
    code: z.enum(["too_small", "too_big", "invalid_type", "invalid_enum_value", "invalid_string", "custom"]),
    minimum: z.number().finite().nonnegative().optional(),
    maximum: z.number().finite().nonnegative().optional(),
  }).strict()).max(8),
}).strict();
export type PlannerSchemaDiagnostic = z.infer<typeof plannerSchemaDiagnosticSchema>;

export const groundingSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  grounded: z.number().int().nonnegative(),
  unsupported: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  ruleVersion: z.string().min(1).max(120),
}).strict().superRefine((summary, context) => {
  if (summary.total !== summary.grounded + summary.unsupported) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Grounding summary total must equal grounded plus unsupported" });
  }
  if (summary.rejected > summary.unsupported) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Grounding summary rejected cannot exceed unsupported" });
  }
});
export type GroundingSummary = z.infer<typeof groundingSummarySchema>;

export const skillVersionsSchema = z.record(z.string().min(1).max(120), z.string().regex(/^v\d+$/));
export type SkillVersions = z.infer<typeof skillVersionsSchema>;

export const artifactManifestSchema = z.object({
  version: z.literal(1),
  jobId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Expected a safe artifact job id"),
  status: artifactJobStatusSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  inputs: z.object({
    template: artifactInputSchema,
    sources: z.array(inputSourceArtifactSchema).max(12),
  }),
  artifacts: artifactReferencesSchema,
  error: z.string().max(240).optional(),
  plannerPolicy: failedPlannerPolicySchema.optional(),
  providerDiagnostics: z.array(providerAttemptDiagnosticSchema).min(1).max(3).optional(),
  plannerSchemaDiagnostic: plannerSchemaDiagnosticSchema.optional(),
  groundingSummary: groundingSummarySchema.optional(),
  skillVersions: skillVersionsSchema.optional(),
});
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;

const generationStageIdSchema = z.enum([
  "inputs", "specialists", "narrative-candidates", "narrative-selection",
  "visual-direction", "variant-design", "render-audit", "critics",
  "repair-plans", "final-jury",
]);
const generationArtifactIdSchema = z.string().regex(/^artifact-[a-z0-9][a-z0-9._-]{0,79}$/);
export const generationStageTraceSchema = z.array(z.object({
  stage: generationStageIdSchema,
  status: z.enum(["completed", "blocked"]),
  agentIds: z.array(agentIdSchema).max(8),
  inputArtifactIds: z.array(generationArtifactIdSchema).max(64),
  outputArtifactIds: z.array(generationArtifactIdSchema).max(64),
  attempts: z.number().int().min(1).max(3),
  durationMs: z.number().int().min(0).max(300_000),
}).strict()).min(1).max(32);
export type GenerationStageTrace = z.infer<typeof generationStageTraceSchema>;

export const jobExportRequestSchema = z.object({
  jobId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Expected a safe artifact job id"),
  variant: z.enum(["compact", "balanced", "visual"]),
}).strict();
export type JobExportRequest = z.infer<typeof jobExportRequestSchema>;

export const contentDocumentSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  text: z.string().max(50_000),
  characters: z.number().int().nonnegative(),
});
export type ContentDocument = z.infer<typeof contentDocumentSchema>;

const xlsxMergedRangeSchema = z.string().regex(
  /^[A-Z]+[1-9]\d*:[A-Z]+[1-9]\d*$/u,
  "Expected a normalized XLSX merged range",
);

export const sourceChunkSchema = z.object({
  sourceId: z.string().min(1),
  chunkId: z.string().min(1),
  sourceName: z.string().min(1),
  mimeType: z.string().min(1),
  text: z.string().max(50_000),
  locator: z.string().min(1).max(240),
  precision: z.enum(["exact", "document"]),
  mergedRange: xlsxMergedRangeSchema.optional(),
});
export type SourceChunk = z.infer<typeof sourceChunkSchema>;

const factIdSchema = z.string().min(1);
const spreadsheetLocatorSchema = z.string().min(1).max(240).regex(
  /^(?:sheet:[^\r\n]+,)?row:[1-9]\d*,column:[1-9]\d*$/u,
  "Expected an exact spreadsheet cell locator",
);

const spreadsheetCoordinateSchema = z.object({
  sheet: z.string().min(1).max(200).optional(),
  row: z.number().int().positive(),
  column: z.number().int().positive(),
});

const spreadsheetValueSchema = z.union([
  z.string().max(50_000),
  z.number().finite(),
  z.boolean(),
]);

export const spreadsheetFactSchema = z.object({
  kind: z.literal("spreadsheet-cell"),
  factId: factIdSchema,
  sourceId: z.string().min(1),
  chunkId: z.string().min(1),
  format: z.enum(["xlsx", "csv"]),
  valueType: z.enum(["string", "number", "boolean", "date"]),
  value: spreadsheetValueSchema,
  coordinate: spreadsheetCoordinateSchema,
  locator: spreadsheetLocatorSchema,
  formula: z.string().min(1).max(8_192).optional(),
  mergedRange: xlsxMergedRangeSchema.optional(),
}).superRefine((fact, context) => {
  const expectedType = fact.valueType === "date" ? "string" : fact.valueType;
  if (typeof fact.value !== expectedType) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["valueType"],
      message: "Spreadsheet fact valueType must match value",
    });
  }
  if (fact.valueType === "date" && (typeof fact.value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(fact.value))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["value"],
      message: "Spreadsheet date facts must use a UTC ISO timestamp",
    });
  }
  const expectedLocator = fact.coordinate.sheet
    ? `sheet:${fact.coordinate.sheet},row:${fact.coordinate.row},column:${fact.coordinate.column}`
    : `row:${fact.coordinate.row},column:${fact.coordinate.column}`;
  if (fact.locator !== expectedLocator) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["locator"],
      message: "Spreadsheet fact locator must match its sheet/row/column coordinate",
    });
  }
  if (fact.format === "xlsx" && !fact.coordinate.sheet) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["coordinate", "sheet"],
      message: "XLSX spreadsheet facts must include a sheet coordinate",
    });
  }
  if (fact.format === "csv" && fact.coordinate.sheet !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["coordinate", "sheet"],
      message: "CSV spreadsheet facts must not include a sheet coordinate",
    });
  }
  if (fact.format === "csv" && fact.mergedRange !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["mergedRange"],
      message: "Only XLSX spreadsheet facts may include a merged range",
    });
  }
});
export type SpreadsheetFact = z.infer<typeof spreadsheetFactSchema>;

export const imageMetadataFactSchema = z.object({
  kind: z.literal("image-metadata"),
  factId: factIdSchema,
  sourceId: z.string().min(1),
  chunkId: z.string().min(1),
  locator: z.literal("image:metadata"),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  byteSize: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
}).superRefine((fact, context) => {
  if ((fact.width === undefined) !== (fact.height === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["width"],
      message: "Image metadata dimensions must include both width and height",
    });
  }
});
export type ImageMetadataFact = z.infer<typeof imageMetadataFactSchema>;

export const sourceFactSchema = z.union([spreadsheetFactSchema, imageMetadataFactSchema]);
export type SourceFact = z.infer<typeof sourceFactSchema>;

export const normalizedContentSchema = z.object({
  brief: z.string().min(2).max(10_000),
  documents: z.array(contentDocumentSchema).max(12),
  excerpts: z.array(z.string()).max(30),
  keywords: z.array(z.string()).max(30),
  sourceChunks: z.array(sourceChunkSchema).default([]),
  facts: z.array(sourceFactSchema).default([]),
}).superRefine((content, context) => {
  const chunksById = new Map(content.sourceChunks.map((chunk) => [chunk.chunkId, chunk]));
  const seenFactIds = new Set<string>();
  for (const fact of content.facts) {
    if (seenFactIds.has(fact.factId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["facts"], message: `Duplicate factId: ${fact.factId}` });
    }
    seenFactIds.add(fact.factId);
    const chunk = chunksById.get(fact.chunkId);
    if (!chunk) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["facts"],
        message: `Fact ${fact.factId} references unknown sourceChunkId: ${fact.chunkId}`,
      });
      continue;
    }
    if (fact.sourceId !== chunk.sourceId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["facts"],
        message: `Fact ${fact.factId} sourceId does not match source chunk ${fact.chunkId}`,
      });
    }
    if (fact.locator !== chunk.locator) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["facts"],
        message: `Fact ${fact.factId} locator does not match source chunk ${fact.chunkId}`,
      });
    }
    if (fact.kind === "spreadsheet-cell" && fact.mergedRange !== chunk.mergedRange) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["facts"],
        message: `Fact ${fact.factId} mergedRange does not match source chunk ${fact.chunkId}`,
      });
    }
  }
});
export type NormalizedContent = Omit<z.infer<typeof normalizedContentSchema>, "facts">
  & { facts?: SourceFact[] };

export const planSourceRefsSchema = z.object({
  sourceChunkIds: z.array(z.string().min(1)).max(50).default([]),
  factIds: z.array(z.string().min(1)).max(50).default([]),
}).strict();
export type PlanSourceRefs = z.infer<typeof planSourceRefsSchema>;

export const planClaimSchema = z.object({
  id: z.string().min(1).max(120),
  text: z.string().min(1).max(280),
  grounding: z.enum(["grounded", "unsupported"]),
  groundingReason: z.string().min(1).max(240).optional(),
  precision: z.enum(["exact", "document"]).default("document"),
  sourceRefs: planSourceRefsSchema.default({ sourceChunkIds: [], factIds: [] }),
}).superRefine((claim, context) => {
  const hasRefs = claim.sourceRefs.sourceChunkIds.length > 0 || claim.sourceRefs.factIds.length > 0;
  if (claim.grounding === "grounded" && !hasRefs) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceRefs"],
      message: "Grounded claim must cite at least one sourceChunkId or factId",
    });
  }
  if (claim.grounding === "unsupported" && hasRefs) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceRefs"],
      message: "Unsupported claim must not contain source references",
    });
  }
});
export type PlanClaim = z.infer<typeof planClaimSchema>;

export const planSlideSchema = z.object({
  id: z.string().min(1),
  purpose: z.enum([
    "title",
    "problem",
    "context",
    "opportunity",
    "solution",
    "workflow",
    "advantages",
    "implementation",
    "metrics",
    "next_steps",
    "summary",
  ]),
  title: z.string().min(1).max(160),
  content: z.array(z.string().min(1).max(280)).min(1).max(6),
  visualIntent: z.enum(["none", "diagram", "cards", "timeline", "image", "metrics"]),
  sourceRefs: planSourceRefsSchema.optional(),
  claims: z.array(planClaimSchema).max(6).optional(),
});
export type PlanSlide = z.infer<typeof planSlideSchema>;

// This is intentionally a provider-only contract. It is never persisted as a
// DeckPlan: claim-alignment.ts validates it against the server-side catalogue
// and converts it to the public claims/sourceRefs shape.
export const providerContentEvidenceSchema = z.object({
  contentIndex: z.number().int().nonnegative().max(5),
  sourceChunkIds: z.array(z.string().min(1)).max(50).default([]),
  factIds: z.array(z.string().min(1)).max(50).default([]),
  verbatimEvidence: z.string().max(5_000),
}).strict();
export type ProviderContentEvidence = z.infer<typeof providerContentEvidenceSchema>;

export const providerPlanSlideSchema = z.object({
  id: z.string().min(1),
  purpose: planSlideSchema.shape.purpose,
  title: z.string().min(1).max(160),
  content: z.array(z.string().min(1).max(280)).min(1).max(6),
  visualIntent: planSlideSchema.shape.visualIntent,
  evidence: z.array(providerContentEvidenceSchema).min(1).max(6),
}).strict().superRefine((slide, context) => {
  const received = new Set(slide.evidence.map((item) => item.contentIndex));
  if (received.size !== slide.evidence.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["evidence"], message: "Provider evidence contentIndex values must be unique" });
  }
  for (let index = 0; index < slide.content.length; index += 1) {
    if (!received.has(index)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["evidence"], message: `Provider evidence is missing contentIndex ${index}` });
    }
  }
  for (const index of received) {
    if (index >= slide.content.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["evidence"], message: `Provider evidence contentIndex ${index} is outside content` });
    }
  }
});
export type ProviderPlanSlide = z.infer<typeof providerPlanSlideSchema>;

export const providerDeckPlanSchema = z.object({
  title: z.string().min(1).max(180),
  slides: z.array(providerPlanSlideSchema).min(5).max(15),
}).strict();
export type ProviderDeckPlan = z.infer<typeof providerDeckPlanSchema>;

export const presentationPlanMetaSchema = z.object({
  provider: z.string().min(1),
  modelUri: z.string().min(1).optional(),
  promptPath: z.string().min(1),
  promptSha256: sha256Schema,
  generatedAt: z.string().datetime({ offset: true }),
  attempts: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  attemptsUsed: z.number().int().nonnegative(),
  policy: z.object({
    status: z.enum(["approved", "not_applicable"]),
    modelName: z.string().min(1).optional(),
    modelUri: z.string().min(1).optional(),
    totalParametersB: z.number().positive().max(35).optional(),
    openWeights: z.literal(true).optional(),
    license: z.enum(["Apache-2.0", "MIT"]).optional(),
  }).strict(),
  budget: z.object({
    inputTokenBudget: z.number().int().nonnegative(),
    outputTokenBudget: z.number().int().nonnegative(),
    totalTokenBudget: z.number().int().nonnegative(),
    estimatedInputTokens: z.number().int().nonnegative(),
    estimatedOutputTokens: z.number().int().nonnegative(),
    estimatedTotalTokens: z.number().int().nonnegative(),
  }).strict(),
  reportedUsage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  }).strict().nullable(),
  usageUnknown: z.boolean(),
  groundingSummary: groundingSummarySchema.optional(),
  skillVersions: skillVersionsSchema.optional(),
}).strict();
export type PresentationPlanMeta = z.infer<typeof presentationPlanMetaSchema>;

export const presentationPlanSchema = z.object({
  title: z.string().min(1).max(180),
  slides: z.array(planSlideSchema).min(5).max(15),
  planner: z.enum(["deterministic", "llm"]),
  meta: presentationPlanMetaSchema.optional(),
});
export type PresentationPlan = z.infer<typeof presentationPlanSchema>;

export const generationPlanningSchema = z.object({
  normalizedContent: normalizedContentSchema,
  presentationPlan: presentationPlanSchema,
});
export type GenerationPlanning = z.infer<typeof generationPlanningSchema>;

export const canvasTextSchema = z.object({
  id: z.string().min(1),
  type: z.literal("text"),
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  text: z.string().max(1_000),
  fontFamily: z.string().min(1),
  fontSize: z.number().positive(),
  fontWeight: z.number().int().positive().default(400),
  color: colorSchema,
  align: z.enum(["left", "center", "right"]).default("left"),
  zIndex: z.number().int().nonnegative(),
  locked: z.boolean().default(false),
  sourceTemplateElementId: z.string().optional(),
});

export const canvasShapeSchema = z.object({
  id: z.string().min(1),
  type: z.literal("shape"),
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  shape: z.enum(["rect", "roundRect", "ellipse", "line"]).default("rect"),
  fill: colorSchema,
  stroke: colorSchema,
  strokeWidth: z.number().nonnegative().default(0),
  radius: z.number().nonnegative().default(0),
  zIndex: z.number().int().nonnegative(),
  locked: z.boolean().default(false),
  groupId: z.string().optional(),
  sourceTemplateElementId: z.string().optional(),
});

export const canvasImageSchema = z.object({
  id: z.string().min(1),
  type: z.literal("image"),
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  alt: z.string().default(""),
  dataUrl: z.string().optional(),
  crop: canvasImageCropSchema.optional(),
  zIndex: z.number().int().nonnegative(),
  locked: z.boolean().default(false),
  sourceTemplateElementId: z.string().optional(),
});

const canvasTableBorderSchema = z.object({
  color: colorSchema,
  width: z.number().nonnegative().max(12),
}).strict();

const canvasTableCellSchema = z.object({
  text: z.string().max(1_000),
  fill: colorSchema,
  color: colorSchema,
  align: z.enum(["left", "center", "right"]).default("left"),
  border: canvasTableBorderSchema,
}).strict();

const canvasTableRowSchema = z.array(canvasTableCellSchema).min(1).max(20);

/**
 * A deliberately small native-table contract. Merges, formulas, rich text and
 * arbitrary PptxGenJS options are excluded so every cell can be exported as a
 * deterministic, editable OOXML table cell.
 */
export const canvasTableSchema = z.object({
  id: z.string().min(1),
  type: z.literal("table"),
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  rows: z.array(canvasTableRowSchema).min(1).max(50),
  fontFamily: z.string().min(1),
  fontSize: z.number().positive().max(200),
  fontWeight: z.number().int().positive().default(400),
  zIndex: z.number().int().nonnegative(),
  locked: z.boolean().default(false),
  sourceTemplateElementId: z.string().optional(),
}).strict();

const canvasPieDatumReferenceSchema = z.object({
  factId: z.string().min(1),
  sourceChunkId: z.string().min(1),
}).strict();

const canvasPieCategorySchema = canvasPieDatumReferenceSchema.extend({
  value: z.string().min(1).max(50_000),
}).strict();

const canvasPieValueSchema = canvasPieDatumReferenceSchema.extend({
  value: z.number().finite(),
}).strict();

const canvasPieSeriesSchema = z.object({
  id: z.string().min(1).max(120),
  label: canvasPieCategorySchema,
  values: z.array(canvasPieValueSchema).min(1).max(100),
}).strict();

const canvasPieSourceRefsSchema = z.object({
  sourceChunkIds: z.array(z.string().min(1)).min(1).max(201),
  factIds: z.array(z.string().min(1)).min(1).max(201),
}).strict();

/** A semantic pie chart keeps its ordered, grounded data for native export. */
export const canvasPieChartSchema = z.object({
  id: z.string().min(1),
  type: z.literal("chart"),
  chartType: z.literal("pie"),
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  title: z.string().min(1).max(160),
  categories: z.array(canvasPieCategorySchema).min(1).max(100),
  series: canvasPieSeriesSchema,
  sourceRefs: canvasPieSourceRefsSchema,
  zIndex: z.number().int().nonnegative(),
  locked: z.boolean().default(false),
  sourceTemplateElementId: z.string().optional(),
}).strict();

export const canvasElementSchema = z.discriminatedUnion("type", [
  canvasTextSchema,
  canvasShapeSchema,
  canvasImageSchema,
  canvasTableSchema,
  canvasPieChartSchema,
]).superRefine((element, context) => {
  if (element.type === "table") {
    const columnCount = element.rows[0]?.length ?? 0;
    if (element.rows.some((row) => row.length !== columnCount)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rows"],
        message: "Table rows must all contain the same number of cells",
      });
    }
    if (element.rows.length * columnCount > 400) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rows"],
        message: "Table must contain at most 400 cells",
      });
    }
    return;
  }
  if (element.type !== "chart") return;

  if (element.series.values.length !== element.categories.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["series", "values"],
      message: "Pie chart values must align with the category count",
    });
  }
  const total = element.series.values.reduce((sum, datum) => sum + datum.value, 0);
  element.series.values.forEach((datum, index) => {
    if (datum.value < 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["series", "values", index, "value"],
        message: "Pie chart values must be non-negative",
      });
    }
  });
  if (!Number.isFinite(total) || total <= 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["series", "values"],
      message: "Pie chart values must have a finite positive sum",
    });
  }

  const categoryAndValueRefs = [
    ...element.categories,
    element.series.label,
    ...element.series.values,
  ];
  const sourceChunkIds = new Set(element.sourceRefs.sourceChunkIds);
  const factIds = new Set(element.sourceRefs.factIds);
  categoryAndValueRefs.forEach((datum, index) => {
    if (!sourceChunkIds.has(datum.sourceChunkId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceRefs", "sourceChunkIds"],
        message: `Pie chart datum ${index} is missing its source chunk reference`,
      });
    }
    if (!factIds.has(datum.factId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceRefs", "factIds"],
        message: `Pie chart datum ${index} is missing its fact reference`,
      });
    }
  });
});
export type CanvasElement = z.infer<typeof canvasElementSchema>;

export const slideCanvasSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  background: colorSchema,
  elements: z.array(canvasElementSchema).max(200),
});
export type SlideCanvas = z.infer<typeof slideCanvasSchema>;

export const renderedSlideSchema = z.object({
  id: z.string().min(1),
  order: z.number().int().positive(),
  purpose: planSlideSchema.shape.purpose,
  title: z.string().min(1),
  templateLayoutId: z.string().min(1),
  canvas: slideCanvasSchema,
});
export type RenderedSlide = z.infer<typeof renderedSlideSchema>;

export const presentationDocumentSchema = z.object({
  version: z.literal(1),
  title: z.string().min(1),
  variant: z.enum(["compact", "balanced", "visual"]).optional(),
  designSystem: designSystemSchema,
  plan: presentationPlanSchema,
  slides: z.array(renderedSlideSchema).min(5).max(15),
  auditDecisions: z.array(z.object({
    issueKey: z.string().min(1),
    slideId: z.string().min(1),
    elementId: z.string().min(1).optional(),
    action: z.enum(["fix", "ignore"]),
    appliedAt: z.string().min(1),
  })).max(500).optional(),
});
export type PresentationDocument = z.infer<typeof presentationDocumentSchema>;

export const auditIssueSchema = z.object({
  type: z.enum([
    "OUTSIDE_SLIDE",
    "TEXT_OVERFLOW",
    "ELEMENT_OVERLAP",
    "SMALL_TEXT",
    "EMPTY_PLACEHOLDER",
    "UNSUPPORTED_FONT",
    "COLOR_OUTSIDE_DESIGN_SYSTEM",
    "SMALL_MARGIN",
    "DENSE_LAYOUT",
    "LOW_TEXT_CONTRAST",
    "DUPLICATE_SLIDE",
    "INVALID_IMAGE_DATA",
    "IMAGE_ASPECT_DISTORTION",
  ]),
  severity: z.enum(["info", "warning", "error"]),
  elementId: z.string().optional(),
  message: z.string().min(1),
  issueKey: z.string().min(1).optional(),
  ignored: z.boolean().optional(),
});
export type AuditIssue = z.infer<typeof auditIssueSchema>;

export const auditReportSchema = z.object({
  slides: z.array(z.object({
    slideId: z.string(),
    issues: z.array(auditIssueSchema),
  })),
  passed: z.boolean(),
});
export type AuditReport = z.infer<typeof auditReportSchema>;

export type LayoutVariant = "compact" | "balanced" | "visual";
