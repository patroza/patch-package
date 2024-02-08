import chalk from "chalk"
import { join, resolve } from "path"
import { applyPatch } from "./applyPatches.js"
import { hashFile } from "./hash.js"
import { PatchedPackageDetails } from "./PackageDetails.js"
import { getGroupedPatches } from "./patchFs.js"
import {
  getPatchApplicationState,
  savePatchApplicationState,
  verifyAppliedPatches,
} from "./stateFile.js"

export function rebase({
  appPath,
  patchDir,
  packagePathSpecifier,
  targetPatch,
}: {
  appPath: string
  patchDir: string
  packagePathSpecifier: string
  targetPatch: string
}): void {
  const patchesDirectory = join(appPath, patchDir)
  const groupedPatches = getGroupedPatches(patchesDirectory)

  if (groupedPatches.numPatchFiles === 0) {
    console.log(chalk.blueBright("No patch files found"))
    process.exit(1)
  }

  const packagePatches =
    groupedPatches.pathSpecifierToPatchFiles[packagePathSpecifier]
  if (!packagePatches) {
    console.log(
      chalk.blueBright("No patch files found for package"),
      packagePathSpecifier,
    )
    process.exit(1)
  }

  const state = getPatchApplicationState(packagePatches[0])

  if (!state) {
    console.log(
      chalk.blueBright("No patch state found"),
      "Did you forget to run",
      chalk.bold("patch-package"),
      "(without arguments) first?",
    )
    process.exit(1)
  }
  if (state.isRebasing) {
    console.log(
      chalk.blueBright("Already rebasing"),
      "Make changes to the files in",
      chalk.bold(packagePatches[0].path),
      "and then run `patch-package",
      packagePathSpecifier,
      "--continue` to",
      packagePatches.length === state.patches.length
        ? "append a patch file"
        : `update the ${
            packagePatches[packagePatches.length - 1].patchFilename
          } file`,
    )
    console.log(
      `💡 To remove a broken patch file, delete it and reinstall node_modules`,
    )
    process.exit(1)
  }
  if (state.patches.length !== packagePatches.length) {
    console.log(
      chalk.blueBright("Some patches have not been applied."),
      "Reinstall node_modules and try again.",
    )
  }
  // check hashes
  verifyAppliedPatches({ appPath, patchDir, state })

  if (targetPatch === "0") {
    // unapply all
    unApplyPatches({
      patches: packagePatches,
      appPath,
      patchDir,
    })
    savePatchApplicationState({
      packageDetails: packagePatches[0],
      isRebasing: true,
      patches: [],
    })
    console.log(`
Make any changes you need inside ${chalk.bold(packagePatches[0].path)}

When you are done, run

  ${chalk.bold(
    `patch-package ${packagePathSpecifier} --append 'MyChangeDescription'`,
  )}
  
to insert a new patch file.
`)
    return
  }

  // find target patch
  const target = packagePatches.find((p) => {
    if (p.patchFilename === targetPatch) {
      return true
    }
    if (
      resolve(process.cwd(), targetPatch) ===
      join(patchesDirectory, p.patchFilename)
    ) {
      return true
    }

    if (targetPatch === p.sequenceName) {
      return true
    }
    const n = Number(targetPatch.replace(/^0+/g, ""))
    if (!isNaN(n) && n === p.sequenceNumber) {
      return true
    }
    return false
  })

  if (!target) {
    console.log(
      chalk.red("Could not find target patch file"),
      chalk.bold(targetPatch),
    )
    console.log()
    console.log("The list of available patch files is:")
    packagePatches.forEach((p) => {
      console.log(`  - ${p.patchFilename}`)
    })

    process.exit(1)
  }
  const currentHash = hashFile(join(patchesDirectory, target.patchFilename))

  const prevApplication = state.patches.find(
    (p) => p.patchContentHash === currentHash,
  )
  if (!prevApplication) {
    console.log(
      chalk.red("Could not find previous application of patch file"),
      chalk.bold(target.patchFilename),
    )
    console.log()
    console.log("You should reinstall node_modules and try again.")
    process.exit(1)
  }

  // ok, we are good to start undoing all the patches that were applied up to but not including the target patch
  const targetIdx = state.patches.indexOf(prevApplication)

  unApplyPatches({
    patches: packagePatches.slice(targetIdx + 1),
    appPath,
    patchDir,
  })
  savePatchApplicationState({
    packageDetails: packagePatches[0],
    isRebasing: true,
    patches: packagePatches.slice(0, targetIdx + 1).map((p) => ({
      patchFilename: p.patchFilename,
      patchContentHash: hashFile(join(patchesDirectory, p.patchFilename)),
      didApply: true,
    })),
  })

  console.log(`
Make any changes you need inside ${chalk.bold(packagePatches[0].path)}

When you are done, do one of the following:

  To update ${chalk.bold(packagePatches[targetIdx].patchFilename)} run

    ${chalk.bold(`patch-package ${packagePathSpecifier}`)}
    
  To create a new patch file after ${chalk.bold(
    packagePatches[targetIdx].patchFilename,
  )} run
  
    ${chalk.bold(
      `patch-package ${packagePathSpecifier} --append 'MyChangeDescription'`,
    )}

  `)
}

function unApplyPatches({
  patches,
  appPath,
  patchDir,
}: {
  patches: PatchedPackageDetails[]
  appPath: string
  patchDir: string
}) {
  for (const patch of patches.slice().reverse()) {
    if (
      !applyPatch({
        patchFilePath: join(appPath, patchDir, patch.patchFilename) as string,
        reverse: true,
        patchDetails: patch,
        patchDir,
        cwd: process.cwd(),
        bestEffort: false,
      })
    ) {
      console.log(
        chalk.red("Failed to un-apply patch file"),
        chalk.bold(patch.patchFilename),
        "Try completely reinstalling node_modules.",
      )
      process.exit(1)
    }
    console.log(chalk.cyan.bold("Un-applied"), patch.patchFilename)
  }
}
