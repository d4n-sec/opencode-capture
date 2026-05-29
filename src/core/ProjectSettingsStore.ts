import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import type { CapturePluginOptions, ProjectSettings } from "../domain/types.js"
import { projectSettingsKey, resolveCaptureRoot } from "../utils/path.js"

export class ProjectSettingsStore {
  private readonly captureRoot: string
  private readonly settingsFileName: string
  private readonly exportFileName: string
  private readonly inlineOutputLimit: number
  private readonly enabledByDefault: boolean
  private readonly projectDirectory: string
  private readonly projectID?: string
  private readonly settingsDirectory: string
  private readonly projectName: string
  private readonly settingsKey: string

  constructor(
    projectDirectory: string,
    options: CapturePluginOptions = {},
    projectID?: string,
  ) {
    this.projectDirectory = path.resolve(projectDirectory)
    this.projectID = projectID
    this.captureRoot = resolveCaptureRoot(projectDirectory, options.captureRoot)
    this.settingsFileName = options.settingsFileName ?? "settings.json"
    this.exportFileName = options.exportFileName ?? "interaction.json"
    this.inlineOutputLimit = options.inlineOutputLimit ?? 16_000
    this.enabledByDefault = options.enabledByDefault ?? false
    this.settingsDirectory = path.join(this.captureRoot, "_settings")
    this.projectName = path.basename(this.projectDirectory) || "project"
    this.settingsKey = projectSettingsKey(this.projectDirectory)
  }

  async getSettingsPath() {
    return this.buildSettingsPath(this.settingsKey)
  }

  getCaptureRoot() {
    return this.captureRoot
  }

  private buildSettingsPath(settingsKey: string) {
    return path.join(this.settingsDirectory, `${settingsKey}.json`)
  }

  private async readOptionalJson<T>(filePath: string): Promise<T | undefined> {
    try {
      const content = await readFile(filePath, "utf8")
      return JSON.parse(content) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined
      }
      throw error
    }
  }

  private getLegacySettingsPath() {
    return path.join(this.projectDirectory, ".opencode", "capture_log", this.settingsFileName)
  }

  private getDefaultSettings(): ProjectSettings {
    return {
      project_id: this.projectID,
      project_name: this.projectName,
      project_path: this.projectDirectory,
      enabled_by_default: this.enabledByDefault,
      session_overrides: {},
      capture_root: this.captureRoot,
      inline_output_limit: this.inlineOutputLimit,
      settings_file_name: this.settingsFileName,
      export_file_name: this.exportFileName,
    }
  }

  private buildResolvedSettings(parsed?: Partial<ProjectSettings>) {
    const defaults = this.getDefaultSettings()
    const next = {
      ...defaults,
      ...parsed,
      project_id: this.projectID ?? parsed?.project_id ?? defaults.project_id,
      project_name: parsed?.project_name ?? defaults.project_name,
      project_path: parsed?.project_path ?? defaults.project_path,
      session_overrides: parsed?.session_overrides ?? defaults.session_overrides,
      capture_root: defaults.capture_root,
      settings_file_name: defaults.settings_file_name,
      export_file_name: parsed?.export_file_name ?? defaults.export_file_name,
    }

    return next
  }

  private hasSessionOverrides(settings?: Partial<ProjectSettings>) {
    return Object.keys(settings?.session_overrides ?? {}).length > 0
  }

  private hasLegacySignal(settings?: Partial<ProjectSettings>) {
    if (!settings) return false
    return (
      (settings.enabled_by_default !== undefined && settings.enabled_by_default !== this.enabledByDefault) ||
      this.hasSessionOverrides(settings) ||
      (settings.inline_output_limit !== undefined && settings.inline_output_limit !== this.inlineOutputLimit) ||
      (settings.export_file_name !== undefined && settings.export_file_name !== this.exportFileName)
    )
  }

  private isBootstrapDefault(settings?: Partial<ProjectSettings>) {
    if (!settings) return false
    return (
      (settings.enabled_by_default ?? this.enabledByDefault) === this.enabledByDefault &&
      !this.hasSessionOverrides(settings) &&
      (settings.inline_output_limit ?? this.inlineOutputLimit) === this.inlineOutputLimit &&
      (settings.export_file_name ?? this.exportFileName) === this.exportFileName &&
      (settings.project_path ?? this.projectDirectory) === this.projectDirectory
    )
  }

  private async resolveSettings() {
    const settingsPath = await this.getSettingsPath()
    const current = await this.readOptionalJson<Partial<ProjectSettings>>(settingsPath)
    const legacy = await this.readOptionalJson<Partial<ProjectSettings>>(this.getLegacySettingsPath())
    const shouldApplyLegacy = this.hasLegacySignal(legacy) && (!current || this.isBootstrapDefault(current))
    const parsed = shouldApplyLegacy
      ? {
        ...current,
        ...legacy,
      }
      : current

    return {
      path: settingsPath,
      settings: this.buildResolvedSettings(parsed),
      existed: current !== undefined,
      migrated: shouldApplyLegacy,
    }
  }

  async load(): Promise<ProjectSettings> {
    const resolved = await this.resolveSettings()
    if (resolved.migrated) {
      await this.writeSettings(resolved.path, resolved.settings)
    }
    return resolved.settings
  }

  private async writeSettings(filePath: string, settings: ProjectSettings) {
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(settings, null, 2) + "\n", "utf8")
  }

  async ensureInitialized() {
    const resolved = await this.resolveSettings()
    if (!resolved.existed || resolved.migrated) {
      await this.writeSettings(resolved.path, resolved.settings)
    }
    return {
      settings: resolved.settings,
      created: !resolved.existed,
      migrated: resolved.migrated,
      path: resolved.path,
    }
  }

  async save(input: Partial<ProjectSettings>): Promise<ProjectSettings> {
    const current = await this.load()
    const next: ProjectSettings = {
      ...current,
      ...input,
      project_id: this.projectID ?? current.project_id,
      project_name: current.project_name,
      project_path: current.project_path,
      session_overrides: input.session_overrides ?? current.session_overrides,
      capture_root: this.captureRoot,
      settings_file_name: this.settingsFileName,
    }
    await this.writeSettings(await this.getSettingsPath(), next)
    return next
  }

  async setEnabledByDefault(enabled: boolean) {
    return this.save({ enabled_by_default: enabled })
  }

  async setSessionOverride(sessionID: string, enabled: boolean) {
    const current = await this.load()
    return this.save({
      session_overrides: {
        ...current.session_overrides,
        [sessionID]: enabled,
      },
    })
  }
}
