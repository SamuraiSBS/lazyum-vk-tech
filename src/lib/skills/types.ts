import { z } from "zod";

export const skillStatusSchema = z.enum(["executable", "planned"]);
export type SkillStatus = z.infer<typeof skillStatusSchema>;

export const skillRegistryEntrySchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  version: z.string().regex(/^v\d+$/),
  status: skillStatusSchema,
  contractPath: z.string().regex(/^skills\/[a-z0-9_-]+\/v\d+\/contract\.json$/),
}).strict();
export type SkillRegistryEntry = z.infer<typeof skillRegistryEntrySchema>;

export const skillRegistrySchema = z.object({
  version: z.literal(1),
  skills: z.array(skillRegistryEntrySchema).min(1).superRefine((skills, context) => {
    const ids = new Set<string>();
    for (const [index, skill] of skills.entries()) {
      if (ids.has(skill.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: [index, "id"], message: "Skill ids must be unique" });
      ids.add(skill.id);
    }
  }),
}).strict();
export type SkillRegistry = z.infer<typeof skillRegistrySchema>;

export type SkillVersions = Record<string, `v${number}`>;
