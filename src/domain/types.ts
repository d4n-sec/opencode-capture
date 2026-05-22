export interface CapturePluginOptions {
  captureRoot?: string
  enabledByDefault?: boolean
  inlineOutputLimit?: number
  settingsFileName?: string
  exportFileName?: string
}

export interface ProjectSettings {
  enabled_by_default: boolean
  session_overrides: Record<string, boolean>
  capture_root: string
  inline_output_limit: number
  settings_file_name: string
  export_file_name: string
}

export interface SessionMeta {
  session_id: string
  project_id: string
  title?: string
  directory?: string
  path?: string
  parent_session_id?: string
  created_at: string
  updated_at: string
  last_seq: number
}

export interface RawCaptureEvent {
  schema_version: number
  project_id: string
  session_id: string
  event_id: string
  seq: number
  occurred_at: string
  kind: string
  source: string
  message_id?: string
  parent_message_id?: string
  part_id?: string
  call_id?: string
  request_id?: string
  command_name?: string
  summary?: string
  payload?: unknown
}

export type SystemPromptScope = "main" | "subagent" | "internal"

export interface ExportSessionInfo {
  id: string
  project_id: string
  title?: string
  directory?: string
  path?: string
  parent_id?: string
  created_at?: string
  updated_at?: string
}

export interface InteractionItem {
  id: string
  ts: string
  kind: string
  role: string
  session_id: string
  parent_session_id?: string
  origin_call_id?: string
  linked_session_id?: string
  agent?: string
  message_id?: string
  parent_message_id?: string
  call_id?: string
  request_id?: string
  system_scope?: SystemPromptScope
  summary: string
  detail_ref?: string
}

export interface InteractionExport {
  version: number
  session: ExportSessionInfo
  linked_sessions?: ExportSessionInfo[]
  items: InteractionItem[]
}

export interface RuntimeSessionState {
  current_agent?: string
  current_model?: {
    providerID?: string
    modelID?: string
  }
  current_assistant_message_id?: string
  current_assistant_parent_message_id?: string
  captured_part_ids: Set<string>
  captured_system_prompts: Set<string>
  last_shell_command_by_call: Map<string, string>
}
