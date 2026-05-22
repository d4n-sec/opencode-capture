#!/usr/bin/env node

import { access, readdir, readFile, writeFile, mkdir } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import os from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"

import { InteractionExporter } from "./core/InteractionExporter.js"
import { ProjectSettingsStore } from "./core/ProjectSettingsStore.js"
import { SessionArchive } from "./core/SessionArchive.js"
import type { CapturePluginOptions } from "./domain/types.js"

type ParsedArgs = {
  command?: string
  sessionID?: string
  projectDirectory: string
  captureRoot?: string
  global?: boolean
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))

  switch (parsed.command) {
    case "install": {
      await runInstall(parsed)
      return
    }
    case "enable": {
      const settingsStore = new ProjectSettingsStore(parsed.projectDirectory, {
        captureRoot: parsed.captureRoot,
      } satisfies CapturePluginOptions)
      const settings = await settingsStore.setEnabledByDefault(true)
      console.log(`Capture enabled by default: ${settings.enabled_by_default}`)
      console.log(`Capture root: ${settings.capture_root}`)
      return
    }
    case "disable": {
      const settingsStore = new ProjectSettingsStore(parsed.projectDirectory, {
        captureRoot: parsed.captureRoot,
      } satisfies CapturePluginOptions)
      const settings = await settingsStore.setEnabledByDefault(false)
      console.log(`Capture enabled by default: ${settings.enabled_by_default}`)
      console.log(`Capture root: ${settings.capture_root}`)
      return
    }
    case "status": {
      const settingsStore = new ProjectSettingsStore(parsed.projectDirectory, {
        captureRoot: parsed.captureRoot,
      } satisfies CapturePluginOptions)
      const settings = await settingsStore.load()
      console.log(JSON.stringify(settings, null, 2))
      return
    }
    case "enable-session":
    case "disable-session": {
      if (!parsed.sessionID) {
        throw new Error("Missing --session <session-id> for session override")
      }
      const settingsStore = new ProjectSettingsStore(parsed.projectDirectory, {
        captureRoot: parsed.captureRoot,
      } satisfies CapturePluginOptions)
      const settings = await settingsStore.setSessionOverride(parsed.sessionID, parsed.command === "enable-session")
      console.log(
        `Capture for session ${parsed.sessionID}: ${String(settings.session_overrides[parsed.sessionID] ?? false)}`,
      )
      return
    }
    case "export": {
      if (!parsed.sessionID) {
        throw new Error("Missing --session <session-id> for export")
      }
      const settingsStore = new ProjectSettingsStore(parsed.projectDirectory, {
        captureRoot: parsed.captureRoot,
      } satisfies CapturePluginOptions)
      const settings = await settingsStore.load()
      const projectID = await findProjectIDForSession(
        settings.capture_root,
        parsed.sessionID,
        path.basename(parsed.projectDirectory),
      )
      const archive = new SessionArchive(settings.capture_root, projectID)
      const exporter = new InteractionExporter(archive, settings.export_file_name)
      const result = await exporter.exportSession(parsed.sessionID)
      console.log(result.outputPath)
      return
    }
    default:
      printHelp()
  }
}

export async function runInstall(parsed: ParsedArgs) {
  const isGlobal = parsed.global ?? false
  type InstallConfig = Record<string, unknown> & { plugin?: unknown[] }

  let configDir: string
  if (isGlobal) {
    configDir = path.join(os.homedir(), ".config", "opencode")
  } else {
    configDir = path.join(parsed.projectDirectory, ".opencode")
  }

  const configPath = path.join(configDir, "opencode.json")
  let config: InstallConfig = {}

  try {
    const raw = await readFile(configPath, "utf-8")
    config = JSON.parse(raw)
  } catch {
    // Config does not exist yet, start fresh
  }

  const pluginDir = path.join(configDir, "plugins")
  const bridgePath = path.join(pluginDir, "opencode-capture.js")
  const settingsStore = new ProjectSettingsStore(parsed.projectDirectory, {
    captureRoot: parsed.captureRoot,
  } satisfies CapturePluginOptions)
  const packageEntry = isGlobal ? await resolveCurrentPackageEntry() : resolveInstalledPackageEntry(parsed.projectDirectory)
  if (isGlobal && isLikelyEphemeralPackagePath(packageEntry)) {
    throw new Error(
      "Global install must run from a real global package install. Run `npm install -g opencode-capture` first, then `opencode-capture install --global`.",
    )
  }
  const bridgeSource = createBridgeSource(packageEntry)

  await mkdir(pluginDir, { recursive: true })
  await writeFile(bridgePath, bridgeSource, "utf-8")
  console.log(`Wrote plugin bridge to ${bridgePath}`)

  if (Array.isArray(config.plugin)) {
    const before = config.plugin.length
    config.plugin = config.plugin.filter((entry) => {
      if (typeof entry === "string") {
        return !entry.startsWith("opencode-capture")
      }
      if (Array.isArray(entry) && typeof entry[0] === "string") {
        return !entry[0].startsWith("opencode-capture")
      }
      return true
    })
    if (config.plugin.length !== before) {
      await mkdir(configDir, { recursive: true })
      await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8")
      console.log(`Removed opencode-capture npm plugin entry from ${configPath}`)
    }
  }

  const settingsInit = await settingsStore.ensureInitialized()
  if (settingsInit.created) {
    console.log(`Created default settings at ${settingsInit.path}`)
  } else {
    console.log(`Settings already exist at ${settingsInit.path}`)
  }

  if (isGlobal) {
    console.log("\nInstalled globally. OpenCode will auto-load ~/.config/opencode/plugins/opencode-capture.js.")
  } else {
    console.log(`\nInstalled in ${parsed.projectDirectory}. OpenCode will auto-load .opencode/plugins/opencode-capture.js.`)
  }
  console.log("\nUsage:")
  console.log("  opencode                         Start OpenCode with capture auto-loaded")
  console.log("  opencode-capture enable         Enable capture (default off)")
  console.log("  opencode-capture disable        Disable capture")
  console.log("  opencode-capture status         Show current settings")
  console.log("  opencode-capture export --session <id>   Export a session")
}

function createBridgeSource(packageEntry: string) {
  const importSpecifier = JSON.stringify(pathToFileURL(packageEntry).href)
  return [
    `import plugin from ${importSpecifier}`,
    "",
    "export const OpencodeCapturePlugin = async (input, options) => {",
    "  return plugin.server(input, options)",
    "}",
    "",
  ].join("\n")
}

function resolveInstalledPackageEntry(projectDirectory: string) {
  const projectRequire = createRequire(path.join(projectDirectory, "__opencode_capture__.cjs"))
  try {
    return projectRequire.resolve("opencode-capture")
  } catch {
    throw new Error(
      "Project install requires a local package install. Run `npm install opencode-capture` first, then `npx opencode-capture install`.",
    )
  }
}

async function resolveCurrentPackageEntry() {
  const candidates = [
    new URL("./index.js", import.meta.url),
    new URL("../dist/src/index.js", import.meta.url),
  ]

  for (const candidate of candidates) {
    try {
      await access(fileURLToPath(candidate))
      return fileURLToPath(candidate)
    } catch {
      // Keep scanning other package entry candidates.
    }
  }

  throw new Error("Could not resolve the installed opencode-capture package entry for bridge generation.")
}

function isLikelyEphemeralPackagePath(packageEntry: string) {
  return /(?:^|[/\\])_npx(?:[/\\]|$)|(?:^|[/\\])dlx(?:[/\\]|$)/.test(packageEntry)
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectDirectory: process.cwd(),
  }
  const [command, ...rest] = args
  parsed.command = command

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]
    if (value === "--project") {
      parsed.projectDirectory = path.resolve(rest[index + 1] ?? parsed.projectDirectory)
      index += 1
      continue
    }
    if (value === "--session") {
      parsed.sessionID = rest[index + 1]
      index += 1
      continue
    }
    if (value === "--root") {
      parsed.captureRoot = rest[index + 1]
      index += 1
      continue
    }
    if (value === "--global" || value === "-g") {
      parsed.global = true
      continue
    }
  }
  return parsed
}

function printHelp() {
  console.log(`opencode-capture <command>

Commands:
  install                 Install opencode-capture into current project (or --global)
  enable                  Enable capture by default for this project
  disable                 Disable capture by default for this project
  enable-session          Enable capture for one session
  disable-session         Disable capture for one session
  status                  Print current capture settings
  export --session <id>   Export one captured session as interaction.json

Options:
  --project <dir>         Target project directory (defaults to cwd)
  --root <dir>            Override capture root directory
  --global, -g            Install globally (for all projects)
`)
}

async function findProjectIDForSession(captureRoot: string, sessionID: string, fallback: string) {
  try {
    const projectDirs = await readdir(captureRoot, { withFileTypes: true })
    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory()) continue
      const candidate = path.join(captureRoot, projectDir.name, sessionID)
      try {
        const stat = await readdir(candidate)
        if (stat.length >= 0) return projectDir.name
      } catch {
        // Keep scanning other project directories.
      }
    }
  } catch {
    // Fall back to the current directory basename if the root is missing.
  }
  return fallback
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
