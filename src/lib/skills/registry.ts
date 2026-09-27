import registryJson from "../../../skills/registry.json";
import { skillRegistrySchema, type SkillRegistry, type SkillRegistryEntry, type SkillVersions } from "./types";

const registry = skillRegistrySchema.parse(registryJson);

export function getSkillRegistry(): SkillRegistry {
  return registry;
}

export function getSkill(id: string): SkillRegistryEntry {
  const skill = registry.skills.find((candidate) => candidate.id === id);
  if (!skill) throw new Error(`Unknown skill: ${id}`);
  return skill;
}

export function getActiveSkillVersions(): SkillVersions {
  return Object.fromEntries(registry.skills.map((skill) => [skill.id, skill.version])) as SkillVersions;
}
