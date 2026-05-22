import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import type { CapturePluginOptions, ProjectSettings } from "../domain/types.js"
import { resolveCaptureRoot } from "../utils/path.js"

export class ProjectSettingsStore {
  private readonly captureRoot: string
  private readonly settingsFileName: string
  private readonly exportFileName: string
  private readonly inlineOutputLimit: number
  private readonly enabledByDefault: boolean

  constructor(
    projectDirectory: string,
    options: CapturePluginOptions = {},
  ) {
    this.captureRoot = resolveCaptureRoot(projectDirectory, options.captureRoot)
    this.settingsFileName = options.settingsFileName ?? "settings.json"
    this.exportFileName = options.exportFileName ?? "interaction.json"
    this.inlineOutputLimit = options.inlineOutputLimit ?? 16_000
    this.enabledByDefault = options.enabledByDefault ?? false
  }

  getSettingsPath() {
    return path.join(this.captureRoot, this.settingsFileName)
  }

  getCaptureRoot() {
    return this.captureRoot
  }

  private getDefaultSettings(): ProjectSettings {
    return {
      enabled_by_default: this.enabledByDefault,
      session_overrides: {},
      capture_root: this.captureRoot,
      inline_output_limit: this.inlineOutputLimit,
      settings_file_name: this.settingsFileName,
      export_file_name: this.exportFileName,
    }
  }

  async load(): Promise<ProjectSettings> {
    const defaults = this.getDefaultSettings()
    try {
      const content = await readFile(this.getSettingsPath(), "utf8")
      const parsed = JSON.parse(content) as Partial<ProjectSettings>
      return {
        ...defaults,
        ...parsed,
        session_overrides: parsed.session_overrides ?? defaults.session_overrides,
        capture_root: defaults.capture_root,
        settings_file_name: defaults.settings_file_name,
        export_file_name: parsed.export_file_name ?? defaults.export_file_name,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return defaults
      }
      throw error
    }
  }

  async save(input: Partial<ProjectSettings>): Promise<ProjectSettings> {
    const current = await this.load()
    const next = {
      ...current,
      ...input,
      session_overrides: input.session_overrides ?? current.session_overrides,
      capture_root: this.captureRoot,
      settings_file_name: this.settingsFileName,
    }
    await mkdir(this.captureRoot, { recursive: true })
    await writeFile(this.getSettingsPath(), JSON.stringify(next, null, 2) + "\n", "utf8")
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
