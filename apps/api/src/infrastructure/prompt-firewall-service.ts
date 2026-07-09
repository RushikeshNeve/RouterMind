import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export type PolicyRuleType =
  | "secret_detection"
  | "pii_detection"
  | "prompt_injection"
  | "dangerous_command"
  | "blocked_keyword"
  | "max_prompt_size"
  | "custom_regex";
export type PolicyAction = "block" | "warn" | "redact";
export type FirewallAction = "allow" | "warn" | "redact" | "block";
export type FirewallSeverity = "low" | "medium" | "high" | "critical";

export interface ChatMessageForFirewall {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface PolicyRuleRecord {
  readonly id: string;
  readonly userId?: string | null;
  readonly name: string;
  readonly type: PolicyRuleType;
  readonly pattern?: string | null;
  readonly action: PolicyAction;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface FirewallEventRecord {
  readonly id: string;
  readonly userId: string;
  readonly workspaceId?: string | null;
  readonly requestLogId?: string | null;
  readonly ruleId?: string | null;
  readonly type: string;
  readonly action: PolicyAction;
  readonly severity: FirewallSeverity;
  readonly matchedText?: string | null;
  readonly message: string;
  readonly createdAt: Date;
}

export interface FirewallEventInput {
  readonly ruleId?: string | null;
  readonly type: string;
  readonly action: PolicyAction;
  readonly severity: FirewallSeverity;
  readonly matchedText?: string | null;
  readonly message: string;
}

export interface FirewallInspectionResult {
  readonly allowed: boolean;
  readonly action: FirewallAction;
  readonly events: readonly FirewallEventInput[];
  readonly sanitizedMessages: readonly ChatMessageForFirewall[];
}

export interface FirewallStats {
  readonly totalEvents: number;
  readonly blockedRequests: number;
  readonly redactedRequests: number;
  readonly warnings: number;
  readonly topRuleTypes: readonly {
    readonly type: string;
    readonly count: number;
  }[];
}

export interface PromptFirewallService {
  inspectRequest(input: {
    readonly userId: string;
    readonly workspaceId?: string | null;
    readonly messages: readonly ChatMessageForFirewall[];
  }): Promise<FirewallInspectionResult>;
  recordEvents(input: {
    readonly userId: string;
    readonly workspaceId?: string | null;
    readonly requestLogId?: string | null;
    readonly events: readonly FirewallEventInput[];
  }): Promise<readonly FirewallEventRecord[]>;
  listEvents(userId?: string): Promise<readonly FirewallEventRecord[]>;
  listRules(userId?: string): Promise<readonly PolicyRuleRecord[]>;
  createRule(input: {
    readonly userId?: string | null;
    readonly name: string;
    readonly type: PolicyRuleType;
    readonly pattern?: string | null;
    readonly action: PolicyAction;
    readonly isActive?: boolean;
  }): Promise<PolicyRuleRecord>;
  updateRule(
    ruleId: string,
    input: Partial<{
      readonly name: string;
      readonly type: PolicyRuleType;
      readonly pattern: string | null;
      readonly action: PolicyAction;
      readonly isActive: boolean;
    }>,
  ): Promise<PolicyRuleRecord | undefined>;
  deleteRule(ruleId: string): Promise<boolean>;
  stats(userId?: string): Promise<FirewallStats>;
}

interface CompiledRule {
  readonly id?: string;
  readonly userId?: string | null;
  readonly name: string;
  readonly type: PolicyRuleType;
  readonly pattern?: string | null;
  readonly action: PolicyAction;
  readonly severity: FirewallSeverity;
  readonly regex?: RegExp;
  readonly maxCharacters?: number;
  readonly message: string;
  readonly redact?: boolean;
}

export class InMemoryPromptFirewallService implements PromptFirewallService {
  private readonly rules = new Map<string, PolicyRuleRecord>();
  private readonly eventRows: FirewallEventRecord[] = [];

  async inspectRequest(input: {
    readonly userId: string;
    readonly messages: readonly ChatMessageForFirewall[];
  }): Promise<FirewallInspectionResult> {
    return inspectWithRules(input.messages, await this.activeRules(input.userId));
  }

  recordEvents(input: {
    readonly userId: string;
    readonly workspaceId?: string | null;
    readonly requestLogId?: string | null;
    readonly events: readonly FirewallEventInput[];
  }): Promise<readonly FirewallEventRecord[]> {
    const now = new Date();
    const rows = input.events.map((event) => ({
      id: `firewall_event_${this.eventRows.length + 1}_${randomUUID().slice(0, 8)}`,
      userId: input.userId,
      workspaceId: input.workspaceId ?? null,
      requestLogId: input.requestLogId ?? null,
      ruleId: event.ruleId ?? null,
      type: event.type,
      action: event.action,
      severity: event.severity,
      matchedText: sanitizeMatchedText(event.matchedText ?? null),
      message: event.message,
      createdAt: now,
    }));
    this.eventRows.push(...rows);
    return Promise.resolve(rows);
  }

  listEvents(userId?: string): Promise<readonly FirewallEventRecord[]> {
    return Promise.resolve(
      this.eventRows
        .filter((event) => !userId || event.userId === userId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    );
  }

  listRules(userId?: string): Promise<readonly PolicyRuleRecord[]> {
    return Promise.resolve(
      [...this.rules.values()]
        .filter((rule) => userId === undefined || rule.userId === null || rule.userId === userId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  }

  createRule(input: {
    readonly userId?: string | null;
    readonly name: string;
    readonly type: PolicyRuleType;
    readonly pattern?: string | null;
    readonly action: PolicyAction;
    readonly isActive?: boolean;
  }): Promise<PolicyRuleRecord> {
    const now = new Date();
    const rule: PolicyRuleRecord = {
      id: `policy_rule_${this.rules.size + 1}`,
      userId: input.userId ?? null,
      name: input.name,
      type: input.type,
      pattern: input.pattern ?? null,
      action: input.action,
      isActive: input.isActive ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.rules.set(rule.id, rule);
    return Promise.resolve(rule);
  }

  updateRule(
    ruleId: string,
    input: Partial<{
      readonly name: string;
      readonly type: PolicyRuleType;
      readonly pattern: string | null;
      readonly action: PolicyAction;
      readonly isActive: boolean;
    }>,
  ): Promise<PolicyRuleRecord | undefined> {
    const existing = this.rules.get(ruleId);
    if (!existing) {
      return Promise.resolve(undefined);
    }
    const updated = { ...existing, ...input, updatedAt: new Date() };
    this.rules.set(ruleId, updated);
    return Promise.resolve(updated);
  }

  deleteRule(ruleId: string): Promise<boolean> {
    return Promise.resolve(this.rules.delete(ruleId));
  }

  async stats(userId?: string): Promise<FirewallStats> {
    return buildStats(await this.listEvents(userId));
  }

  private async activeRules(userId: string): Promise<readonly CompiledRule[]> {
    return [
      ...builtInRules,
      ...(await this.listRules(userId))
        .filter((rule) => rule.isActive)
        .map(toCompiledCustomRule)
        .filter((rule): rule is CompiledRule => rule !== undefined),
    ];
  }
}

export class PrismaPromptFirewallService implements PromptFirewallService {
  constructor(private readonly prisma: PrismaClient) {}

  async inspectRequest(input: {
    readonly userId: string;
    readonly workspaceId?: string | null;
    readonly messages: readonly ChatMessageForFirewall[];
  }): Promise<FirewallInspectionResult> {
    return inspectWithRules(input.messages, [
      ...builtInRules,
      ...(await this.listRules(input.userId))
        .filter((rule) => rule.isActive)
        .map(toCompiledCustomRule)
        .filter((rule): rule is CompiledRule => rule !== undefined),
    ]);
  }

  async recordEvents(input: {
    readonly userId: string;
    readonly workspaceId?: string | null;
    readonly requestLogId?: string | null;
    readonly events: readonly FirewallEventInput[];
  }): Promise<readonly FirewallEventRecord[]> {
    const rows: FirewallEventRecord[] = [];
    for (const event of input.events) {
      const [row] = await this.prisma.$queryRaw<FirewallEventRecord[]>`
        INSERT INTO "FirewallEvent" (
          "id",
          "userId",
          "workspaceId",
          "requestLogId",
          "ruleId",
          "type",
          "action",
          "severity",
          "matchedText",
          "message"
        )
        VALUES (
          ${randomUUID()},
          ${input.userId},
          ${input.workspaceId ?? null},
          ${input.requestLogId ?? null},
          ${event.ruleId ?? null},
          ${event.type},
          ${event.action},
          ${event.severity},
          ${sanitizeMatchedText(event.matchedText ?? null)},
          ${event.message}
        )
        RETURNING *
      `;
      if (row) {
        rows.push(normalizeEventRow(row));
      }
    }
    return rows;
  }

  async listEvents(userId?: string): Promise<readonly FirewallEventRecord[]> {
    const rows = userId
      ? await this.prisma.$queryRaw<FirewallEventRecord[]>`
          SELECT * FROM "FirewallEvent"
          WHERE "userId" = ${userId}
          ORDER BY "createdAt" DESC
        `
      : await this.prisma.$queryRaw<FirewallEventRecord[]>`
          SELECT * FROM "FirewallEvent"
          ORDER BY "createdAt" DESC
        `;
    return rows.map(normalizeEventRow);
  }

  async listRules(userId?: string): Promise<readonly PolicyRuleRecord[]> {
    const rows = userId
      ? await this.prisma.$queryRaw<PolicyRuleRecord[]>`
          SELECT * FROM "PolicyRule"
          WHERE "userId" IS NULL OR "userId" = ${userId}
          ORDER BY "name" ASC
        `
      : await this.prisma.$queryRaw<PolicyRuleRecord[]>`
          SELECT * FROM "PolicyRule"
          ORDER BY "name" ASC
        `;
    return rows.map(normalizeRuleRow);
  }

  async createRule(input: {
    readonly userId?: string | null;
    readonly name: string;
    readonly type: PolicyRuleType;
    readonly pattern?: string | null;
    readonly action: PolicyAction;
    readonly isActive?: boolean;
  }): Promise<PolicyRuleRecord> {
    const [row] = await this.prisma.$queryRaw<PolicyRuleRecord[]>`
      INSERT INTO "PolicyRule" ("id", "userId", "name", "type", "pattern", "action", "isActive", "updatedAt")
      VALUES (
        ${randomUUID()},
        ${input.userId ?? null},
        ${input.name},
        ${input.type},
        ${input.pattern ?? null},
        ${input.action},
        ${input.isActive ?? true},
        ${new Date()}
      )
      RETURNING *
    `;
    if (!row) {
      throw new Error("Policy rule creation failed.");
    }
    return normalizeRuleRow(row);
  }

  async updateRule(
    ruleId: string,
    input: Partial<{
      readonly name: string;
      readonly type: PolicyRuleType;
      readonly pattern: string | null;
      readonly action: PolicyAction;
      readonly isActive: boolean;
    }>,
  ): Promise<PolicyRuleRecord | undefined> {
    const existing = (await this.listRules()).find((rule) => rule.id === ruleId);
    if (!existing) {
      return undefined;
    }
    const next = { ...existing, ...input };
    const [row] = await this.prisma.$queryRaw<PolicyRuleRecord[]>`
      UPDATE "PolicyRule"
      SET
        "name" = ${next.name},
        "type" = ${next.type},
        "pattern" = ${next.pattern ?? null},
        "action" = ${next.action},
        "isActive" = ${next.isActive},
        "updatedAt" = ${new Date()}
      WHERE "id" = ${ruleId}
      RETURNING *
    `;
    return row ? normalizeRuleRow(row) : undefined;
  }

  async deleteRule(ruleId: string): Promise<boolean> {
    const deleted = await this.prisma.$executeRaw`
      DELETE FROM "PolicyRule"
      WHERE "id" = ${ruleId}
    `;
    return Number(deleted) > 0;
  }

  async stats(userId?: string): Promise<FirewallStats> {
    return buildStats(await this.listEvents(userId));
  }
}

const builtInRules: readonly CompiledRule[] = [
  {
    name: "OpenAI API key detection",
    type: "secret_detection",
    action: "redact",
    severity: "critical",
    regex: /\bsk-[A-Za-z0-9_-]{12,}\b/g,
    message: "Secret-like OpenAI API key detected and redacted.",
  },
  {
    name: "GitHub token detection",
    type: "secret_detection",
    action: "redact",
    severity: "critical",
    regex: /\bghp_[A-Za-z0-9_]{20,}\b/g,
    message: "Secret-like GitHub token detected and redacted.",
  },
  {
    name: "AWS access key detection",
    type: "secret_detection",
    action: "redact",
    severity: "critical",
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    message: "Secret-like AWS access key detected and redacted.",
  },
  {
    name: "Bearer token detection",
    type: "secret_detection",
    action: "redact",
    severity: "high",
    regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
    message: "Bearer token detected and redacted.",
  },
  {
    name: "Email PII detection",
    type: "pii_detection",
    action: "warn",
    severity: "medium",
    regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    message: "Email address detected in prompt.",
  },
  {
    name: "Phone PII detection",
    type: "pii_detection",
    action: "warn",
    severity: "medium",
    regex: /(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3,5}\)?[-.\s]?)\d{3,4}[-.\s]?\d{4}\b/g,
    message: "Phone-number-like PII detected in prompt.",
  },
  {
    name: "Indian PAN detection",
    type: "pii_detection",
    action: "warn",
    severity: "medium",
    regex: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g,
    message: "PAN-like identifier detected in prompt.",
  },
  {
    name: "Aadhaar detection",
    type: "pii_detection",
    action: "redact",
    severity: "high",
    regex: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    message: "Aadhaar-like identifier detected and redacted.",
  },
  {
    name: "Prompt injection detection",
    type: "prompt_injection",
    action: "block",
    severity: "high",
    regex:
      /\b(ignore previous instructions|reveal system prompt|developer message|bypass policy|jailbreak)\b/gi,
    message: "Prompt injection pattern detected.",
  },
  {
    name: "Dangerous command detection",
    type: "dangerous_command",
    action: "block",
    severity: "critical",
    regex: /\b(rm\s+-rf\s+\/|format disk|delete system32|steal credentials|exfiltrate secrets)\b/gi,
    message: "Dangerous command or credential exfiltration request detected.",
  },
  {
    name: "Suspicious tool-use instruction detection",
    type: "prompt_injection",
    action: "warn",
    severity: "medium",
    regex: /\b(call tool|invoke tool|use tool).*\b(without approval|secretly|hidden)\b/gi,
    message: "Suspicious tool-use instruction detected.",
  },
  {
    name: "Maximum prompt size",
    type: "max_prompt_size",
    action: "block",
    severity: "medium",
    maxCharacters: 120_000,
    message: "Prompt exceeds the maximum allowed size.",
  },
];

function inspectWithRules(
  messages: readonly ChatMessageForFirewall[],
  rules: readonly CompiledRule[],
): FirewallInspectionResult {
  const events: FirewallEventInput[] = [];
  let sanitizedMessages = messages.map((message) => ({ ...message }));

  for (const rule of rules) {
    if (rule.type === "max_prompt_size") {
      const totalCharacters = sanitizedMessages.reduce(
        (total, message) => total + message.content.length,
        0,
      );
      if (totalCharacters > (rule.maxCharacters ?? 120_000)) {
        events.push(toEvent(rule, `${totalCharacters}`));
      }
      continue;
    }

    if (!rule.regex) {
      continue;
    }

    sanitizedMessages = sanitizedMessages.map((message) => {
      rule.regex!.lastIndex = 0;
      const matches = [...message.content.matchAll(rule.regex!)];
      if (matches.length === 0) {
        return message;
      }
      for (const match of matches) {
        events.push(toEvent(rule, match[0]));
      }
      if (rule.action !== "redact") {
        return message;
      }
      rule.regex!.lastIndex = 0;
      return {
        ...message,
        content: message.content.replace(rule.regex!, "[REDACTED]"),
      };
    });
  }

  const action = aggregateAction(events);
  return {
    allowed: action !== "block",
    action,
    events,
    sanitizedMessages,
  };
}

function toEvent(rule: CompiledRule, matchedText?: string): FirewallEventInput {
  return {
    ruleId: rule.id,
    type: rule.type,
    action: rule.action,
    severity: rule.severity,
    matchedText: sanitizeMatchedText(matchedText ?? null),
    message: rule.message,
  };
}

function aggregateAction(events: readonly FirewallEventInput[]): FirewallAction {
  if (events.some((event) => event.action === "block")) {
    return "block";
  }
  if (events.some((event) => event.action === "redact")) {
    return "redact";
  }
  if (events.some((event) => event.action === "warn")) {
    return "warn";
  }
  return "allow";
}

function toCompiledCustomRule(rule: PolicyRuleRecord): CompiledRule | undefined {
  if (rule.type === "max_prompt_size") {
    return {
      id: rule.id,
      userId: rule.userId,
      name: rule.name,
      type: rule.type,
      pattern: rule.pattern,
      action: rule.action,
      severity: rule.action === "block" ? "high" : "medium",
      maxCharacters: Number(rule.pattern ?? 120_000),
      message: `Policy rule matched: ${rule.name}.`,
    };
  }

  const regex = compileRuleRegex(rule);
  if (!regex) {
    return undefined;
  }
  return {
    id: rule.id,
    userId: rule.userId,
    name: rule.name,
    type: rule.type,
    pattern: rule.pattern,
    action: rule.action,
    severity: rule.action === "block" ? "high" : "medium",
    regex,
    message: `Policy rule matched: ${rule.name}.`,
  };
}

function compileRuleRegex(rule: PolicyRuleRecord): RegExp | undefined {
  if (!rule.pattern) {
    return undefined;
  }
  try {
    if (rule.type === "blocked_keyword") {
      return new RegExp(escapeRegExp(rule.pattern), "gi");
    }
    return new RegExp(rule.pattern, "gi");
  } catch {
    return undefined;
  }
}

function sanitizeMatchedText(value: string | null): string | null {
  if (!value) {
    return value;
  }
  if (value.length <= 8) {
    return "[REDACTED]";
  }
  return `${value.slice(0, 3)}...[REDACTED]...${value.slice(-3)}`;
}

function buildStats(events: readonly FirewallEventRecord[]): FirewallStats {
  const grouped = new Map<string, number>();
  for (const event of events) {
    grouped.set(event.type, (grouped.get(event.type) ?? 0) + 1);
  }
  return {
    totalEvents: events.length,
    blockedRequests: events.filter((event) => event.action === "block").length,
    redactedRequests: events.filter((event) => event.action === "redact").length,
    warnings: events.filter((event) => event.action === "warn").length,
    topRuleTypes: [...grouped.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
      .slice(0, 5),
  };
}

function normalizeRuleRow(row: PolicyRuleRecord): PolicyRuleRecord {
  return {
    ...row,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function normalizeEventRow(row: FirewallEventRecord): FirewallEventRecord {
  return {
    ...row,
    createdAt: new Date(row.createdAt),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
