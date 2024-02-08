import fs from "fs-extra"
import { dirname, join, relative, resolve } from "path"
import { ParsedPatchFile, FilePatch, Hunk } from "./parse.js"
import { assertNever } from "../assertNever.js"

export const executeEffects = (
  effects: ParsedPatchFile,
  {
    dryRun,
    bestEffort,
    errors,
    cwd,
  }: { dryRun: boolean; cwd?: string; errors?: string[]; bestEffort: boolean },
) => {
  const inCwd = (path: string) => (cwd ? join(cwd, path) : path)
  const humanReadable = (path: string) => relative(process.cwd(), inCwd(path))
  effects.forEach((eff) => {
    switch (eff.type) {
      case "file deletion":
        if (dryRun) {
          if (!fs.existsSync(inCwd(eff.path))) {
            throw new Error(
              "Trying to delete file that doesn't exist: " +
                humanReadable(eff.path),
            )
          }
        } else {
          // TODO: integrity checks
          try {
            fs.unlinkSync(inCwd(eff.path))
          } catch (e) {
            if (bestEffort) {
              errors?.push(`Failed to delete file ${eff.path}`)
            } else {
              throw e
            }
          }
        }
        break
      case "rename":
        if (dryRun) {
          // TODO: see what patch files look like if moving to exising path
          if (!fs.existsSync(inCwd(eff.fromPath))) {
            throw new Error(
              "Trying to move file that doesn't exist: " +
                humanReadable(eff.fromPath),
            )
          }
        } else {
          try {
            fs.moveSync(inCwd(eff.fromPath), inCwd(eff.toPath))
          } catch (e) {
            if (bestEffort) {
              errors?.push(
                `Failed to rename file ${eff.fromPath} to ${eff.toPath}`,
              )
            } else {
              throw e
            }
          }
        }
        break
      case "file creation":
        if (dryRun) {
          if (fs.existsSync(inCwd(eff.path))) {
            throw new Error(
              "Trying to create file that already exists: " +
                humanReadable(eff.path),
            )
          }
          // todo: check file contents matches
        } else {
          const fileContents = eff.hunk
            ? eff.hunk.parts[0].lines.join("\n") +
              (eff.hunk.parts[0].noNewlineAtEndOfFile ? "" : "\n")
            : ""
          const path = inCwd(eff.path)
          try {
            fs.ensureDirSync(dirname(path))
            fs.writeFileSync(path, fileContents, { mode: eff.mode })
          } catch (e) {
            if (bestEffort) {
              errors?.push(`Failed to create new file ${eff.path}`)
            } else {
              throw e
            }
          }
        }
        break
      case "patch":
        applyPatch(eff, { dryRun, cwd, bestEffort, errors })
        break
      case "mode change":
        const currentMode = fs.statSync(inCwd(eff.path)).mode
        if (
          ((isExecutable(eff.newMode) && isExecutable(currentMode)) ||
            (!isExecutable(eff.newMode) && !isExecutable(currentMode))) &&
          dryRun
        ) {
          console.log(
            `Mode change is not required for file ${humanReadable(eff.path)}`,
          )
        }
        fs.chmodSync(inCwd(eff.path), eff.newMode)
        break
      default:
        assertNever(eff)
    }
  })
}

function isExecutable(fileMode: number) {
  // tslint:disable-next-line:no-bitwise
  return (fileMode & 0b001_000_000) > 0
}

const trimRight = (s: string) => s.replace(/\s+$/, "")
function linesAreEqual(a: string, b: string) {
  return trimRight(a) === trimRight(b)
}

/**
 * How does noNewLineAtEndOfFile work?
 *
 * if you remove the newline from a file that had one without editing other bits:
 *
 *    it creates an insertion/removal pair where the insertion has \ No new line at end of file
 *
 * if you edit a file that didn't have a new line and don't add one:
 *
 *    both insertion and deletion have \ No new line at end of file
 *
 * if you edit a file that didn't have a new line and add one:
 *
 *    deletion has \ No new line at end of file
 *    but not insertion
 *
 * if you edit a file that had a new line and leave it in:
 *
 *    neither insetion nor deletion have the annoation
 *
 */

function applyPatch(
  { hunks, path }: FilePatch,
  {
    dryRun,
    cwd,
    bestEffort,
    errors,
  }: { dryRun: boolean; cwd?: string; bestEffort: boolean; errors?: string[] },
): void {
  path = cwd ? resolve(cwd, path) : path
  // modifying the file in place
  const fileContents = fs.readFileSync(path).toString()
  const mode = fs.statSync(path).mode

  const fileLines: string[] = fileContents.split(/\n/)

  const result: Modification[][] = []

  for (const hunk of hunks) {
    let fuzzingOffset = 0
    while (true) {
      const modifications = evaluateHunk(hunk, fileLines, fuzzingOffset)
      if (modifications) {
        result.push(modifications)
        break
      }

      fuzzingOffset =
        fuzzingOffset < 0 ? fuzzingOffset * -1 : fuzzingOffset * -1 - 1

      if (Math.abs(fuzzingOffset) > 20) {
        const message = `Cannot apply hunk ${hunks.indexOf(
          hunk,
        )} for file ${relative(process.cwd(), path)}\n\`\`\`diff\n${
          hunk.source
        }\n\`\`\`\n`

        if (bestEffort) {
          errors?.push(message)
          break
        } else {
          throw new Error(message)
        }
      }
    }
  }

  if (dryRun) {
    return
  }

  let diffOffset = 0

  for (const modifications of result) {
    for (const modification of modifications) {
      switch (modification.type) {
        case "splice":
          fileLines.splice(
            modification.index + diffOffset,
            modification.numToDelete,
            ...modification.linesToInsert,
          )
          diffOffset +=
            modification.linesToInsert.length - modification.numToDelete
          break
        case "pop":
          fileLines.pop()
          break
        case "push":
          fileLines.push(modification.line)
          break
        default:
          assertNever(modification)
      }
    }
  }

  try {
    fs.writeFileSync(path, fileLines.join("\n"), { mode })
  } catch (e) {
    if (bestEffort) {
      errors?.push(`Failed to write file ${path}`)
    } else {
      throw e
    }
  }
}

interface Push {
  type: "push"
  line: string
}
interface Pop {
  type: "pop"
}
interface Splice {
  type: "splice"
  index: number
  numToDelete: number
  linesToInsert: string[]
}

type Modification = Push | Pop | Splice

function evaluateHunk(
  hunk: Hunk,
  fileLines: string[],
  fuzzingOffset: number,
): Modification[] | null {
  const result: Modification[] = []
  let contextIndex = hunk.header.original.start - 1 + fuzzingOffset
  // do bounds checks for index
  if (contextIndex < 0) {
    return null
  }
  if (fileLines.length - contextIndex < hunk.header.original.length) {
    return null
  }

  for (const part of hunk.parts) {
    switch (part.type) {
      case "deletion":
      case "context":
        for (const line of part.lines) {
          const originalLine = fileLines[contextIndex]
          if (!linesAreEqual(originalLine, line)) {
            return null
          }
          contextIndex++
        }

        if (part.type === "deletion") {
          result.push({
            type: "splice",
            index: contextIndex - part.lines.length,
            numToDelete: part.lines.length,
            linesToInsert: [],
          })

          if (part.noNewlineAtEndOfFile) {
            result.push({
              type: "push",
              line: "",
            })
          }
        }
        break
      case "insertion":
        result.push({
          type: "splice",
          index: contextIndex,
          numToDelete: 0,
          linesToInsert: part.lines,
        })
        if (part.noNewlineAtEndOfFile) {
          result.push({ type: "pop" })
        }
        break
      default:
        assertNever(part.type)
    }
  }

  return result
}
