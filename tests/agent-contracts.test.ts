import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  agentIds,
  getAgentInputSchema,
  getAgentOutputSchema,
  safeArtifactRefSchema,
  validateAgentOutput,
} from "../src/lib/agent-contracts";
import { getAgent, getAgentRegistry } from "../src/lib/agent-registry";

describe("versioned runtime agent contracts", () => {
  it("registers every P0-12.1 role with an external contract and prompt", () => {
    const registry = getAgentRegistry();
    expect(registry.agents.map((agent) => agent.id)).toEqual([...agentIds]);
    for (const agent of registry.agents) {
      expect(getAgent(agent.id)).toEqual(agent);
      expect(JSON.parse(readFileSync(new URL(`../${agent.contractPath}`, import.meta.url), "utf8"))).toMatchObject({
        id: agent.id,
        version: "v1",
        status: "executable",
      });
      expect(readFileSync(new URL(`../${agent.promptPath}`, import.meta.url), "utf8").length).toBeGreaterThan(0);
      expect(getAgentInputSchema(agent.id)).toBeDefined();
      expect(getAgentOutputSchema(agent.id)).toBeDefined();
    }
  });

  it("uses strict safe references with bounded paths and sizes", () => {
    const valid = {
      artifactId: "artifact-input-template",
      kind: "input" as const,
      relativePath: "inputs/template.json",
      sha256: "a".repeat(64),
      byteSize: 12,
    };
    expect(safeArtifactRefSchema.parse(valid)).toEqual(valid);
    expect(() => safeArtifactRefSchema.parse({ ...valid, relativePath: "../../secret.txt" })).toThrow();
    expect(() => safeArtifactRefSchema.parse({ ...valid, absolutePath: "C:\\secret.txt" })).toThrow();
    expect(() => safeArtifactRefSchema.parse({ ...valid, byteSize: 2_000_001 })).toThrow();
  });

  it("rejects unknown output fields and authority-shaped output", () => {
    expect(() => validateAgentOutput("template-analyst", {
      version: "v1",
      layoutFamilies: [],
      typography: { headingRoles: [], bodyRoles: [], densityGuidance: "balanced" },
      spacingGuidance: "regular",
      prohibitedCompositions: [],
      risks: [],
      exportDecision: "allow",
    })).toThrow();
    expect(() => validateAgentOutput("semantic-critic", {
      version: "v1",
      variant: "balanced",
      advisoryOnly: true,
      findings: [],
      fix: { operation: "rewrite" },
    })).toThrow();
  });
});
