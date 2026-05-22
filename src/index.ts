#!/usr/bin/env node

import type { Plugin } from "@opencode-ai/plugin"

import type { CapturePluginOptions } from "./domain/types.js"
import { CapturePlugin } from "./core/CapturePlugin.js"

const server: Plugin = async (input, options) => {
  const plugin = new CapturePlugin(input, (options ?? {}) as CapturePluginOptions)
  return plugin.createHooks()
}

export default {
  id: "opencode-capture",
  server,
}

export { CapturePlugin }
export type { CapturePluginOptions }
