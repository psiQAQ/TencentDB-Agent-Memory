import { createHash } from "node:crypto";

import type { SkillCore } from "../core/skill/skill-core.js";
import type { Skill } from "../core/skill/types.js";
import type { IMemoryStore } from "../core/store/types.js";
import type { StorageAdapter } from "../core/storage/adapter.js";
import { parseProfileIsolationScope } from "../core/profile/profile-sync.js";
import { MemoryGenerationLogStore } from "../core/memory-generation-log/store.js";
import type { IMetadataStore } from "../metadata/store/interface.js";
import type { IntegrityFinding } from "../metadata/types.js";
import { clearChatMemoryContentResilient } from "./chat-memory-handlers.js";
import type { Logger } from "../core/types.js";

interface RuntimeScope {
  teamId: string;
  agentId: string;
  ownerUserIds: Set<string>;
  l0Count: number;
  l1Count: number;
  jsonlCount: number;
  profileObjectCount: number;
  generationLogCount: number;
  sizeBytes: number;
}

export interface OperationalIntegrityDeps {
  metadataStore: IMetadataStore;
  memoryStore: IMemoryStore;
  storage: StorageAdapter;
  skillCore?: SkillCore;
  instanceId: string;
  logger: Logger;
}

function finding(input: Omit<IntegrityFinding, "finding_id" | "fingerprint" | "first_seen_at" | "last_seen_at">): IntegrityFinding {
  const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const now = new Date().toISOString();
  return {
    ...input,
    finding_id: `runtime-${fingerprint.slice(0, 20)}`,
    fingerprint,
    first_seen_at: now,
    last_seen_at: now,
  };
}

function getScope(map: Map<string, RuntimeScope>, teamId: string, agentId: string): RuntimeScope {
  const key = `${teamId}\0${agentId}`;
  const current = map.get(key) ?? {
    teamId,
    agentId,
    ownerUserIds: new Set<string>(),
    l0Count: 0,
    l1Count: 0,
    jsonlCount: 0,
    profileObjectCount: 0,
    generationLogCount: 0,
    sizeBytes: 0,
  };
  map.set(key, current);
  return current;
}

async function listSkills(core?: SkillCore): Promise<Skill[]> {
  if (!core) return [];
  const output: Skill[] = [];
  let offset = 0;
  do {
    const page = await core.list({
      filters: { status: ["active", "archived"] },
      pagination: { limit: 100, offset },
    });
    output.push(...page.items);
    offset += page.items.length;
    if (page.items.length === 0 || output.length >= page.total) break;
  } while (true);
  return output;
}

async function collectRuntimeScopes(deps: OperationalIntegrityDeps): Promise<Map<string, RuntimeScope>> {
  const scopes = new Map<string, RuntimeScope>();
  if (deps.memoryStore.listMemoryIntegrityScopes) {
    for (const item of await deps.memoryStore.listMemoryIntegrityScopes()) {
      const scope = getScope(scopes, item.teamId, item.agentId);
      item.ownerUserIds.forEach((owner) => scope.ownerUserIds.add(owner));
      scope.l0Count += item.l0Count;
      scope.l1Count += item.l1Count;
    }
  }

  for (const prefix of ["conversations/", "records/"]) {
    for (const entry of await deps.storage.readdir(prefix, ".jsonl")) {
      if (entry.isDirectory) continue;
      const raw = await deps.storage.readFile(entry.key);
      if (raw === null) continue;
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let row: Record<string, unknown>;
        try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        const teamId = String(row.teamId ?? row.team_id ?? "");
        const agentId = String(row.agentId ?? row.agent_id ?? "");
        if (!teamId || !agentId) continue;
        const scope = getScope(scopes, teamId, agentId);
        const owner = String(row.ownerUserId ?? row.owner_user_id ?? row.userId ?? row.user_id ?? "");
        if (owner) scope.ownerUserIds.add(owner);
        scope.jsonlCount++;
      }
    }
  }

  const profilePage = await deps.storage.readdirPage("profiles/", { recursive: true, maxKeys: 100_000 });
  for (const entry of profilePage.entries) {
    if (entry.isDirectory) continue;
    const segment = entry.key.slice("profiles/".length).split("/", 1)[0] ?? "";
    const parsed = parseProfileIsolationScope(decodeURIComponent(segment));
    if (!parsed?.teamId || !parsed.agentId) continue;
    const scope = getScope(scopes, parsed.teamId, parsed.agentId);
    scope.profileObjectCount++;
    scope.sizeBytes += entry.size;
  }

  for (const item of await new MemoryGenerationLogStore(deps.storage, deps.instanceId).listIntegrityScopes()) {
    const scope = getScope(scopes, item.teamId, item.agentId);
    scope.generationLogCount += item.count;
    scope.sizeBytes += item.sizeBytes;
  }
  return scopes;
}

export async function scanOperationalIntegrity(deps: OperationalIntegrityDeps): Promise<IntegrityFinding[]> {
  const findings: IntegrityFinding[] = [];
  const scopes = await collectRuntimeScopes(deps);
  for (const scope of scopes.values()) {
    const [team, agent] = await Promise.all([
      deps.metadataStore.getTeamById(scope.teamId),
      deps.metadataStore.getAgentById(scope.agentId),
    ]);
    if (team && agent && agent.team_id === scope.teamId) continue;
    const owner = [...scope.ownerUserIds][0] ?? null;
    findings.push(finding({
      category: "operational_orphan",
      source_service: "MemoryCoreRuntime",
      resource_type: "chat_memory_runtime",
      resource_id: `${scope.teamId}/${scope.agentId}`,
      team_id: scope.teamId,
      owner_user_id: owner,
      reason: !team ? "runtime_scope_team_missing" : "runtime_scope_agent_missing",
      allowed_actions: ["inspect", "purge"],
      name: `Chat Memory runtime (${scope.agentId})`,
      status: "orphaned",
      item_count: scope.l0Count + scope.l1Count + scope.jsonlCount
        + scope.profileObjectCount + scope.generationLogCount,
      size_bytes: scope.sizeBytes,
    }));
  }

  for (const skill of await listSkills(deps.skillCore)) {
    const [team, agent, asset] = await Promise.all([
      deps.metadataStore.getTeamById(skill.team_id),
      deps.metadataStore.getAgentById(skill.owner_agent_id),
      deps.metadataStore.getAssetById(skill.skill_id),
    ]);
    if (team && agent && agent.team_id === skill.team_id && asset) continue;
    const operational = !team || !agent;
    findings.push(finding({
      category: operational ? "operational_orphan" : "recoverable_dependency",
      source_service: "MemoryCoreSkill",
      resource_type: "skill",
      resource_id: skill.skill_id,
      team_id: skill.team_id || null,
      owner_user_id: skill.user_id || null,
      reason: !team ? "skill_team_missing" : !agent ? "skill_owner_agent_missing" : "skill_metadata_missing",
      allowed_actions: operational ? ["inspect", "purge"] : ["inspect"],
      name: skill.name,
      status: skill.status,
      item_count: 1,
      size_bytes: skill.manifest.reduce((sum, item) => sum + item.size_bytes, Buffer.byteLength(skill.content, "utf8")),
    }));
  }
  return findings;
}

export async function purgeOperationalIntegrity(
  deps: OperationalIntegrityDeps,
  requested: Array<{ finding_id: string; fingerprint: string }>,
): Promise<{ deleted: string[]; failed: Array<{ finding_id: string; reason: string }> }> {
  const fresh = new Map((await scanOperationalIntegrity(deps)).map((item) => [item.finding_id, item]));
  const skills = new Map((await listSkills(deps.skillCore)).map((item) => [item.skill_id, item]));
  const deleted: string[] = [];
  const failed: Array<{ finding_id: string; reason: string }> = [];
  for (const item of requested) {
    const current = fresh.get(item.finding_id);
    if (!current || current.fingerprint !== item.fingerprint) {
      failed.push({ finding_id: item.finding_id, reason: "stale_integrity_scan" });
      continue;
    }
    if (!current.allowed_actions.includes("purge")) {
      failed.push({ finding_id: item.finding_id, reason: "finding_not_purgable" });
      continue;
    }
    try {
      if (current.resource_type === "chat_memory_runtime") {
        if (!current.team_id) throw new Error("runtime finding has no team scope");
        const agentId = current.resource_id.slice(current.resource_id.indexOf("/") + 1);
        await clearChatMemoryContentResilient({
          store: deps.memoryStore,
          storage: deps.storage,
          teamId: current.team_id,
          agentId,
          instanceId: deps.instanceId,
          logger: deps.logger,
        });
      } else if (current.resource_type === "skill") {
        const skill = skills.get(current.resource_id);
        if (!skill || !deps.skillCore) throw new Error("skill backing changed");
        await deps.skillCore.delete({
          skill_id: skill.skill_id,
          team_id: skill.team_id,
          agent_id: skill.owner_agent_id,
          expected_version: skill.version,
        });
      } else {
        throw new Error("unsupported operational finding");
      }
      deleted.push(item.finding_id);
    } catch (error) {
      failed.push({
        finding_id: item.finding_id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { deleted, failed };
}
