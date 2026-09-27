import registryJson from "../../agents/registry.json";
import { agentIdSchema, agentVersionSchema, type AgentId } from "./agent-contracts";
import { z } from "zod";

const agentRegistryEntrySchema = z.object({
  id: agentIdSchema,
  version: agentVersionSchema,
  status: z.literal("executable"),
  contractPath: z.string().regex(/^agents\/[a-z0-9-]+\/v1\/contract\.json$/),
  promptPath: z.string().regex(/^prompts\/agents\/[a-z0-9-]+\/v1\/system\.md$/),
}).strict();

export const agentRegistrySchema = z.object({
  version: z.literal(1),
  agents: z.array(agentRegistryEntrySchema).length(11).superRefine((agents, context) => {
    const ids = new Set<string>();
    for (const [index, agent] of agents.entries()) {
      if (ids.has(agent.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: [index, "id"], message: "Agent ids must be unique" });
      ids.add(agent.id);
      if (!agent.contractPath.startsWith(`agents/${agent.id}/`)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [index, "contractPath"], message: "Contract path must match agent id" });
      }
      if (!agent.promptPath.startsWith(`prompts/agents/${agent.id}/`)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [index, "promptPath"], message: "Prompt path must match agent id" });
      }
    }
  }),
}).strict();

export type AgentRegistry = z.infer<typeof agentRegistrySchema>;
export type AgentRegistryEntry = AgentRegistry["agents"][number];

const registry = agentRegistrySchema.parse(registryJson);

export function getAgentRegistry(): AgentRegistry {
  return registry;
}

export function getAgent(id: AgentId): AgentRegistryEntry {
  const agent = registry.agents.find((candidate) => candidate.id === id);
  if (!agent) throw new Error(`Unknown agent: ${id}`);
  return agent;
}

export function getActiveAgentVersions(): Record<AgentId, "v1"> {
  return Object.fromEntries(registry.agents.map((agent) => [agent.id, agent.version])) as Record<AgentId, "v1">;
}
