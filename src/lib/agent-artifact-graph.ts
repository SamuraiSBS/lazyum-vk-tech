import { z } from "zod";
import {
  agentRefSchema,
  critiqueReportSchema,
  deterministicAuditOutputSchema,
  deterministicRenderOutputSchema,
  evidencePackSchema,
  narrativePlanSchema,
  repairPlanSchema,
  safeArtifactRefSchema,
  systemProducerSchema,
  templateInterpretationSchema,
  validateAgentOutput,
  variantPlanSchema,
  variantRankingSchema,
  visualSpecPackSchema,
  type AgentId,
  type AgentOutput,
  type SafeArtifactRef,
  type SystemProducer,
} from "./agent-contracts";

const persistedOutputSchema = z.union([
  templateInterpretationSchema,
  evidencePackSchema,
  narrativePlanSchema,
  visualSpecPackSchema,
  variantPlanSchema,
  critiqueReportSchema,
  repairPlanSchema,
  variantRankingSchema,
  deterministicRenderOutputSchema,
  deterministicAuditOutputSchema,
]);

export const persistedArtifactRecordSchema = z.object({
  ref: safeArtifactRefSchema,
  producer: z.union([agentRefSchema, systemProducerSchema]),
  parentRefs: z.array(safeArtifactRefSchema).max(32),
  output: persistedOutputSchema.nullable(),
}).strict();
export type PersistedArtifactRecord = z.infer<typeof persistedArtifactRecordSchema>;

export const agentArtifactGraphSchema = z.object({
  version: z.literal("v1"),
  artifacts: z.array(persistedArtifactRecordSchema).max(256),
}).strict().superRefine((graph, context) => {
  const ids = new Set<string>();
  for (const [index, artifact] of graph.artifacts.entries()) {
    if (ids.has(artifact.ref.artifactId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["artifacts", index, "ref", "artifactId"], message: "Artifact ids must be unique" });
    }
    ids.add(artifact.ref.artifactId);
  }
  const known = new Set(graph.artifacts.map((artifact) => artifact.ref.artifactId));
  for (const [index, artifact] of graph.artifacts.entries()) {
    for (const [parentIndex, parent] of artifact.parentRefs.entries()) {
      if (!known.has(parent.artifactId)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["artifacts", index, "parentRefs", parentIndex], message: "Parent artifact ref is missing" });
      }
      if (parent.artifactId === artifact.ref.artifactId) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["artifacts", index, "parentRefs", parentIndex], message: "Artifact cannot parent itself" });
      }
    }
  }
});
export type AgentArtifactGraph = z.infer<typeof agentArtifactGraphSchema>;

export class AgentArtifactGraphError extends Error {
  constructor(readonly code:
    | "duplicate_artifact_ref"
    | "missing_parent_ref"
    | "self_parent_ref"
    | "artifact_limit"
    | "invalid_output"
    | "invalid_system_output") {
    super(code);
    this.name = "AgentArtifactGraphError";
  }
}

/**
 * In-memory v1 graph. It has no filesystem writer: only safe references and
 * already validated JSON outputs are retained in the returned manifest.
 */
export class BoundedAgentArtifactGraph {
  private readonly records = new Map<string, PersistedArtifactRecord>();

  addInput(ref: SafeArtifactRef) {
    const parsed = safeArtifactRefSchema.parse(ref);
    this.addRecord({
      ref: parsed,
      producer: { kind: "system", id: "input", version: "v1" },
      parentRefs: [],
      output: null,
    });
    return parsed;
  }

  addAgentOutput(
    agentId: AgentId,
    ref: SafeArtifactRef,
    parentRefs: SafeArtifactRef[],
    output: unknown,
  ) {
    const parsedRef = safeArtifactRefSchema.parse(ref);
    const parsedParents = this.parseParents(parsedRef, parentRefs);
    let parsedOutput: AgentOutput;
    try {
      parsedOutput = validateAgentOutput(agentId, output);
    } catch (error) {
      throw new AgentArtifactGraphError("invalid_output");
    }
    this.addRecord({
      ref: parsedRef,
      producer: { id: agentId, version: "v1" },
      parentRefs: parsedParents,
      output: parsedOutput,
    });
    return parsedRef;
  }

  addSystemOutput(
    producerId: Exclude<SystemProducer["id"], "input">,
    ref: SafeArtifactRef,
    parentRefs: SafeArtifactRef[],
    output: unknown,
  ) {
    const parsedRef = safeArtifactRefSchema.parse(ref);
    const parsedParents = this.parseParents(parsedRef, parentRefs);
    const parsedOutput = this.parseSystemOutput(output);
    this.addRecord({
      ref: parsedRef,
      producer: { kind: "system", id: producerId, version: "v1" },
      parentRefs: parsedParents,
      output: parsedOutput,
    });
    return parsedRef;
  }

  addBinaryRender(ref: SafeArtifactRef, parentRefs: SafeArtifactRef[]) {
    const parsedRef = safeArtifactRefSchema.parse(ref);
    const parsedParents = this.parseParents(parsedRef, parentRefs);
    this.addRecord({
      ref: parsedRef,
      producer: { kind: "system", id: "deterministic-render", version: "v1" },
      parentRefs: parsedParents,
      output: null,
    });
    return parsedRef;
  }

  has(artifactId: string) {
    return this.records.has(artifactId);
  }

  get(artifactId: string) {
    return this.records.get(artifactId);
  }

  toManifest(): AgentArtifactGraph {
    return agentArtifactGraphSchema.parse({
      version: "v1",
      artifacts: [...this.records.values()].sort((left, right) => left.ref.artifactId.localeCompare(right.ref.artifactId, "en")),
    });
  }

  private parseParents(ref: SafeArtifactRef, parents: SafeArtifactRef[]) {
    const parsedParents = parents.map((parent) => safeArtifactRefSchema.parse(parent));
    for (const parent of parsedParents) {
      if (parent.artifactId === ref.artifactId) throw new AgentArtifactGraphError("self_parent_ref");
      if (!this.records.has(parent.artifactId)) throw new AgentArtifactGraphError("missing_parent_ref");
    }
    return parsedParents;
  }

  private parseSystemOutput(value: unknown) {
    try {
      return persistedOutputSchema.parse(value);
    } catch (error) {
      throw new AgentArtifactGraphError("invalid_system_output");
    }
  }

  private addRecord(record: PersistedArtifactRecord) {
    if (this.records.has(record.ref.artifactId)) throw new AgentArtifactGraphError("duplicate_artifact_ref");
    if (this.records.size >= 256) throw new AgentArtifactGraphError("artifact_limit");
    this.records.set(record.ref.artifactId, persistedArtifactRecordSchema.parse(record));
  }
}

export function createAgentArtifactGraph(inputRefs: SafeArtifactRef[]) {
  const graph = new BoundedAgentArtifactGraph();
  for (const ref of inputRefs) graph.addInput(ref);
  return graph;
}
