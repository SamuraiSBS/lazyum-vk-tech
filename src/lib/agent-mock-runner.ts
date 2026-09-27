import {
  agentIdSchema,
  evidenceAnalystInputSchema,
  evidencePackSchema,
  finalJuryInputSchema,
  narrativeArchitectInputSchema,
  narrativePlanSchema,
  repairPlanSchema,
  repairPlannerInputSchema,
  templateAnalystInputSchema,
  templateInterpretationSchema,
  validateAgentInput,
  validateAgentOutput,
  variantDesignerInputSchema,
  variantPlanSchema,
  variantRankingSchema,
  visualDirectorInputSchema,
  visualSpecPackSchema,
  criticInputSchema,
  critiqueReportSchema,
  type AgentId,
  type AgentOutput,
  type EvidencePack,
  type NarrativePlan,
  type TemplateInterpretation,
  type VariantId,
} from "./agent-contracts";

function bounded(value: string, max: number) {
  return value.length <= max ? value : value.slice(0, max - 1).trimEnd() + "…";
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function runTemplateAnalyst(input: unknown): TemplateInterpretation {
  const parsed = templateAnalystInputSchema.parse(input);
  return templateInterpretationSchema.parse({
    version: "v1",
    layoutFamilies: parsed.layouts.slice(0, 20).map((layout, index) => ({
      id: layout.id,
      purpose: layout.composition,
      confidence: Number(Math.max(0.5, 0.96 - index * 0.03).toFixed(2)),
      reusable: true,
      riskCodes: [
        ...(layout.textSlots > 8 ? ["high_density" as const] : []),
        ...(layout.visualSlots === 0 ? ["sparse_visuals" as const] : []),
      ].slice(0, 3),
    })),
    typography: {
      headingRoles: parsed.designTokens.headingFonts.length ? ["heading"] : ["heading-fallback"],
      bodyRoles: parsed.designTokens.bodyFonts.length ? ["body"] : ["body-fallback"],
      densityGuidance: parsed.layouts.some((layout) => layout.textSlots > 8) ? "compact" : "balanced",
    },
    spacingGuidance: parsed.layouts.some((layout) => layout.cardCount > 4) ? "tight" : "regular",
    prohibitedCompositions: parsed.layouts.some((layout) => layout.visualSlots === 0)
      ? ["Do not require a visual slot from a text-only observed layout"]
      : [],
    risks: [
      "Observed geometry remains authoritative in the deterministic layout engine",
      ...(parsed.renderEvidenceRefs.length === 0 ? ["No rendered template evidence was supplied"] : []),
    ].slice(0, 20),
  });
}

function runEvidenceAnalyst(input: unknown): EvidencePack {
  const parsed = evidenceAnalystInputSchema.parse(input);
  const sourcesById = new Map(parsed.sources.map((source) => [source.sourceId, source]));
  const claims = parsed.sourceChunks.slice(0, 40).map((chunk, index) => {
    const source = sourcesById.get(chunk.sourceId);
    const factIds = source?.factIds.slice(0, 2) ?? [];
    return {
      id: `claim-${index + 1}`,
      text: bounded(chunk.excerpt, 280),
      priority: index < 3 ? 3 : 2,
      precision: chunk.precision,
      sourceRefs: { sourceChunkIds: [chunk.chunkId], factIds },
    } as const;
  });
  return evidencePackSchema.parse({
    version: "v1",
    claims,
    contradictions: [],
    unsupported: claims.length ? [] : [{ id: "unsupported-no-source", summary: "No bounded source evidence was supplied" }],
    coverage: { total: claims.length, grounded: claims.length },
  });
}

function runNarrativeArchitect(input: unknown, candidateNumber: 1 | 2 = 1): NarrativePlan {
  const parsed = narrativeArchitectInputSchema.parse(input);
  const purposes = ["title", "problem", "context", "opportunity", "solution", "workflow", "advantages", "implementation", "metrics", "next_steps", "summary"] as const;
  const intents = ["none", "cards", "diagram", "image", "cards", "timeline", "cards", "timeline", "metrics", "none", "cards"] as const;
  const firstLine = parsed.brief.split(/\r?\n/u).find((line) => line.trim())?.trim() || "Новая презентация";
  const slides = Array.from({ length: parsed.slideCount }, (_, index) => {
    const claim = parsed.evidence.claims[index % Math.max(1, parsed.evidence.claims.length)];
    const claimIds = claim ? [claim.id] : [];
    const sourceRefs = claim ? claim.sourceRefs : { sourceChunkIds: [], factIds: [] };
    const title = index === 0
      ? bounded(firstLine, 160)
      : `${purposes[index % purposes.length]} — вариант ${candidateNumber}`;
    return {
      id: `slide-${index + 1}`,
      purpose: purposes[index % purposes.length],
      title,
      message: claim?.text || "Сформулировать следующий проверяемый вывод для аудитории.",
      claimIds,
      sourceRefs,
      visualIntent: intents[index % intents.length],
      nextTransition: index + 1 < parsed.slideCount ? `К следующему слайду ${index + 2}` : "Завершить deck проверяемым следующим шагом",
    };
  });
  return narrativePlanSchema.parse({
    version: "v1",
    planId: `candidate-${candidateNumber}`,
    title: bounded(firstLine, 180),
    audience: "Команда и заинтересованные пользователи",
    objective: "Собрать проверяемую историю из ограниченных входных evidence refs",
    slides,
  });
}

function runVisualDirector(input: unknown) {
  const parsed = visualDirectorInputSchema.parse(input);
  const specs = parsed.narrative.slides.map((slide) => ({
    slideId: slide.id,
    visualType: slide.visualIntent === "metrics" ? "chart" : slide.visualIntent === "diagram" ? "diagram" : slide.visualIntent === "timeline" ? "timeline" : slide.visualIntent === "image" ? "image" : slide.visualIntent === "cards" ? "cards" : "none",
    intent: `Support the semantic message of ${slide.id} without inventing data`,
    claimIds: slide.claimIds,
    sourceRefs: slide.sourceRefs,
    nativeSafe: true as const,
    fallback: slide.visualIntent === "image" ? "cards" as const : "text" as const,
  }));
  return visualSpecPackSchema.parse({ version: "v1", specs });
}

function runVariantDesigner(input: unknown, variant: VariantId) {
  const parsed = variantDesignerInputSchema.parse(input);
  const profiles = {
    compact: { density: "compact", visualRatio: "low", dataEmphasis: "high" },
    balanced: { density: "balanced", visualRatio: "medium", dataEmphasis: "medium" },
    visual: { density: "airy", visualRatio: "high", dataEmphasis: "low" },
  } as const;
  const layoutIds = parsed.template.layoutFamilies.map((layout) => layout.id);
  return variantPlanSchema.parse({
    version: "v1",
    variant,
    profile: profiles[variant],
    slides: parsed.narrative.slides.map((slide, index) => ({
      slideId: slide.id,
      layoutId: layoutIds[index % layoutIds.length],
      slotAssignments: [
        { slotId: `${slide.id}-title`, role: "title", claimIds: slide.claimIds },
        { slotId: `${slide.id}-body`, role: "body", claimIds: slide.claimIds },
        ...(parsed.visuals.specs[index]?.visualType !== "none" ? [{ slotId: `${slide.id}-visual`, role: "visual" as const, claimIds: slide.claimIds }] : []),
      ],
      contentMode: variant === "compact" ? "compressed" : variant === "visual" ? "expanded" : "balanced",
    })),
    rationale: `${variant} keeps the same canonical narrative while changing only bounded density and visual intent decisions`,
    expectedTradeoff: variant === "compact" ? "More information per slide, less visual breathing room" : variant === "visual" ? "More focal space, less text density" : "Balanced readability and information density",
  });
}

function runCritic(input: unknown, critic: "semantic" | "visual") {
  const parsed = criticInputSchema.parse(input);
  const firstSlide = parsed.variantPlan.slides[0];
  if (critic === "semantic") {
    const knownClaims = new Set(parsed.evidence.claims.map((claim) => claim.id));
    const slideClaims = parsed.variantPlan.slides.map((slide) =>
      [...new Set(slide.slotAssignments.flatMap((slot) => slot.claimIds))].sort(),
    );
    // Reject the whole report before emitting advisory findings if any binding is unknown.
    for (const [index, claimIds] of slideClaims.entries()) {
      for (const claimId of claimIds) {
        if (!knownClaims.has(claimId)) {
          throw new Error(`Unknown evidence claim ID ${claimId} on slide ${parsed.variantPlan.slides[index].slideId}`);
        }
      }
    }

    const findings: Array<{
      id: string;
      severity: "info" | "warning";
      category: "grounding" | "narrative";
      slideId: string;
      message: string;
      evidenceArtifactIds: string[];
    }> = [];
    const firstUse = new Map<string, string>();
    for (const [index, slide] of parsed.variantPlan.slides.entries()) {
      const claimIds = slideClaims[index];
      if (parsed.evidence.claims.length > 0 && claimIds.length === 0) {
        findings.push({
          id: `advisory-unbound-${index + 1}`,
          severity: "warning",
          category: "grounding",
          slideId: slide.slideId,
          message: "No evidence claim is bound to this slide",
          evidenceArtifactIds: [parsed.auditArtifact.artifactId],
        });
      }
      for (const [claimIndex, claimId] of claimIds.entries()) {
        const earlierSlide = firstUse.get(claimId);
        if (earlierSlide) {
          findings.push({
            id: `advisory-repeated-${index + 1}-${claimIndex + 1}`,
            severity: "info",
            category: "narrative",
            slideId: slide.slideId,
            message: bounded(`Evidence claim ${claimId} is also bound to slide ${earlierSlide}`, 240),
            evidenceArtifactIds: [parsed.auditArtifact.artifactId],
          });
        } else {
          firstUse.set(claimId, slide.slideId);
        }
      }
    }
    return critiqueReportSchema.parse({
      version: "v1",
      variant: parsed.variant,
      advisoryOnly: true,
      findings: findings.slice(0, 40),
    });
  }
  return critiqueReportSchema.parse({
    version: "v1",
    variant: parsed.variant,
    advisoryOnly: true,
    findings: critic === "visual" && firstSlide
      ? [{
        id: "advisory-observed-capacity",
        severity: "info",
        category: "template_fidelity",
        slideId: firstSlide.slideId,
        message: "Mock visual review remains advisory; deterministic geometry is authoritative",
        evidenceArtifactIds: parsed.renderEvidenceRefs.slice(0, 1).map((ref) => ref.artifactId),
      }]
      : [],
  });
}

function runRepairPlanner(input: unknown) {
  const parsed = repairPlannerInputSchema.parse(input);
  return repairPlanSchema.parse({
    version: "v1",
    variant: parsed.variant,
    round: parsed.round,
    status: "no_repair",
    operations: [],
  });
}

function runFinalJury(input: unknown) {
  const parsed = finalJuryInputSchema.parse(input);
  const variants: VariantId[] = ["compact", "balanced", "visual"];
  const tiePriority: Record<VariantId, number> = { balanced: 0, compact: 1, visual: 2 };
  const exactSet = (entries: Array<{ variant: VariantId }>, expectedPerVariant: number, name: string) => {
    for (const variant of variants) {
      if (entries.filter((entry) => entry.variant === variant).length !== expectedPerVariant) {
        throw new Error(`Final jury requires ${expectedPerVariant} ${name} for ${variant}`);
      }
    }
  };
  exactSet(parsed.variants, 1, "variant plan");
  exactSet(parsed.audits, 1, "audit");
  exactSet(parsed.critiques, 2, "critiques");
  exactSet(parsed.repairs, 1, "repair plan");
  if (parsed.evidenceCoverage.grounded > parsed.evidenceCoverage.total) {
    throw new Error("Final jury evidence coverage exceeds total claims");
  }
  const canonicalSlides = parsed.variants[0].slides.map((slide) => slide.slideId);
  if (new Set(canonicalSlides).size !== canonicalSlides.length) {
    throw new Error("Final jury variant plan has duplicate slides");
  }
  for (const plan of parsed.variants) {
    const slideIds = plan.slides.map((slide) => slide.slideId);
    if (slideIds.length !== canonicalSlides.length || slideIds.some((id, index) => id !== canonicalSlides[index])) {
      throw new Error(`Final jury slide identities disagree for ${plan.variant}`);
    }
  }
  const issues: string[] = [];
  const coverageScore = parsed.evidenceCoverage.total === 0
    ? 0
    : Math.round(100 * parsed.evidenceCoverage.grounded / parsed.evidenceCoverage.total);
  if (parsed.evidenceCoverage.grounded < parsed.evidenceCoverage.total) {
    issues.push(`Evidence coverage: ${parsed.evidenceCoverage.grounded}/${parsed.evidenceCoverage.total} grounded`);
  }
  const rankedVariants = variants.map((variant) => {
    const audit = parsed.audits.find((entry) => entry.variant === variant)!;
    const critiques = parsed.critiques.filter((entry) => entry.variant === variant);
    const repair = parsed.repairs.find((entry) => entry.variant === variant)!;
    const findings = critiques.flatMap((critique) => critique.findings);
    const knownSlides = new Set(canonicalSlides);
    if (findings.some((finding) => !knownSlides.has(finding.slideId))
      || repair.operations.some((operation) => !knownSlides.has(operation.slideId))) {
      throw new Error(`Final jury has foreign slide references for ${variant}`);
    }
    const counts = {
      info: findings.filter((finding) => finding.severity === "info").length,
      warning: findings.filter((finding) => finding.severity === "warning").length,
      error: findings.filter((finding) => finding.severity === "error").length,
    };
    const deterministicAuditScore = Math.max(0, 100 - audit.issueIds.length * 12);
    const advisoryScore = Math.max(0, 100 - counts.info * 2 - counts.warning * 12
      - counts.error * 24 - repair.operations.length * 8);
    const score = Math.round(deterministicAuditScore * 0.6 + advisoryScore * 0.3 + coverageScore * 0.1);
    for (const issueId of [...audit.issueIds].sort()) {
      issues.push(`${variant}: deterministic audit issue ${issueId}`);
    }
    for (const finding of findings.filter((item) => item.severity !== "info")
      .sort((left, right) => left.slideId.localeCompare(right.slideId) || left.id.localeCompare(right.id))) {
      issues.push(bounded(`${variant} ${finding.slideId}: ${finding.message}`, 240));
    }
    for (const operation of [...repair.operations].sort((left, right) => left.id.localeCompare(right.id))) {
      issues.push(bounded(`${variant} ${operation.slideId}: pending ${operation.operation} — ${operation.rationale}`, 240));
    }
    return {
      variant,
      score,
      deterministicAuditScore,
      advisoryScore,
      rationale: `${audit.issueIds.length} audit issues; ${counts.warning} warnings, ${counts.error} errors, ${counts.info} info; ${repair.operations.length} repair operations; evidence ${parsed.evidenceCoverage.grounded}/${parsed.evidenceCoverage.total}`,
    };
  }).sort((left, right) => right.score - left.score || tiePriority[left.variant] - tiePriority[right.variant]);
  return variantRankingSchema.parse({
    version: "v1",
    rankedVariants,
    recommendedVariant: rankedVariants[0].variant,
    blockingReasons: [],
    remainingUserVisibleIssues: unique(issues.sort()).slice(0, 20),
  });
}

/**
 * Deterministic local role runner. The optional override exists only for
 * contract tests; it is validated before it can enter the artifact graph.
 */
export function runDeterministicMockAgent(id: AgentId, input: unknown, override?: unknown): AgentOutput {
  const parsedId = agentIdSchema.parse(id);
  validateAgentInput(parsedId, input);
  const generated = override ?? (() => {
    switch (parsedId) {
      case "template-analyst": return runTemplateAnalyst(input);
      case "evidence-analyst": return runEvidenceAnalyst(input);
      case "narrative-architect": return runNarrativeArchitect(input);
      case "visual-director": return runVisualDirector(input);
      case "variant-designer-compact": return runVariantDesigner(input, "compact");
      case "variant-designer-balanced": return runVariantDesigner(input, "balanced");
      case "variant-designer-visual": return runVariantDesigner(input, "visual");
      case "semantic-critic": return runCritic(input, "semantic");
      case "visual-critic": return runCritic(input, "visual");
      case "repair-planner": return runRepairPlanner(input);
      case "final-jury": return runFinalJury(input);
    }
  })();
  return validateAgentOutput(parsedId, generated);
}
