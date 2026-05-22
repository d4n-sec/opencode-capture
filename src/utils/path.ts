import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"

export function resolveCaptureRoot(projectDirectory: string, explicitRoot?: string) {
  if (explicitRoot && explicitRoot.trim().length > 0) {
    return path.isAbsolute(explicitRoot) ? explicitRoot : path.resolve(projectDirectory, explicitRoot)
  }
  return path.join(os.homedir(), ".local", "share", "opencode", "capture_log")
}

export function projectStorageKey(projectID: string) {
  return `project-${sanitizePathSegment(projectID)}`
}

export function projectSettingsKey(projectDirectory: string, projectID?: string) {
  if (projectID && projectID.trim().length > 0) {
    return `project-${sanitizePathSegment(projectID)}`
  }

  const normalizedDirectory = path.resolve(projectDirectory)
  const baseName = path.basename(normalizedDirectory) || "project"
  const safeBaseName = sanitizePathSegment(baseName)
  const hash = createHash("sha1").update(normalizedDirectory).digest("hex").slice(0, 12)
  return `path-${safeBaseName}-${hash}`
}

export function sessionDirectory(captureRoot: string, projectKey: string, sessionID: string) {
  return path.join(captureRoot, projectKey, sessionID)
}

function sanitizePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-")
}
