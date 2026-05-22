import { copyFile, mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, "..")
const releaseDir = path.join(projectRoot, "tmp", "release")

async function main() {
  const pkg = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"))
  const tarballBaseName = `${pkg.name}-${pkg.version}`
  const tgzName = `${tarballBaseName}.tgz`
  const tarGzName = `${tarballBaseName}.tar.gz`

  await mkdir(releaseDir, { recursive: true })
  await run("npm", ["run", "build"])
  await run("npm", ["pack", "--pack-destination", releaseDir])
  await copyFile(path.join(releaseDir, tgzName), path.join(releaseDir, tarGzName))

  console.log(`Release assets ready in ${releaseDir}`)
  console.log(`- ${tgzName}`)
  console.log(`- ${tarGzName}`)
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: "inherit",
      env: process.env,
    })

    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${String(code)}`))
    })
  })
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
