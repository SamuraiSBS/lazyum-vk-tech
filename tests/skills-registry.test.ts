import { describe, expect, it } from "vitest";
import semanticAuditContract from "../skills/semantic-audit/v1/contract.json";
import { getActiveSkillVersions, getSkill, getSkillRegistry } from "../src/lib/skills/registry";

describe("versioned skills registry", () => {
  it("exposes one stable v1 contract for each P0-11 skill", () => {
    expect(getSkillRegistry().skills).toEqual([
      { id: "grounded-deck-planner", version: "v1", status: "executable", contractPath: "skills/grounded-deck-planner/v1/contract.json" },
      { id: "search_evidence", version: "v1", status: "executable", contractPath: "skills/search_evidence/v1/contract.json" },
      { id: "data-visual-spec", version: "v1", status: "executable", contractPath: "skills/data-visual-spec/v1/contract.json" },
      { id: "semantic-audit", version: "v1", status: "executable", contractPath: "skills/semantic-audit/v1/contract.json" },
    ]);
    expect(getActiveSkillVersions()).toEqual({
      "grounded-deck-planner": "v1",
      search_evidence: "v1",
      "data-visual-spec": "v1",
      "semantic-audit": "v1",
    });
    expect(getSkill("data-visual-spec")).toMatchObject({
      status: "executable",
      contractPath: "skills/data-visual-spec/v1/contract.json",
    });
    expect(getSkill("semantic-audit")).toMatchObject({
      status: "executable",
      contractPath: "skills/semantic-audit/v1/contract.json",
    });
    expect(semanticAuditContract).toMatchObject({
      id: "semantic-audit",
      version: "v1",
      status: "executable",
      entrypoint: "src/lib/skills/semantic-audit.ts#normalizeSemanticAudit",
    });
    expect(() => getSkill("unknown")).toThrow("Unknown skill");
  });
});
