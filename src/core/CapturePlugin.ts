import path from "node:path"

import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"

import type { CapturePluginOptions, ProjectSettings, RuntimeSessionState, SessionMeta, SystemPromptScope } from "../domain/types.js"
import { projectStorageKey } from "../utils/path.js"
import { InteractionExporter } from "./InteractionExporter.js"
import { ProjectSettingsStore } from "./ProjectSettingsStore.js"
import { SessionArchive } from "./SessionArchive.js"

export class CapturePlugin {
  private readonly settingsStore: ProjectSettingsStore
  private readonly archive: SessionArchive
  private readonly exporter: InteractionExporter
  private readonly storageProjectKey: string
  private readonly runtime = new Map<string, RuntimeSessionState>()

  constructor(
    private readonly input: PluginInput,
    options: CapturePluginOptions = {},
  ) {
    this.settingsStore = new ProjectSettingsStore(input.directory, options, input.project.id)
    this.storageProjectKey = projectStorageKey(input.directory)
    this.archive = new SessionArchive(this.settingsStore.getCaptureRoot(), input.project.id, this.storageProjectKey)
    this.exporter = new InteractionExporter(this.archive, options.exportFileName ?? "interaction.json")
  }

  createHooks(): Hooks {
    return {
      event: async ({ event }) => {
        await this.handleEvent(event)
      },
      "chat.message": async (input, output) => {
        if (!(await this.shouldCapture(input.sessionID))) return
        await this.archive.appendEvent(input.sessionID, {
          kind: "chat.user",
          source: "chat.message",
          message_id: input.messageID,
          summary: this.extractTextFromParts(output.parts) || "User message",
          payload: {
            agent: input.agent,
            model: input.model,
            message: output.message,
            parts: output.parts,
          },
        })
      },
      "experimental.chat.system.transform": async (input, output) => {
        if (!input.sessionID || !(await this.shouldCapture(input.sessionID))) return
        const system = output.system.filter((item) => item.trim().length > 0)
        if (system.length === 0) return

        const state = this.getRuntimeState(input.sessionID)
        const fingerprint = JSON.stringify(system)
        if (state.captured_system_prompts.has(fingerprint)) return
        state.captured_system_prompts.add(fingerprint)
        const systemScope = await this.classifySystemPrompt(input.sessionID, system)

        const combined = system.join("\n\n")
        const persisted = await this.persistText(
          input.sessionID,
          `system-prompt-${state.captured_system_prompts.size}.txt`,
          combined,
        )
        const payload: Record<string, unknown> = {
          text: persisted.inlineSummary,
          segment_count: system.length,
          model: input.model,
          system_scope: systemScope,
        }
        if (state.current_agent) {
          payload.agent = state.current_agent
        }
        if (!persisted.detailRef) {
          payload.segments = system
        }
        if (persisted.detailRef) {
          payload.detail_ref = persisted.detailRef
          payload.output_path = persisted.detailRef
        }
        await this.archive.appendEvent(input.sessionID, {
          kind: "system.prompt",
          source: "experimental.chat.system.transform",
          summary: undefined,
          payload,
        })
      },
      "permission.ask": async (input, output) => {
        const sessionID = this.stringValue((input as Record<string, unknown>).sessionID)
        if (!sessionID || !(await this.shouldCapture(sessionID))) return
        await this.archive.appendEvent(sessionID, {
          kind: "approval.evaluated",
          source: "permission.ask",
          request_id: this.stringValue((input as Record<string, unknown>).id),
          call_id: this.stringValue(this.recordValue(input, "tool", "callID")),
          summary: `Approval evaluated: ${output.status}`,
          payload: {
            permission: (input as Record<string, unknown>).permission,
            patterns: (input as Record<string, unknown>).patterns,
            decision: output.status === "allow" ? "auto_allow" : output.status === "deny" ? "auto_deny" : "ask",
            tool: (input as Record<string, unknown>).tool,
            metadata: (input as Record<string, unknown>).metadata,
            matched_rule_summary: undefined,
          },
        })
      },
      "command.execute.before": async (input, output) => {
        if (!(await this.shouldCapture(input.sessionID))) return
        await this.archive.appendEvent(input.sessionID, {
          kind: "slash.command",
          source: "command.execute.before",
          command_name: input.command,
          summary: `/${input.command} ${input.arguments}`.trim(),
          payload: {
            command: input.command,
            arguments: input.arguments,
            resolved_parts: output.parts,
            text: this.extractTextFromParts(output.parts),
          },
        })
      },
      "tool.execute.before": async (input, output) => {
        if (!(await this.shouldCapture(input.sessionID))) return
        const isSubagent = input.tool === "task"
        const summary = isSubagent
          ? `Subagent call: ${this.stringValue((output.args as Record<string, unknown>)?.description) ?? input.tool}`
          : `Tool call: ${input.tool}`
        await this.archive.appendEvent(input.sessionID, {
          kind: isSubagent ? "subagent.call" : "tool.call",
          source: "tool.execute.before",
          call_id: input.callID,
          summary,
          payload: {
            tool: input.tool,
            args: output.args,
            agent: this.stringValue((output.args as Record<string, unknown>)?.agent)
              ?? this.stringValue((output.args as Record<string, unknown>)?.subagent_type),
            description: this.stringValue((output.args as Record<string, unknown>)?.description),
            prompt: this.stringValue((output.args as Record<string, unknown>)?.prompt),
          },
        })
      },
      "tool.execute.after": async (input, output) => {
        if (!(await this.shouldCapture(input.sessionID))) return
        const persisted = await this.persistText(input.sessionID, `${input.callID}.txt`, output.output)
        const isShellLike = typeof this.recordValue(input.args, "command") === "string" || this.hasExitMetadata(output.metadata)
        const kind = isShellLike ? "shell.command" : "tool.result"
        const summary = isShellLike
          ? `Command ${persisted.inlineSummary}${this.hasExitMetadata(output.metadata) ? ` (exit=${String(this.recordValue(output.metadata, "exit"))})` : ""}`
          : output.title || `Tool result: ${input.tool}`
        const payload: Record<string, unknown> = {
          tool: input.tool,
          args: input.args,
          title: output.title,
          output: persisted.inlineSummary,
          metadata: output.metadata,
        }
        if (persisted.detailRef) {
          payload.detail_ref = persisted.detailRef
          payload.output_path = persisted.detailRef
        }
        if (isShellLike) {
          payload.command = this.stringValue(this.recordValue(input.args, "command"))
          payload.exit = this.recordValue(output.metadata, "exit")
          payload.truncated = this.recordValue(output.metadata, "truncated")
        }
        await this.archive.appendEvent(input.sessionID, {
          kind,
          source: "tool.execute.after",
          call_id: input.callID,
          summary,
          payload,
        })
      },
      "experimental.session.compacting": async (input) => {
        if (!(await this.shouldCapture(input.sessionID))) return
        await this.archive.appendEvent(input.sessionID, {
          kind: "compaction",
          source: "experimental.session.compacting",
          summary: "Compaction hook invoked",
          payload: {
            phase: "hook",
            reason: "unknown",
          },
        })
      },
      tool: {
        capture_status: tool({
          description: "Get capture plugin status for the current OpenCode project.",
          args: {
            session_id: tool.schema.string().optional().describe("Session ID to inspect. Defaults to the current session."),
          },
          execute: async (args, context) => {
            const settings = await this.settingsStore.load()
            const sessionID = args.session_id ?? context.sessionID
            return {
              title: "Capture plugin status",
              output: JSON.stringify(
                {
                  ...settings,
                  session_id: sessionID,
                  session_capture_enabled: sessionID ? await this.isCaptureEnabled(sessionID, settings) : undefined,
                },
                null,
                2,
              ),
            }
          },
        }),
        capture_export_session: tool({
          description: "Export a captured session into a plain interaction flow JSON file, optionally including child subagent sessions.",
          args: {
            session_id: tool.schema.string().optional().describe("Session ID to export. Defaults to the current session."),
            include_related: tool.schema
              .boolean()
              .optional()
              .describe("Whether to include child subagent sessions. Defaults to true."),
          },
          execute: async (args, context) => {
            const sessionID = args.session_id ?? context.sessionID
            const result = await this.exporter.exportSession(sessionID, {
              includeRelated: args.include_related,
            })
            return {
              title: "Session exported",
              output: `Exported session ${sessionID} to ${result.outputPath} (${result.result.items.length} items, ${result.result.linked_sessions?.length ?? 0} linked sessions)`,
              metadata: {
                outputPath: result.outputPath,
                sessionID,
              },
            }
          },
        }),
        capture_configure_default: tool({
          description: "Enable or disable capture by default for this project.",
          args: {
            enabled: tool.schema.boolean().describe("Whether new sessions should be captured by default."),
          },
          execute: async (args) => {
            const settings = await this.settingsStore.setEnabledByDefault(args.enabled)
            return {
              title: "Capture default updated",
              output: `Capture default is now ${settings.enabled_by_default ? "enabled" : "disabled"}.`,
            }
          },
        }),
        capture_configure_session: tool({
          description: "Enable or disable capture for one session, inheriting to resumed child sessions and subagent sessions.",
          args: {
            enabled: tool.schema.boolean().describe("Whether this session should be captured."),
            session_id: tool.schema.string().optional().describe("Session ID to update. Defaults to the current session."),
          },
          execute: async (args, context) => {
            const sessionID = args.session_id ?? context.sessionID
            const settings = await this.settingsStore.setSessionOverride(sessionID, args.enabled)
            await this.ensureSessionRoot(sessionID, settings)
            return {
              title: "Session capture updated",
              output: `Capture for session ${sessionID} is now ${args.enabled ? "enabled" : "disabled"}.`,
            }
          },
        }),
      },
    }
  }

  private async handleEvent(event: unknown) {
    const eventType = this.stringValue(this.recordValue(event, "type"))
    if (!eventType) return

    const sessionID = this.resolveSessionID(event, eventType)
    if (eventType === "session.created" || eventType === "session.updated") {
      const info = this.extractSessionInfo(event)
      const infoID = this.stringValue(info?.id)
      if (infoID) {
        const parentSessionID = this.stringValue(info?.parentID)
        const shouldCapture = await this.shouldCaptureSession(infoID, parentSessionID)
        if (shouldCapture) {
          await this.archive.updateMeta(infoID, {
            title: this.stringValue(info?.title),
            directory: this.stringValue(info?.directory),
            path: this.stringValue(info?.path),
            parent_session_id: parentSessionID,
            updated_at: new Date().toISOString(),
          })
        }
      }
      if (eventType === "session.created" && infoID && (await this.shouldCapture(infoID))) {
        await this.archive.appendEvent(infoID, {
          kind: "session.lifecycle",
          source: eventType,
          summary: "Session created",
          payload: info,
        })
      }
      return
    }

    if (!sessionID || !(await this.shouldCapture(sessionID))) return

    switch (eventType) {
      case "permission.asked":
        await this.archive.appendEvent(sessionID, {
          kind: "approval.requested",
          source: eventType,
          request_id: this.stringValue(this.recordValue(event, "properties", "id")) ?? this.stringValue(this.recordValue(event, "id")),
          call_id: this.stringValue(this.recordValue(event, "properties", "tool", "callID")),
          summary: "Approval requested",
          payload: this.extractEventPayload(event),
        })
        break
      case "permission.replied":
        await this.archive.appendEvent(sessionID, {
          kind: "approval.resolved",
          source: eventType,
          request_id: this.stringValue(this.recordValue(event, "properties", "requestID")),
          summary: `Approval resolved: ${this.stringValue(this.recordValue(event, "properties", "reply")) ?? "unknown"}`,
          payload: this.extractEventPayload(event),
        })
        break
      case "session.next.step.started":
        this.getRuntimeState(sessionID).current_agent = this.stringValue(this.recordValue(event, "properties", "agent"))
        this.getRuntimeState(sessionID).current_model = this.objectValue(this.recordValue(event, "properties", "model")) as
          | { providerID?: string; modelID?: string }
          | undefined
        break
      case "message.updated": {
        const info = this.objectValue(this.recordValue(event, "properties", "info"))
        if (this.stringValue(info?.role) !== "assistant") break
        const state = this.getRuntimeState(sessionID)
        state.current_agent = this.stringValue(info?.agent) ?? state.current_agent
        state.current_model = {
          providerID: this.stringValue(info?.providerID) ?? this.stringValue(this.recordValue(info, "model", "providerID")),
          modelID: this.stringValue(info?.modelID) ?? this.stringValue(this.recordValue(info, "model", "modelID")),
        }
        state.current_assistant_message_id = this.stringValue(info?.id)
        state.current_assistant_parent_message_id = this.stringValue(info?.parentID)
        break
      }
      case "message.part.updated": {
        const part = this.objectValue(this.recordValue(event, "properties", "part"))
        if (!part) break
        const partID = this.stringValue(part.id)
        if (!partID) break
        const partType = this.stringValue(part.type)
        if (partType !== "text" && partType !== "reasoning") break
        if (this.recordValue(part, "time", "end") === undefined) break
        const partText = this.stringValue(part.text)
        const isPlaceholder = this.isBlankText(partText)
        const state = this.getRuntimeState(sessionID)
        if (state.captured_part_ids.has(partID)) break
        state.captured_part_ids.add(partID)
        await this.archive.appendEvent(sessionID, {
          kind: partType === "text" ? "chat.assistant" : "assistant.reasoning",
          source: eventType,
          part_id: partID,
          message_id: this.stringValue(part.messageID) ?? state.current_assistant_message_id,
          parent_message_id: state.current_assistant_parent_message_id,
          summary: isPlaceholder ? "[placeholder]" : undefined,
          payload: {
            text: part.text,
            placeholder: isPlaceholder,
            placeholder_reason: isPlaceholder ? "blank_text" : undefined,
            agent: state.current_agent,
            model: state.current_model,
            time: this.recordValue(part, "time"),
            metadata: this.recordValue(part, "metadata"),
          },
        })
        break
      }
      case "session.next.text.ended":
        {
          const text = this.stringValue(this.recordValue(event, "properties", "text"))
          const isPlaceholder = this.isBlankText(text)
          await this.archive.appendEvent(sessionID, {
            kind: "chat.assistant",
            source: eventType,
            summary: isPlaceholder ? "[placeholder]" : undefined,
            payload: {
              text: this.recordValue(event, "properties", "text"),
              placeholder: isPlaceholder,
              placeholder_reason: isPlaceholder ? "blank_text" : undefined,
              agent: this.getRuntimeState(sessionID).current_agent,
              model: this.getRuntimeState(sessionID).current_model,
            },
          })
          break
        }
      case "session.next.reasoning.ended":
        {
          const text = this.stringValue(this.recordValue(event, "properties", "text"))
          const isPlaceholder = this.isBlankText(text)
          await this.archive.appendEvent(sessionID, {
            kind: "assistant.reasoning",
            source: eventType,
            summary: isPlaceholder ? "[placeholder]" : undefined,
            payload: {
              reasoning_id: this.recordValue(event, "properties", "reasoningID"),
              text: this.recordValue(event, "properties", "text"),
              placeholder: isPlaceholder,
              placeholder_reason: isPlaceholder ? "blank_text" : undefined,
              agent: this.getRuntimeState(sessionID).current_agent,
              model: this.getRuntimeState(sessionID).current_model,
            },
          })
          break
        }
      case "session.next.tool.failed":
        await this.archive.appendEvent(sessionID, {
          kind: "tool.result",
          source: eventType,
          call_id: this.stringValue(this.recordValue(event, "properties", "callID")),
          summary: this.stringValue(this.recordValue(event, "properties", "error", "message")) ?? "Tool failed",
          payload: this.extractEventPayload(event),
        })
        break
      case "session.next.compaction.started":
      case "session.next.compaction.ended":
        await this.archive.appendEvent(sessionID, {
          kind: "compaction",
          source: eventType,
          summary:
            eventType === "session.next.compaction.started"
              ? `Compaction started (${this.stringValue(this.recordValue(event, "properties", "reason")) ?? "unknown"})`
              : this.stringValue(this.recordValue(event, "properties", "text")) ?? "Compaction finished",
          payload: this.extractEventPayload(event),
        })
        break
      default:
        break
    }
  }

  private async shouldCapture(sessionID: string) {
    const settings = await this.settingsStore.load()
    const enabled = await this.isCaptureEnabled(sessionID, settings)
    if (!enabled) return false
    await this.ensureSessionRoot(sessionID, settings)
    return true
  }

  private async shouldCaptureSession(sessionID: string, parentSessionID?: string) {
    const settings = await this.settingsStore.load()
    return this.isCaptureEnabled(sessionID, settings, new Set<string>(), parentSessionID)
  }

  private async isCaptureEnabled(
    sessionID: string,
    settings: ProjectSettings,
    visited = new Set<string>(),
    parentSessionID?: string,
  ): Promise<boolean> {
    if (visited.has(sessionID)) return false
    visited.add(sessionID)

    const override = settings.session_overrides[sessionID]
    if (override !== undefined) return override
    if (settings.enabled_by_default) return true

    const meta = await this.archive.readMetaIfExists(sessionID)
    const resolvedParentSessionID = parentSessionID ?? meta?.parent_session_id
    if (!resolvedParentSessionID) return false
    return this.isCaptureEnabled(resolvedParentSessionID, settings, visited)
  }

  private async ensureSessionRoot(sessionID: string, settings: ProjectSettings) {
    await this.archive.updateMeta(sessionID, {
      directory: this.input.directory,
      updated_at: new Date().toISOString(),
    })
    const meta = await this.archive.readMeta(sessionID)
    if (!meta.title) {
      await this.archive.updateMeta(sessionID, {
        title: `Captured session ${sessionID}`,
        directory: this.input.directory,
        path: path.join(settings.capture_root, this.storageProjectKey, sessionID),
      })
    }
  }

  private async persistText(sessionID: string, artifactName: string, text: string) {
    const settings = await this.settingsStore.load()
    if (text.length <= settings.inline_output_limit) {
      return {
        inlineSummary: text,
        detailRef: undefined as string | undefined,
      }
    }
    const detailRef = await this.archive.writeArtifact(sessionID, artifactName, text)
    return {
      inlineSummary: text.slice(0, settings.inline_output_limit) + "\n...[truncated]",
      detailRef,
    }
  }

  private async classifySystemPrompt(sessionID: string, system: string[]): Promise<SystemPromptScope> {
    if (this.isInternalSystemPrompt(system)) return "internal"
    const meta = await this.archive.readMeta(sessionID)
    if (meta.parent_session_id) return "subagent"
    return "main"
  }

  private isInternalSystemPrompt(system: string[]) {
    const combined = system.join("\n").toLowerCase()
    const markers = [
      "you are a title generator",
      "generate a brief title",
      "thread title",
      "compaction",
      "auto-continue",
      "synthetic user",
    ]
    return markers.some((marker) => combined.includes(marker))
  }

  private extractTextFromParts(parts: unknown) {
    if (!Array.isArray(parts)) return ""
    return parts
      .map((part) => {
        if (!part || typeof part !== "object") return ""
        const record = part as Record<string, unknown>
        if (record.type === "text" && typeof record.text === "string") return record.text
        if (record.type === "subtask" && typeof record.description === "string") return record.description
        return ""
      })
      .filter(Boolean)
      .join("\n")
      .trim()
  }

  private extractSessionInfo(event: unknown) {
    const properties = this.objectValue(this.recordValue(event, "properties"))
    const info = this.objectValue(properties?.info)
    return info ?? properties
  }

  private extractEventPayload(event: unknown) {
    const properties = this.objectValue(this.recordValue(event, "properties"))
    if (!properties) return event
    return properties.info ?? properties
  }

  private resolveSessionID(event: unknown, eventType: string) {
    if (eventType === "session.created" || eventType === "session.updated") {
      return this.stringValue(this.recordValue(event, "properties", "info", "id"))
    }
    return (
      this.stringValue(this.recordValue(event, "properties", "sessionID")) ??
      this.stringValue(this.recordValue(event, "sessionID")) ??
      this.stringValue(this.recordValue(event, "properties", "info", "sessionID"))
    )
  }

  private getRuntimeState(sessionID: string): RuntimeSessionState {
    let state = this.runtime.get(sessionID)
    if (!state) {
      state = {
        captured_part_ids: new Set<string>(),
        captured_system_prompts: new Set<string>(),
        last_shell_command_by_call: new Map<string, string>(),
      }
      this.runtime.set(sessionID, state)
    }
    return state
  }

  private hasExitMetadata(metadata: unknown) {
    return this.recordValue(metadata, "exit") !== undefined
  }

  private recordValue(value: unknown, ...keys: string[]) {
    let current: unknown = value
    for (const key of keys) {
      if (!current || typeof current !== "object") return undefined
      current = (current as Record<string, unknown>)[key]
    }
    return current
  }

  private objectValue(value: unknown) {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
  }

  private stringValue(value: unknown) {
    return typeof value === "string" ? value : undefined
  }

  private isBlankText(value: string | undefined) {
    return value === undefined || value.trim().length === 0
  }
}

export function sessionMetaPatchFromInfo(info: Record<string, unknown>): Partial<SessionMeta> {
  return {
    title: typeof info.title === "string" ? info.title : undefined,
    directory: typeof info.directory === "string" ? info.directory : undefined,
    path: typeof info.path === "string" ? info.path : undefined,
    parent_session_id: typeof info.parentID === "string" ? info.parentID : undefined,
  }
}
