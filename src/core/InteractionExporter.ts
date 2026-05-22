import path from "node:path"

import type { InteractionExport, InteractionItem, RawCaptureEvent, SessionMeta } from "../domain/types.js"
import { SessionArchive } from "./SessionArchive.js"

type ExportEventEntry = {
  event: RawCaptureEvent
  meta: SessionMeta
}

type SessionRelations = {
  callToSession: Map<string, string>
  sessionToCall: Map<string, string>
}

export class InteractionExporter {
  constructor(
    private readonly archive: SessionArchive,
    private readonly exportFileName: string,
  ) { }

  async exportSession(sessionID: string, input: { includeRelated?: boolean } = {}) {
    const includeRelated = input.includeRelated ?? true
    const metas = includeRelated
      ? await this.archive.listRelatedMetas(sessionID)
      : [await this.archive.readMeta(sessionID)]
    const meta = metas.find((item) => item.session_id === sessionID) ?? metas[0]
    const events: ExportEventEntry[] = (
      await Promise.all(
        metas.map(async (sessionMeta) => ({
          meta: sessionMeta,
          events: await this.archive.readEvents(sessionMeta.session_id),
        })),
      )
    ).flatMap(({ meta: eventMeta, events: sessionEvents }) =>
      sessionEvents.map((event) => ({
        event,
        meta: eventMeta,
      })),
    )
    const relations = this.buildSessionRelations(events)
    const result: InteractionExport = {
      version: 1,
      session: this.buildSessionInfo(meta),
      linked_sessions: metas
        .filter((item) => item.session_id !== sessionID)
        .map((item) => this.buildSessionInfo(item)),
      items: events
        .sort((a, b) => {
          const timeDiff = new Date(a.event.occurred_at).getTime() - new Date(b.event.occurred_at).getTime()
          if (timeDiff !== 0) return timeDiff
          if (a.event.session_id !== b.event.session_id) return a.event.session_id.localeCompare(b.event.session_id)
          return a.event.seq - b.event.seq
        })
        .map(({ event, meta: itemMeta }) => this.toInteractionItem(event, itemMeta, relations))
        .filter((item): item is InteractionItem => item !== undefined),
    }
    const outputPath = await this.archive.writeExport(sessionID, result, this.exportFileName)
    return { outputPath, result }
  }

  private buildSessionInfo(meta: SessionMeta) {
    return {
      id: meta.session_id,
      project_id: meta.project_id,
      title: meta.title,
      directory: meta.directory,
      path: meta.path,
      parent_id: meta.parent_session_id,
      created_at: meta.created_at,
      updated_at: meta.updated_at,
    }
  }

  private toInteractionItem(event: RawCaptureEvent, meta: SessionMeta, relations: SessionRelations): InteractionItem | undefined {
    const detailRef = this.extractDetailRef(event)
    switch (event.kind) {
      case "chat.user":
        return this.item(event, meta, relations, "user", "user", this.textFromEvent(event))
      case "system.prompt":
        return this.item(event, meta, relations, "system", "system", this.textFromEvent(event), detailRef)
      case "chat.assistant":
        return this.item(event, meta, relations, "assistant", "assistant", this.textFromEvent(event), detailRef)
      case "assistant.reasoning":
        return this.item(event, meta, relations, "assistant.reasoning", "assistant", this.textFromEvent(event), detailRef)
      case "subagent.call":
        return this.item(event, meta, relations, "subagent", "subagent", this.textFromEvent(event), detailRef)
      case "tool.call":
        return this.item(event, meta, relations, "tool", "tool", this.textFromEvent(event), detailRef)
      case "tool.result":
        return this.item(event, meta, relations, "tool", "tool", this.textFromEvent(event), detailRef)
      case "shell.command":
        return this.item(event, meta, relations, "shell", "tool", this.textFromEvent(event), detailRef)
      case "slash.command":
        return this.item(event, meta, relations, "command", "system", this.textFromEvent(event), detailRef)
      case "approval.evaluated":
      case "approval.requested":
      case "approval.resolved":
        return this.item(event, meta, relations, "approval", "system", this.textFromEvent(event), detailRef)
      case "compaction":
        return this.item(event, meta, relations, "compaction", "system", this.textFromEvent(event), detailRef)
      default:
        return undefined
    }
  }

  private item(
    event: RawCaptureEvent,
    meta: SessionMeta,
    relations: SessionRelations,
    kind: string,
    role: string,
    summary: string,
    detailRef?: string,
  ): InteractionItem {
    return {
      id: event.event_id,
      ts: event.occurred_at,
      kind,
      role,
      session_id: event.session_id,
      parent_session_id: meta.parent_session_id,
      origin_call_id: relations.sessionToCall.get(event.session_id),
      linked_session_id: event.call_id ? relations.callToSession.get(event.call_id) : undefined,
      agent: this.extractAgent(event),
      message_id: event.message_id,
      parent_message_id: event.parent_message_id,
      call_id: event.call_id,
      request_id: event.request_id,
      system_scope: this.extractSystemScope(event),
      summary,
      detail_ref: detailRef,
    }
  }

  private buildSessionRelations(events: ExportEventEntry[]): SessionRelations {
    const callToSession = new Map<string, string>()
    for (const { event } of events) {
      if (event.kind !== "tool.result" || !event.call_id) continue
      const payload = this.objectValue(event.payload)
      if (!payload) continue
      if (payload.tool !== "task") continue
      const metadata = this.objectValue(payload.metadata)
      const sessionID = this.stringValue(metadata?.sessionId) ?? this.stringValue(metadata?.sessionID)
      if (!sessionID) continue
      callToSession.set(event.call_id, sessionID)
    }

    const sessionToCall = new Map<string, string>()
    for (const [callID, sessionID] of callToSession.entries()) {
      sessionToCall.set(sessionID, callID)
    }

    return {
      callToSession,
      sessionToCall,
    }
  }

  private textFromEvent(event: RawCaptureEvent) {
    if (this.isPlaceholderEvent(event)) return "[placeholder]"
    if (typeof event.summary === "string" && event.summary.trim().length > 0) return event.summary
    const payload = event.payload
    if (typeof payload === "string") return payload
    if (payload && typeof payload === "object") {
      const record = payload as Record<string, unknown>
      for (const key of ["summary", "text", "output", "description", "command", "decision", "reply"]) {
        const value = record[key]
        if (typeof value === "string" && value.trim().length > 0) {
          return value
        }
      }
      return JSON.stringify(payload)
    }
    return event.kind
  }

  private isPlaceholderEvent(event: RawCaptureEvent) {
    const payload = this.objectValue(event.payload)
    if (payload?.placeholder === true) return true
    if (event.kind !== "chat.assistant" && event.kind !== "assistant.reasoning") return false
    const summary = typeof event.summary === "string" ? event.summary : ""
    const text = this.stringValue(payload?.text) ?? ""
    return summary.trim().length === 0 && text.trim().length === 0
  }

  private extractAgent(event: RawCaptureEvent) {
    if (!event.payload || typeof event.payload !== "object") return undefined
    const payload = event.payload as Record<string, unknown>
    const agent = payload.agent
    return typeof agent === "string" ? agent : undefined
  }

  private extractDetailRef(event: RawCaptureEvent) {
    if (!event.payload || typeof event.payload !== "object") return undefined
    const payload = event.payload as Record<string, unknown>
    const direct = payload.detail_ref
    if (typeof direct === "string") return direct
    const outputPath = payload.output_path
    if (typeof outputPath === "string") return path.normalize(outputPath)
    return undefined
  }

  private extractSystemScope(event: RawCaptureEvent) {
    if (!event.payload || typeof event.payload !== "object") return undefined
    const payload = event.payload as Record<string, unknown>
    const scope = payload.system_scope
    return scope === "main" || scope === "subagent" || scope === "internal" ? scope : undefined
  }

  private objectValue(value: unknown) {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
  }

  private stringValue(value: unknown) {
    return typeof value === "string" ? value : undefined
  }
}
