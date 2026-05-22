import { mkdir, readFile, writeFile, appendFile, readdir } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

import type { RawCaptureEvent, SessionMeta } from "../domain/types.js"
import { sessionDirectory } from "../utils/path.js"

type SessionState = {
  meta: SessionMeta
  writeTail: Promise<void>
}

export class SessionArchive {
  private readonly sessions = new Map<string, SessionState>()

  constructor(
    private readonly captureRoot: string,
    private readonly projectID: string,
    private readonly projectKey: string = projectID,
  ) { }

  async updateMeta(sessionID: string, patch: Partial<SessionMeta>) {
    const state = await this.getSessionState(sessionID)
    state.meta = {
      ...state.meta,
      ...patch,
      session_id: sessionID,
      project_id: this.projectID,
      updated_at: patch.updated_at ?? new Date().toISOString(),
    }
    await this.persistMeta(state.meta)
    this.sessions.set(sessionID, state)
  }

  async appendEvent(
    sessionID: string,
    input: Omit<RawCaptureEvent, "schema_version" | "project_id" | "session_id" | "event_id" | "seq" | "occurred_at"> & {
      occurred_at?: string
    },
  ): Promise<RawCaptureEvent> {
    const state = await this.getSessionState(sessionID)
    const event: RawCaptureEvent = {
      schema_version: 1,
      project_id: this.projectID,
      session_id: sessionID,
      event_id: randomUUID(),
      seq: state.meta.last_seq + 1,
      occurred_at: input.occurred_at ?? new Date().toISOString(),
      ...input,
    }
    state.meta.last_seq = event.seq
    state.meta.updated_at = event.occurred_at
    state.writeTail = state.writeTail.then(async () => {
      await this.ensureSessionDirs(sessionID)
      await appendFile(this.eventsPath(sessionID), JSON.stringify(this.orderEventForWrite(event)) + "\n", "utf8")
      await this.persistMeta(state.meta)
    })
    await state.writeTail
    return event
  }

  async readEvents(sessionID: string): Promise<RawCaptureEvent[]> {
    try {
      const content = await readFile(this.eventsPath(sessionID), "utf8")
      return content
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RawCaptureEvent)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return []
      }
      throw error
    }
  }

  async readMeta(sessionID: string): Promise<SessionMeta> {
    return (await this.getSessionState(sessionID)).meta
  }

  async listMetas(): Promise<SessionMeta[]> {
    const projectDir = path.join(this.captureRoot, this.projectKey)
    try {
      const dirents = await readdir(projectDir, { withFileTypes: true })
      const metas: SessionMeta[] = []
      for (const dirent of dirents) {
        if (!dirent.isDirectory()) continue
        try {
          const content = await readFile(path.join(projectDir, dirent.name, "meta.json"), "utf8")
          metas.push(JSON.parse(content) as SessionMeta)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
          throw error
        }
      }
      return metas
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return []
      }
      throw error
    }
  }

  async listRelatedMetas(rootSessionID: string): Promise<SessionMeta[]> {
    const metas = await this.listMetas()
    const byParent = new Map<string, SessionMeta[]>()
    for (const meta of metas) {
      const parent = meta.parent_session_id
      if (!parent) continue
      const bucket = byParent.get(parent) ?? []
      bucket.push(meta)
      byParent.set(parent, bucket)
    }

    const root = metas.find((meta) => meta.session_id === rootSessionID) ?? (await this.readMeta(rootSessionID))
    const queue = [root]
    const visited = new Set<string>()
    const result: SessionMeta[] = []

    while (queue.length > 0) {
      const current = queue.shift()
      if (!current) continue
      if (visited.has(current.session_id)) continue
      visited.add(current.session_id)
      result.push(current)
      for (const child of byParent.get(current.session_id) ?? []) {
        queue.push(child)
      }
    }

    return result
  }

  async writeExport(sessionID: string, data: unknown, exportFileName: string): Promise<string> {
    const dir = sessionDirectory(this.captureRoot, this.projectKey, sessionID)
    const exportDir = path.join(dir, "export")
    await mkdir(exportDir, { recursive: true })
    const outputPath = path.join(exportDir, exportFileName)
    await writeFile(outputPath, JSON.stringify(data, null, 2) + "\n", "utf8")
    return outputPath
  }

  async writeArtifact(sessionID: string, filename: string, data: string): Promise<string> {
    const dir = sessionDirectory(this.captureRoot, this.projectKey, sessionID)
    const artifactDir = path.join(dir, "artifact")
    await mkdir(artifactDir, { recursive: true })
    const filePath = path.join(artifactDir, filename)
    await writeFile(filePath, data, "utf8")
    return filePath
  }

  private async getSessionState(sessionID: string): Promise<SessionState> {
    const cached = this.sessions.get(sessionID)
    if (cached) {
      return cached
    }

    const meta = await this.loadMeta(sessionID)
    const state: SessionState = {
      meta,
      writeTail: Promise.resolve(),
    }
    this.sessions.set(sessionID, state)
    return state
  }

  private async loadMeta(sessionID: string): Promise<SessionMeta> {
    try {
      const content = await readFile(this.metaPath(sessionID), "utf8")
      return JSON.parse(content) as SessionMeta
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error
      }
    }

    const now = new Date().toISOString()
    const meta: SessionMeta = {
      session_id: sessionID,
      project_id: this.projectID,
      created_at: now,
      updated_at: now,
      last_seq: 0,
    }
    await this.ensureSessionDirs(sessionID)
    await this.persistMeta(meta)
    return meta
  }

  private async persistMeta(meta: SessionMeta) {
    await this.ensureSessionDirs(meta.session_id)
    await writeFile(this.metaPath(meta.session_id), JSON.stringify(meta, null, 2) + "\n", "utf8")
  }

  private async ensureSessionDirs(sessionID: string) {
    const dir = sessionDirectory(this.captureRoot, this.projectKey, sessionID)
    await mkdir(path.join(dir, "raw"), { recursive: true })
  }

  private metaPath(sessionID: string) {
    return path.join(sessionDirectory(this.captureRoot, this.projectKey, sessionID), "meta.json")
  }

  private eventsPath(sessionID: string) {
    return path.join(sessionDirectory(this.captureRoot, this.projectKey, sessionID), "raw", "events.jsonl")
  }

  private orderEventForWrite(event: RawCaptureEvent) {
    const ordered: Record<string, unknown> = {
      kind: event.kind,
      source: event.source,
    }

    if (event.summary !== undefined) ordered.summary = event.summary
    if (event.payload !== undefined) ordered.payload = event.payload
    if (event.command_name !== undefined) ordered.command_name = event.command_name

    ordered.occurred_at = event.occurred_at
    ordered.seq = event.seq

    if (event.project_id !== undefined) ordered.project_id = event.project_id
    if (event.session_id !== undefined) ordered.session_id = event.session_id
    if (event.event_id !== undefined) ordered.event_id = event.event_id
    if (event.message_id !== undefined) ordered.message_id = event.message_id
    if (event.parent_message_id !== undefined) ordered.parent_message_id = event.parent_message_id
    if (event.part_id !== undefined) ordered.part_id = event.part_id
    if (event.call_id !== undefined) ordered.call_id = event.call_id
    if (event.request_id !== undefined) ordered.request_id = event.request_id
    ordered.schema_version = event.schema_version

    return ordered
  }
}
