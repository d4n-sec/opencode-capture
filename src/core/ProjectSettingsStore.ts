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
  private readonly pathScopedSettingsKey: string

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
    this.pathScopedSettingsKey = projectSettingsKey(this.projectDirectory)
  }

  async getSettingsPath() {
    return this.buildSettingsPath(await this.resolveSettingsKey())
  }

  getCaptureRoot() {
    return this.captureRoot
  }

  private getProjectMapPath() {
    return path.join(this.settingsDirectory, "project-map.json")
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

  private async readProjectMap(): Promise<Record<string, string>> {
    return (await this.readOptionalJson<Record<string, string>>(this.getProjectMapPath())) ?? {}
  }

  private async writeProjectMap(map: Record<string, string>) {
    await mkdir(this.settingsDirectory, { recursive: true })
    await writeFile(this.getProjectMapPath(), JSON.stringify(map, null, 2) + "\n", "utf8")
  }

  private async resolveSettingsKey() {
    if (this.projectID) {
      return projectSettingsKey(this.projectDirectory, this.projectID)
    }

    const projectMap = await this.readProjectMap()
    const mappedProjectID = projectMap[this.projectDirectory]
    if (mappedProjectID) {
      return projectSettingsKey(this.projectDirectory, mappedProjectID)
    }

    return this.pathScopedSettingsKey
  }

  private async getPrimarySettingsPath() {
    return this.buildSettingsPath(await this.resolveSettingsKey())
  }

  private getFallbackSettingsPath() {
    return this.buildSettingsPath(this.pathScopedSettingsKey)
  }

  private async syncProjectMapping() {
    if (!this.projectID) return

    const projectMap = await this.readProjectMap()
    if (projectMap[this.projectDirectory] === this.projectID) return

    projectMap[this.projectDirectory] = this.projectID
    await this.writeProjectMap(projectMap)
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

  async load(): Promise<ProjectSettings> {
    await this.syncProjectMapping()
    const defaults = this.getDefaultSettings()
    const primaryPath = await this.getPrimarySettingsPath()
    const fallbackPath = this.getFallbackSettingsPath()
    const parsed =
      (await this.readOptionalJson<Partial<ProjectSettings>>(primaryPath)) ??
      (primaryPath === fallbackPath
        ? undefined
        : await this.readOptionalJson<Partial<ProjectSettings>>(fallbackPath))

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

    if (this.projectID && primaryPath !== fallbackPath && parsed && !(await this.readOptionalJson(primaryPath))) {
      await this.writeSettings(primaryPath, next)
    }

    return next
  }

  private async writeSettings(filePath: string, settings: ProjectSettings) {
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(settings, null, 2) + "\n", "utf8")
  }

  async ensureInitialized() {
    const settingsPath = await this.getPrimarySettingsPath()
    const existing = await this.readOptionalJson<ProjectSettings>(settingsPath)
    if (existing) {
      return {
        settings: await this.load(),
        created: false,
        path: settingsPath,
      }
    }

    const settings = this.getDefaultSettings()
    await this.writeSettings(settingsPath, settings)
    await this.syncProjectMapping()
    return {
      settings,
      created: true,
      path: settingsPath,
    }
  }

  async save(input: Partial<ProjectSettings>): Promise<ProjectSettings> {
    await this.syncProjectMapping()
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
    await this.writeSettings(await this.getPrimarySettingsPath(), next)
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
