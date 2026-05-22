import path from "node:path"

export function resolveCaptureRoot(projectDirectory: string, explicitRoot?: string) {
  if (explicitRoot && explicitRoot.trim().length > 0) {
    return path.isAbsolute(explicitRoot) ? explicitRoot : path.resolve(projectDirectory, explicitRoot)
  }
  return path.join(projectDirectory, ".opencode", "capture_log")
}

export function projectStorageKey(projectDirectory: string, projectID: string) {
  const baseName = path.basename(projectDirectory) || "project"
  const safeBaseName = baseName.replace(/[^a-zA-Z0-9._-]+/g, "-")
  const shortID = projectID.slice(0, 6)
  return `${safeBaseName}-${shortID}`
}

export function sessionDirectory(captureRoot: string, projectKey: string, sessionID: string) {
  return path.join(captureRoot, projectKey, sessionID)
}
