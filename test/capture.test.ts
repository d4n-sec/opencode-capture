import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { mkdtemp, readFile, writeFile, mkdir, realpath } from "node:fs/promises"
import { pathToFileURL } from "node:url"

import pluginDefinition from "../src/index.js"
import { runInstall } from "../src/cli.js"
import { CapturePlugin } from "../src/core/CapturePlugin.js"
import { InteractionExporter } from "../src/core/InteractionExporter.js"
import { ProjectSettingsStore } from "../src/core/ProjectSettingsStore.js"
import { SessionArchive } from "../src/core/SessionArchive.js"
import { projectSettingsKey, projectStorageKey, resolveCaptureRoot } from "../src/utils/path.js"

async function createHarness(options: {
  enabledByDefault?: boolean
  inlineOutputLimit?: number
} = {}) {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "capture-project-"))
  const captureRoot = path.join(projectDir, ".capture")
  const input = {
    directory: projectDir,
    project: {
      id: "project-1",
    },
  }
  const plugin = new CapturePlugin(input as never, {
    captureRoot,
    enabledByDefault: options.enabledByDefault,
    inlineOutputLimit: options.inlineOutputLimit,
  })
  const hooks = plugin.createHooks() as Record<string, any>

  return {
    projectDir,
    captureRoot,
    hooks,
    archive: new SessionArchive(captureRoot, "project-1", projectStorageKey("project-1")),
    settingsStore: new ProjectSettingsStore(projectDir, {
      captureRoot,
      enabledByDefault: options.enabledByDefault,
      inlineOutputLimit: options.inlineOutputLimit,
    }, "project-1"),
  }
}

async function installFakePackage(projectDir: string) {
  const packageDir = path.join(projectDir, "node_modules", "opencode-capture")
  const entryPath = path.join(packageDir, "dist", "src", "index.js")

  await mkdir(path.dirname(entryPath), { recursive: true })
  await writeFile(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: "opencode-capture",
      type: "module",
      exports: {
        ".": "./dist/src/index.js",
      },
    }, null, 2) + "\n",
    "utf8",
  )
  await writeFile(
    entryPath,
    [
      "export default {",
      "  server: async () => ({})",
      "}",
      "",
    ].join("\n"),
    "utf8",
  )

  return entryPath
}

function escapeRegex(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function event(type: string, properties: Record<string, unknown>) {
  return {
    event: {
      type,
      properties,
    },
  }
}

test("Plugin definition exposes the OpenCode server entrypoint", async () => {
  assert.equal(pluginDefinition.id, "opencode-capture")
  const hooks = (await pluginDefinition.server(
    {
      directory: "/tmp/demo",
      project: { id: "project-1" },
    } as never,
    {},
  )) as Record<string, any>

  assert.equal(typeof hooks["chat.message"], "function")
  assert.equal(typeof hooks["experimental.chat.system.transform"], "function")
  assert.equal(typeof hooks["tool.execute.before"], "function")
  assert.equal(typeof hooks.tool.capture_export_session.execute, "function")
})

test("ProjectSettingsStore persists default capture and session overrides", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "capture-settings-"))
  const captureRoot = path.join(projectDir, ".capture-root")
  const store = new ProjectSettingsStore(projectDir, { captureRoot }, "project-1")

  const defaults = await store.load()
  assert.equal(defaults.enabled_by_default, false)
  assert.deepEqual(defaults.session_overrides, {})
  assert.equal(defaults.project_id, "project-1")

  const enabled = await store.setEnabledByDefault(true)
  assert.equal(enabled.enabled_by_default, true)
  const overridden = await store.setSessionOverride("session-1", true)
  assert.equal(overridden.session_overrides["session-1"], true)

  const persisted = JSON.parse(await readFile(await store.getSettingsPath(), "utf8")) as {
    project_id: string
    enabled_by_default: boolean
    session_overrides: Record<string, boolean>
  }
  assert.equal(persisted.project_id, "project-1")
  assert.equal(persisted.enabled_by_default, true)
  assert.equal(persisted.session_overrides["session-1"], true)
})

test("ProjectSettingsStore promotes path-scoped settings into project-scoped settings", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "capture-settings-promote-"))
  const captureRoot = path.join(projectDir, ".capture-root")
  const cliStore = new ProjectSettingsStore(projectDir, { captureRoot })

  await cliStore.setEnabledByDefault(true)

  const runtimeStore = new ProjectSettingsStore(projectDir, { captureRoot }, "project-1")
  const loaded = await runtimeStore.load()

  assert.equal(loaded.enabled_by_default, true)

  const promoted = JSON.parse(await readFile(await runtimeStore.getSettingsPath(), "utf8")) as {
    project_id: string
    enabled_by_default: boolean
  }
  assert.equal(promoted.project_id, "project-1")
  assert.equal(promoted.enabled_by_default, true)
})

test("Default capture root lives under ~/.local/share/opencode/capture_log", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "capture-root-"))
  assert.equal(
    resolveCaptureRoot(projectDir),
    path.join(os.homedir(), ".local", "share", "opencode", "capture_log"),
  )
})

test("Project storage key uses project id only", async () => {
  assert.equal(
    projectStorageKey("4741538ee6ac8553416394afb46c5c0309b65350"),
    "project-4741538ee6ac8553416394afb46c5c0309b65350",
  )
})

test("Capture stays off by default until explicitly enabled", async () => {
  const harness = await createHarness()

  await harness.hooks["chat.message"](
    {
      sessionID: "session-off",
      messageID: "msg-1",
      agent: "coder",
      model: { providerID: "demo", modelID: "kimi" },
    },
    {
      message: { role: "user" },
      parts: [{ type: "text", text: "hello" }],
    },
  )

  const events = await harness.archive.readEvents("session-off")
  assert.equal(events.length, 0)
})

test("Explicit session enable starts capture when default is off", async () => {
  const harness = await createHarness()

  await harness.hooks.tool.capture_configure_session.execute(
    {
      enabled: true,
    },
    {
      sessionID: "session-explicit",
    },
  )
  await harness.hooks["chat.message"](
    {
      sessionID: "session-explicit",
      messageID: "msg-1",
      agent: "coder",
      model: { providerID: "demo", modelID: "kimi" },
    },
    {
      message: { role: "user" },
      parts: [{ type: "text", text: "hello explicit" }],
    },
  )
  await harness.hooks.event(
    event("session.next.step.started", {
      sessionID: "session-explicit",
      agent: "coder",
      model: { providerID: "demo", modelID: "kimi" },
    }),
  )
  await harness.hooks.event(
    event("session.next.text.ended", {
      sessionID: "session-explicit",
      text: "captured response",
    }),
  )

  const events = await harness.archive.readEvents("session-explicit")
  assert.deepEqual(
    events.map((item) => item.kind),
    ["chat.user", "chat.assistant"],
  )
})

test("Default-on configuration captures a new session dialogue", async () => {
  const harness = await createHarness({ enabledByDefault: true })

  await harness.hooks.event(
    event("session.created", {
      info: {
        id: "session-new",
        title: "Fresh session",
        directory: harness.projectDir,
        path: "/tmp/fresh",
      },
    }),
  )
  await harness.hooks["chat.message"](
    {
      sessionID: "session-new",
      messageID: "msg-1",
      agent: "coder",
      model: { providerID: "demo", modelID: "kimi" },
    },
    {
      message: { role: "user" },
      parts: [{ type: "text", text: "hello new session" }],
    },
  )
  await harness.hooks.event(
    event("session.next.step.started", {
      sessionID: "session-new",
      agent: "coder",
      model: { providerID: "demo", modelID: "kimi" },
    }),
  )
  await harness.hooks.event(
    event("session.next.text.ended", {
      sessionID: "session-new",
      text: "new session answer",
    }),
  )

  const events = await harness.archive.readEvents("session-new")
  assert.deepEqual(
    events.map((item) => item.kind),
    ["session.lifecycle", "chat.user", "chat.assistant"],
  )
})

test("System prompts are captured once per unique prompt and exported as system items", async () => {
  const harness = await createHarness({ enabledByDefault: true })

  await harness.hooks["experimental.chat.system.transform"](
    {
      sessionID: "session-system",
      model: { id: "kimi" },
    },
    {
      system: ["base instruction", "tool instruction"],
    },
  )
  await harness.hooks["experimental.chat.system.transform"](
    {
      sessionID: "session-system",
      model: { id: "kimi" },
    },
    {
      system: ["base instruction", "tool instruction"],
    },
  )
  await harness.hooks["experimental.chat.system.transform"](
    {
      sessionID: "session-system",
      model: { id: "kimi" },
    },
    {
      system: ["base instruction", "different tool instruction"],
    },
  )

  const events = await harness.archive.readEvents("session-system")
  assert.deepEqual(
    events.map((item) => item.kind),
    ["system.prompt", "system.prompt"],
  )
  assert.equal((events[0]?.payload as Record<string, unknown>)?.system_scope, "main")
  assert.equal((events[1]?.payload as Record<string, unknown>)?.system_scope, "main")

  const exporter = new InteractionExporter(harness.archive, "interaction.json")
  const result = await exporter.exportSession("session-system")
  assert.deepEqual(
    result.result.items.map((item) => item.kind),
    ["system", "system"],
  )
  assert.equal(result.result.items[0]?.system_scope, "main")
  assert.equal(result.result.items[1]?.system_scope, "main")
})

test("Internal system prompts are classified separately", async () => {
  const harness = await createHarness({ enabledByDefault: true })

  await harness.hooks["experimental.chat.system.transform"](
    {
      sessionID: "session-internal",
      model: { id: "kimi" },
    },
    {
      system: [
        "You are a title generator. You output ONLY a thread title. Nothing else.",
        "Generate a brief title that would help the user find this conversation later.",
      ],
    },
  )

  const events = await harness.archive.readEvents("session-internal")
  assert.equal((events[0]?.payload as Record<string, unknown>)?.system_scope, "internal")

  const exporter = new InteractionExporter(harness.archive, "interaction.json")
  const result = await exporter.exportSession("session-internal")
  assert.equal(result.result.items[0]?.system_scope, "internal")
})

test("message.updated and message.part.updated capture real assistant output", async () => {
  const harness = await createHarness({ enabledByDefault: true })

  await harness.hooks.event(
    event("message.updated", {
      sessionID: "session-real",
      info: {
        id: "msg-assistant-1",
        role: "assistant",
        parentID: "msg-user-1",
        agent: "build",
        providerID: "opencode-go",
        modelID: "kimi-k2.6",
      },
    }),
  )
  await harness.hooks.event(
    event("message.part.updated", {
      sessionID: "session-real",
      part: {
        id: "part-reasoning-1",
        type: "reasoning",
        text: "thinking",
        messageID: "msg-assistant-1",
        time: {
          start: 1,
          end: 2,
        },
      },
    }),
  )
  await harness.hooks.event(
    event("message.part.updated", {
      sessionID: "session-real",
      part: {
        id: "part-text-1",
        type: "text",
        text: "READY",
        messageID: "msg-assistant-1",
        time: {
          start: 2,
          end: 3,
        },
      },
    }),
  )
  await harness.hooks.event(
    event("message.part.updated", {
      sessionID: "session-real",
      part: {
        id: "part-text-1",
        type: "text",
        text: "READY",
        messageID: "msg-assistant-1",
        time: {
          start: 2,
          end: 3,
        },
      },
    }),
  )

  const events = await harness.archive.readEvents("session-real")
  assert.deepEqual(
    events.map((item) => item.kind),
    ["assistant.reasoning", "chat.assistant"],
  )
  assert.equal(events[1]?.message_id, "msg-assistant-1")
  assert.equal(events[1]?.parent_message_id, "msg-user-1")
  assert.equal(events[1]?.part_id, "part-text-1")
  assert.equal(events[1]?.summary, undefined)
  assert.equal((events[1]?.payload as Record<string, unknown>)?.text, "READY")
})

test("Whitespace-only assistant parts are preserved as placeholder events", async () => {
  const harness = await createHarness({ enabledByDefault: true })

  await harness.hooks.event(
    event("message.updated", {
      sessionID: "session-whitespace",
      info: {
        id: "msg-assistant-blank",
        role: "assistant",
        parentID: "msg-user-blank",
        agent: "build",
        providerID: "opencode-go",
        modelID: "kimi-k2.6",
      },
    }),
  )
  await harness.hooks.event(
    event("message.part.updated", {
      sessionID: "session-whitespace",
      part: {
        id: "part-text-blank",
        type: "text",
        text: " ",
        messageID: "msg-assistant-blank",
        time: {
          start: 1,
          end: 2,
        },
      },
    }),
  )
  await harness.hooks.event(
    event("message.part.updated", {
      sessionID: "session-whitespace",
      part: {
        id: "part-text-real",
        type: "text",
        text: "HELLO",
        messageID: "msg-assistant-blank",
        time: {
          start: 2,
          end: 3,
        },
      },
    }),
  )

  const events = await harness.archive.readEvents("session-whitespace")
  assert.deepEqual(events.map((item) => item.kind), ["chat.assistant", "chat.assistant"])
  assert.equal(events[0]?.part_id, "part-text-blank")
  assert.equal(events[0]?.summary, "[placeholder]")
  assert.equal((events[0]?.payload as Record<string, unknown>)?.placeholder, true)
  assert.equal(events[1]?.part_id, "part-text-real")
  assert.equal(events[1]?.summary, undefined)
  assert.equal((events[1]?.payload as Record<string, unknown>)?.text, "HELLO")
})

test("Resume appends to the same session across plugin instances", async () => {
  const harness = await createHarness()

  await harness.settingsStore.setSessionOverride("session-resume", true)
  await harness.hooks["chat.message"](
    {
      sessionID: "session-resume",
      messageID: "msg-1",
      agent: "coder",
      model: { providerID: "demo", modelID: "kimi" },
    },
    {
      message: { role: "user" },
      parts: [{ type: "text", text: "first message" }],
    },
  )

  const nextPlugin = new CapturePlugin(
    {
      directory: harness.projectDir,
      project: { id: "project-1" },
    } as never,
    {
      captureRoot: harness.captureRoot,
    },
  )
  const nextHooks = nextPlugin.createHooks() as Record<string, any>
  await nextHooks.event(
    event("session.next.step.started", {
      sessionID: "session-resume",
      agent: "coder",
      model: { providerID: "demo", modelID: "kimi" },
    }),
  )
  await nextHooks.event(
    event("session.next.text.ended", {
      sessionID: "session-resume",
      text: "resumed answer",
    }),
  )

  const events = await harness.archive.readEvents("session-resume")
  assert.equal(events.length, 2)
  assert.deepEqual(events.map((item) => item.seq), [1, 2])
})

test("Child sessions inherit capture and do not mix files with the parent", async () => {
  const harness = await createHarness()

  await harness.settingsStore.setSessionOverride("session-root", true)
  await harness.hooks.event(
    event("session.created", {
      info: {
        id: "session-child",
        parentID: "session-root",
        title: "Child session",
        directory: harness.projectDir,
      },
    }),
  )
  await harness.hooks["chat.message"](
    {
      sessionID: "session-root",
      messageID: "msg-root",
      agent: "coder",
      model: { providerID: "demo", modelID: "kimi" },
    },
    {
      message: { role: "user" },
      parts: [{ type: "text", text: "root only" }],
    },
  )
  await harness.hooks["chat.message"](
    {
      sessionID: "session-child",
      messageID: "msg-child",
      agent: "search",
      model: { providerID: "demo", modelID: "kimi" },
    },
    {
      message: { role: "user" },
      parts: [{ type: "text", text: "child only" }],
    },
  )

  const rootEvents = await harness.archive.readEvents("session-root")
  const childEvents = await harness.archive.readEvents("session-child")

  assert.equal(rootEvents.some((item) => item.summary === "child only"), false)
  assert.deepEqual(
    childEvents.map((item) => item.kind),
    ["session.lifecycle", "chat.user"],
  )
})

test("InteractionExporter emits ordered plain interaction items", async () => {
  const captureRoot = await mkdtemp(path.join(os.tmpdir(), "capture-export-"))
  const archive = new SessionArchive(captureRoot, "project-1")

  await archive.updateMeta("session-1", {
    title: "Demo session",
    directory: "/tmp/demo",
  })
  await archive.appendEvent("session-1", {
    kind: "chat.user",
    source: "chat.message",
    summary: "hello",
    payload: { text: "hello" },
  })
  await archive.appendEvent("session-1", {
    kind: "tool.result",
    source: "tool.execute.after",
    summary: "listed files",
    call_id: "call-1",
    payload: { output: "listed files" },
  })
  await archive.appendEvent("session-1", {
    kind: "chat.assistant",
    source: "session.next.text.ended",
    summary: "done",
    payload: { text: "done", agent: "coder" },
  })

  const exporter = new InteractionExporter(archive, "interaction.json")
  const result = await exporter.exportSession("session-1")

  assert.equal(result.result.items.length, 3)
  assert.deepEqual(
    result.result.items.map((item) => item.kind),
    ["user", "tool", "assistant"],
  )
  assert.equal(result.result.items[2]?.agent, "coder")
  assert.match(result.outputPath, /interaction\.json$/)
})

test("Raw jsonl writes summary and payload before id fields", async () => {
  const captureRoot = await mkdtemp(path.join(os.tmpdir(), "capture-order-"))
  const archive = new SessionArchive(captureRoot, "project-1")

  await archive.appendEvent("session-order", {
    kind: "shell.command",
    source: "tool.execute.after",
    summary: "Command output",
    payload: {
      output: "hello",
    },
    call_id: "call-1",
  })

  const raw = await readFile(path.join(captureRoot, "project-1", "session-order", "raw", "events.jsonl"), "utf8")
  const line = raw.trim()

  assert.ok(line.indexOf('"summary"') < line.indexOf('"project_id"'))
  assert.ok(line.indexOf('"payload"') < line.indexOf('"event_id"'))
  assert.ok(line.indexOf('"event_id"') > line.indexOf('"occurred_at"'))
  assert.ok(line.indexOf('"schema_version"') > line.indexOf('"event_id"'))
})

test("InteractionExporter marks whitespace-only assistant items as placeholders", async () => {
  const captureRoot = await mkdtemp(path.join(os.tmpdir(), "capture-export-blank-"))
  const archive = new SessionArchive(captureRoot, "project-1")

  await archive.updateMeta("session-export-blank", {
    title: "Blank export session",
    directory: "/tmp/demo",
  })
  await archive.appendEvent("session-export-blank", {
    kind: "chat.assistant",
    source: "message.part.updated",
    summary: " ",
    payload: { text: " " },
  })
  await archive.appendEvent("session-export-blank", {
    kind: "chat.assistant",
    source: "message.part.updated",
    summary: "VISIBLE",
    payload: { text: "VISIBLE" },
  })

  const exporter = new InteractionExporter(archive, "interaction.json")
  const result = await exporter.exportSession("session-export-blank")

  assert.equal(result.result.items.length, 2)
  assert.equal(result.result.items[0]?.summary, "[placeholder]")
  assert.equal(result.result.items[1]?.summary, "VISIBLE")
})

test("install writes local plugin bridge and default settings", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "capture-install-"))
  const entryPath = await installFakePackage(projectDir)
  const captureRoot = path.join(projectDir, ".capture-root")

  await runInstall({
    command: "install",
    projectDirectory: projectDir,
    captureRoot,
  })

  const bridge = await readFile(path.join(projectDir, ".opencode", "plugins", "opencode-capture.js"), "utf8")
  const settingsPath = path.join(captureRoot, "_settings", `${projectSettingsKey(projectDir)}.json`)
  const settings = JSON.parse(
    await readFile(settingsPath, "utf8"),
  ) as Record<string, unknown>

  assert.match(bridge, new RegExp(escapeRegex(pathToFileURL(await realpath(entryPath)).href)))
  assert.match(bridge, /return plugin\.server\(input, options\)/)
  assert.equal(settings.enabled_by_default, false)
  assert.equal(settings.capture_root, captureRoot)
})

test("install fails when project package is missing", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "capture-install-missing-"))

  await assert.rejects(
    runInstall({
      command: "install",
      projectDirectory: projectDir,
    }),
    /Project install requires a local package install/,
  )
})

test("install removes existing npm plugin entry to avoid duplicate loading", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "capture-install-config-"))
  const configDir = path.join(projectDir, ".opencode")
  const captureRoot = path.join(projectDir, ".capture-root")
  await installFakePackage(projectDir)
  await mkdir(configDir, { recursive: true })
  await writeFile(
    path.join(configDir, "opencode.json"),
    JSON.stringify({
      plugin: ["opencode-capture", "other-plugin", ["opencode-capture@0.1.0", { foo: "bar" }]],
      model: "demo-model",
    }, null, 2) + "\n",
    "utf8",
  )

  await runInstall({
    command: "install",
    projectDirectory: projectDir,
    captureRoot,
  })

  const config = JSON.parse(await readFile(path.join(configDir, "opencode.json"), "utf8")) as Record<string, unknown>
  assert.deepEqual(config.plugin, ["other-plugin"])
  assert.equal(config.model, "demo-model")
})

test("Parent and child agent sessions export as one linked interaction flow", async () => {
  const harness = await createHarness({ enabledByDefault: true })

  await harness.hooks["experimental.chat.system.transform"](
    {
      sessionID: "session-root",
      model: { id: "kimi" },
    },
    {
      system: ["root system prompt"],
    },
  )
  await harness.hooks["chat.message"](
    {
      sessionID: "session-root",
      messageID: "msg-root",
      agent: "coder",
      model: { providerID: "demo", modelID: "kimi" },
    },
    {
      message: { role: "user" },
      parts: [{ type: "text", text: "root prompt" }],
    },
  )
  await harness.hooks["tool.execute.before"](
    {
      sessionID: "session-root",
      tool: "task",
      callID: "call-task-1",
    },
    {
      args: {
        agent: "search",
        description: "run subagent",
      },
    },
  )
  await harness.hooks["tool.execute.after"](
    {
      sessionID: "session-root",
      tool: "task",
      callID: "call-task-1",
      args: {
        description: "run subagent",
      },
    },
    {
      title: "Task started",
      output: "subagent launched",
      metadata: {
        sessionId: "session-child",
      },
    },
  )
  await harness.hooks.event(
    event("session.created", {
      info: {
        id: "session-child",
        parentID: "session-root",
        title: "Child session",
        directory: harness.projectDir,
      },
    }),
  )
  await harness.hooks["experimental.chat.system.transform"](
    {
      sessionID: "session-child",
      model: { id: "kimi" },
    },
    {
      system: ["child system prompt"],
    },
  )
  await harness.hooks.event(
    event("session.next.step.started", {
      sessionID: "session-child",
      agent: "search",
      model: { providerID: "demo", modelID: "kimi" },
    }),
  )
  await harness.hooks.event(
    event("session.next.text.ended", {
      sessionID: "session-child",
      text: "child result",
    }),
  )
  await harness.hooks.event(
    event("session.next.step.started", {
      sessionID: "session-root",
      agent: "coder",
      model: { providerID: "demo", modelID: "kimi" },
    }),
  )
  await harness.hooks.event(
    event("session.next.text.ended", {
      sessionID: "session-root",
      text: "root answer",
    }),
  )

  const exporter = new InteractionExporter(harness.archive, "interaction.json")
  const result = await exporter.exportSession("session-root")

  assert.equal(result.result.linked_sessions?.length, 1)
  assert.equal(result.result.linked_sessions?.[0]?.id, "session-child")
  const subagentCall = result.result.items.find((item) => item.kind === "subagent")
  const childAssistant = result.result.items.find((item) => item.session_id === "session-child" && item.kind === "assistant")
  const rootSystem = result.result.items.find((item) => item.session_id === "session-root" && item.kind === "system")
  const childSystem = result.result.items.find((item) => item.session_id === "session-child" && item.kind === "system")
  assert.equal(subagentCall?.linked_session_id, "session-child")
  assert.equal(childAssistant?.origin_call_id, "call-task-1")
  assert.equal(rootSystem?.summary, "root system prompt")
  assert.equal(childSystem?.summary, "child system prompt")
  assert.equal(rootSystem?.system_scope, "main")
  assert.equal(childSystem?.system_scope, "subagent")
  assert.equal(childSystem?.origin_call_id, "call-task-1")
  assert.equal(result.result.items.at(-1)?.summary, "root answer")
})

test("Tool calls capture arguments and final results", async () => {
  const harness = await createHarness({ enabledByDefault: true })

  await harness.hooks["tool.execute.before"](
    {
      sessionID: "session-tool",
      tool: "read_file",
      callID: "call-tool-1",
    },
    {
      args: {
        file_path: "/tmp/demo.txt",
      },
    },
  )
  await harness.hooks["tool.execute.after"](
    {
      sessionID: "session-tool",
      tool: "read_file",
      callID: "call-tool-1",
      args: {
        file_path: "/tmp/demo.txt",
      },
    },
    {
      title: "Read file",
      output: "demo content",
      metadata: {
        bytes: 12,
      },
    },
  )

  const events = await harness.archive.readEvents("session-tool")
  assert.deepEqual(
    events.map((item) => item.kind),
    ["tool.call", "tool.result"],
  )
  assert.equal((events[0]?.payload as Record<string, unknown>)?.tool, "read_file")
  assert.equal(((events[1]?.payload as Record<string, unknown>)?.args as Record<string, unknown>)?.file_path, "/tmp/demo.txt")
})

test("Shell commands capture parameters, exit codes, and failures", async () => {
  const harness = await createHarness({ enabledByDefault: true })

  await harness.hooks["tool.execute.after"](
    {
      sessionID: "session-shell",
      tool: "bash",
      callID: "call-shell-1",
      args: {
        command: "date +%s",
      },
    },
    {
      title: "Shell command",
      output: "1716000000",
      metadata: {
        exit: 0,
      },
    },
  )
  await harness.hooks.event(
    event("session.next.tool.failed", {
      sessionID: "session-shell",
      callID: "call-shell-2",
      tool: "bash",
      error: {
        message: "permission denied",
      },
    }),
  )

  const events = await harness.archive.readEvents("session-shell")
  assert.deepEqual(
    events.map((item) => item.kind),
    ["shell.command", "tool.result"],
  )
  assert.equal((events[0]?.payload as Record<string, unknown>)?.command, "date +%s")
  assert.equal((events[0]?.payload as Record<string, unknown>)?.exit, 0)
  assert.equal(events[1]?.summary, "permission denied")
})

test("Approval flows capture both automatic and manual decisions", async () => {
  const harness = await createHarness({ enabledByDefault: true })

  await harness.hooks["permission.ask"](
    {
      sessionID: "session-approval",
      id: "approval-auto",
      permission: "bash",
      patterns: ["date"],
      tool: {
        callID: "call-auto",
      },
    },
    {
      status: "allow",
    },
  )
  await harness.hooks["permission.ask"](
    {
      sessionID: "session-approval",
      id: "approval-manual",
      permission: "edit",
      patterns: ["src/**"],
      tool: {
        callID: "call-manual",
      },
    },
    {
      status: "ask",
    },
  )
  await harness.hooks.event(
    event("permission.asked", {
      sessionID: "session-approval",
      id: "approval-manual",
      tool: {
        callID: "call-manual",
      },
      permission: "edit",
    }),
  )
  await harness.hooks.event(
    event("permission.replied", {
      sessionID: "session-approval",
      requestID: "approval-manual",
      reply: "approved",
    }),
  )

  const events = await harness.archive.readEvents("session-approval")
  assert.deepEqual(
    events.map((item) => item.kind),
    ["approval.evaluated", "approval.evaluated", "approval.requested", "approval.resolved"],
  )
  assert.equal((events[0]?.payload as Record<string, unknown>)?.decision, "auto_allow")
  assert.equal((events[1]?.payload as Record<string, unknown>)?.decision, "ask")
})

test("Compaction hooks and lifecycle events are captured", async () => {
  const harness = await createHarness({ enabledByDefault: true })

  await harness.hooks["experimental.session.compacting"]({
    sessionID: "session-compact",
  })
  await harness.hooks.event(
    event("session.next.compaction.started", {
      sessionID: "session-compact",
      reason: "token_limit",
    }),
  )
  await harness.hooks.event(
    event("session.next.compaction.ended", {
      sessionID: "session-compact",
      text: "summary text",
    }),
  )

  const events = await harness.archive.readEvents("session-compact")
  assert.deepEqual(
    events.map((item) => item.kind),
    ["compaction", "compaction", "compaction"],
  )
  assert.match(events[1]?.summary ?? "", /token_limit/)
  assert.equal(events[2]?.summary, "summary text")
})

test("Child approval and failure events inherit the origin call id", async () => {
  const captureRoot = await mkdtemp(path.join(os.tmpdir(), "capture-child-approval-"))
  const archive = new SessionArchive(captureRoot, "project-1")

  await archive.updateMeta("session-root", {
    title: "Root session",
    directory: "/tmp/demo",
  })
  await archive.updateMeta("session-child", {
    title: "Child session",
    directory: "/tmp/demo",
    parent_session_id: "session-root",
  })

  await archive.appendEvent("session-root", {
    kind: "subagent.call",
    source: "tool.execute.before",
    summary: "run subagent",
    occurred_at: "2026-01-01T00:00:01.000Z",
    call_id: "call-task-2",
    payload: { agent: "search", description: "run subagent" },
  })
  await archive.appendEvent("session-root", {
    kind: "tool.result",
    source: "tool.execute.after",
    summary: "subagent launched",
    occurred_at: "2026-01-01T00:00:01.500Z",
    call_id: "call-task-2",
    payload: {
      tool: "task",
      metadata: {
        sessionId: "session-child",
      },
    },
  })
  await archive.appendEvent("session-child", {
    kind: "approval.requested",
    source: "permission.asked",
    occurred_at: "2026-01-01T00:00:02.000Z",
    request_id: "approval-1",
    call_id: "child-tool-1",
    summary: "Approval requested",
    payload: {
      permission: "bash",
      patterns: ["date"],
    },
  })
  await archive.appendEvent("session-child", {
    kind: "tool.result",
    source: "session.next.tool.failed",
    occurred_at: "2026-01-01T00:00:03.000Z",
    call_id: "child-tool-1",
    summary: "Tool failed",
    payload: {
      error: { message: "denied" },
      tool: "bash",
    },
  })

  const exporter = new InteractionExporter(archive, "interaction.json")
  const result = await exporter.exportSession("session-root")

  const approval = result.result.items.find((item) => item.kind === "approval")
  const childFailure = result.result.items.find(
    (item) => item.session_id === "session-child" && item.kind === "tool" && item.call_id === "child-tool-1",
  )

  assert.equal(approval?.origin_call_id, "call-task-2")
  assert.equal(approval?.parent_session_id, "session-root")
  assert.equal(childFailure?.origin_call_id, "call-task-2")
  assert.equal(childFailure?.parent_session_id, "session-root")
})
