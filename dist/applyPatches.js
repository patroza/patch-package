import chalk from "chalk";
import { writeFileSync } from "fs";
import fs from "fs-extra";
import { posix } from "path";
import semver from "semver";
import { hashFile } from "./hash.js";
import { logPatchSequenceError } from "./makePatch.js";
import { packageIsDevDependency } from "./packageIsDevDependency.js";
import { executeEffects } from "./patch/apply.js";
import { readPatch } from "./patch/read.js";
import { reversePatch } from "./patch/reverse.js";
import { getGroupedPatches } from "./patchFs.js";
import { join, relative } from "./path.js";
import { clearPatchApplicationState, getPatchApplicationState, savePatchApplicationState, } from "./stateFile.js";
class PatchApplicationError extends Error {
    constructor(msg) {
        super(msg);
    }
}
function getInstalledPackageVersion({ appPath, path, pathSpecifier, isDevOnly, patchFilename, }) {
    const packageDir = join(appPath, path);
    if (!fs.existsSync(packageDir)) {
        if (process.env.NODE_ENV === "production" && isDevOnly) {
            return null;
        }
        let err = `${chalk.red("Error:")} Patch file found for package ${posix.basename(pathSpecifier)}` + ` which is not present at ${relative(".", packageDir)}`;
        if (!isDevOnly && process.env.NODE_ENV === "production") {
            err += `

  If this package is a dev dependency, rename the patch file to
  
    ${chalk.bold(patchFilename.replace(".patch", ".dev.patch"))}
`;
        }
        throw new PatchApplicationError(err);
    }
    const { version } = require(join(packageDir, "package.json"));
    // normalize version for `npm ci`
    const result = semver.valid(version);
    if (result === null) {
        throw new PatchApplicationError(`${chalk.red("Error:")} Version string '${version}' cannot be parsed from ${join(packageDir, "package.json")}`);
    }
    return result;
}
function logPatchApplication(patchDetails) {
    const sequenceString = patchDetails.sequenceNumber != null
        ? ` (${patchDetails.sequenceNumber}${patchDetails.sequenceName ? " " + patchDetails.sequenceName : ""})`
        : "";
    console.log(`${chalk.bold(patchDetails.pathSpecifier)}@${patchDetails.version}${sequenceString} ${chalk.green("✔")}`);
}
export function applyPatchesForApp({ appPath, reverse, patchDir, shouldExitWithError, shouldExitWithWarning, bestEffort, }) {
    const patchesDirectory = join(appPath, patchDir);
    const groupedPatches = getGroupedPatches(patchesDirectory);
    if (groupedPatches.numPatchFiles === 0) {
        console.log(chalk.blueBright("No patch files found"));
        return;
    }
    const errors = [];
    const warnings = [...groupedPatches.warnings];
    for (const patches of Object.values(groupedPatches.pathSpecifierToPatchFiles)) {
        applyPatchesForPackage({
            patches,
            appPath,
            patchDir,
            reverse,
            warnings,
            errors,
            bestEffort,
        });
    }
    for (const warning of warnings) {
        console.log(warning);
    }
    for (const error of errors) {
        console.log(error);
    }
    const problemsSummary = [];
    if (warnings.length) {
        problemsSummary.push(chalk.yellow(`${warnings.length} warning(s)`));
    }
    if (errors.length) {
        problemsSummary.push(chalk.red(`${errors.length} error(s)`));
    }
    if (problemsSummary.length) {
        console.log("---");
        console.log("patch-package finished with", problemsSummary.join(", ") + ".");
    }
    if (errors.length && shouldExitWithError) {
        process.exit(1);
    }
    if (warnings.length && shouldExitWithWarning) {
        process.exit(1);
    }
    process.exit(0);
}
export function applyPatchesForPackage({ patches, appPath, patchDir, reverse, warnings, errors, bestEffort, }) {
    const pathSpecifier = patches[0].pathSpecifier;
    const state = patches.length > 1 ? getPatchApplicationState(patches[0]) : null;
    const unappliedPatches = patches.slice(0);
    const appliedPatches = [];
    // if there are multiple patches to apply, we can't rely on the reverse-patch-dry-run behavior to make this operation
    // idempotent, so instead we need to check the state file to see whether we have already applied any of the patches
    // todo: once this is battle tested we might want to use the same approach for single patches as well, but it's not biggie since the dry run thing is fast
    if (unappliedPatches && state) {
        for (let i = 0; i < state.patches.length; i++) {
            const patchThatWasApplied = state.patches[i];
            if (!patchThatWasApplied.didApply) {
                break;
            }
            const patchToApply = unappliedPatches[0];
            const currentPatchHash = hashFile(join(appPath, patchDir, patchToApply.patchFilename));
            if (patchThatWasApplied.patchContentHash === currentPatchHash) {
                // this patch was applied we can skip it
                appliedPatches.push(unappliedPatches.shift());
            }
            else {
                console.log(chalk.red("Error:"), `The patches for ${chalk.bold(pathSpecifier)} have changed.`, `You should reinstall your node_modules folder to make sure the package is up to date`);
                process.exit(1);
            }
        }
    }
    if (reverse && state) {
        // if we are reversing the patches we need to make the unappliedPatches array
        // be the reversed version of the appliedPatches array.
        // The applied patches array should then be empty because it is used differently
        // when outputting the state file.
        unappliedPatches.length = 0;
        unappliedPatches.push(...appliedPatches);
        unappliedPatches.reverse();
        appliedPatches.length = 0;
    }
    if (appliedPatches.length) {
        // some patches have already been applied
        appliedPatches.forEach(logPatchApplication);
    }
    if (!unappliedPatches.length) {
        return;
    }
    let failedPatch = null;
    packageLoop: for (const patchDetails of unappliedPatches) {
        try {
            const { name, version, path, isDevOnly, patchFilename } = patchDetails;
            const installedPackageVersion = getInstalledPackageVersion({
                appPath,
                path,
                pathSpecifier,
                isDevOnly: isDevOnly ||
                    // check for direct-dependents in prod
                    (process.env.NODE_ENV === "production" &&
                        packageIsDevDependency({
                            appPath,
                            patchDetails,
                        })),
                patchFilename,
            });
            if (!installedPackageVersion) {
                // it's ok we're in production mode and this is a dev only package
                console.log(`Skipping dev-only ${chalk.bold(pathSpecifier)}@${version} ${chalk.blue("✔")}`);
                continue;
            }
            if (applyPatch({
                patchFilePath: join(appPath, patchDir, patchFilename),
                reverse,
                patchDetails,
                patchDir,
                cwd: process.cwd(),
                bestEffort,
            })) {
                appliedPatches.push(patchDetails);
                // yay patch was applied successfully
                // print warning if version mismatch
                if (installedPackageVersion !== version) {
                    warnings.push(createVersionMismatchWarning({
                        packageName: name,
                        actualVersion: installedPackageVersion,
                        originalVersion: version,
                        pathSpecifier,
                        path,
                    }));
                }
                logPatchApplication(patchDetails);
            }
            else if (patches.length > 1) {
                logPatchSequenceError({ patchDetails });
                // in case the package has multiple patches, we need to break out of this inner loop
                // because we don't want to apply more patches on top of the broken state
                failedPatch = patchDetails;
                break packageLoop;
            }
            else if (installedPackageVersion === version) {
                // completely failed to apply patch
                // TODO: propagate useful error messages from patch application
                errors.push(createBrokenPatchFileError({
                    packageName: name,
                    patchFilename,
                    pathSpecifier,
                    path,
                }));
                break packageLoop;
            }
            else {
                errors.push(createPatchApplicationFailureError({
                    packageName: name,
                    actualVersion: installedPackageVersion,
                    originalVersion: version,
                    patchFilename,
                    path,
                    pathSpecifier,
                }));
                // in case the package has multiple patches, we need to break out of this inner loop
                // because we don't want to apply more patches on top of the broken state
                break packageLoop;
            }
        }
        catch (error) {
            if (error instanceof PatchApplicationError) {
                errors.push(error.message);
            }
            else {
                errors.push(createUnexpectedError({
                    filename: patchDetails.patchFilename,
                    error: error,
                }));
            }
            // in case the package has multiple patches, we need to break out of this inner loop
            // because we don't want to apply more patches on top of the broken state
            break packageLoop;
        }
    }
    if (patches.length > 1) {
        if (reverse) {
            if (!state) {
                throw new Error("unexpected state: no state file found while reversing");
            }
            // if we removed all the patches that were previously applied we can delete the state file
            if (appliedPatches.length === patches.length) {
                clearPatchApplicationState(patches[0]);
            }
            else {
                // We failed while reversing patches and some are still in the applied state.
                // We need to update the state file to reflect that.
                // appliedPatches is currently the patches that were successfully reversed, in the order they were reversed
                // So we need to find the index of the last reversed patch in the original patches array
                // and then remove all the patches after that. Sorry for the confusing code.
                const lastReversedPatchIndex = patches.indexOf(appliedPatches[appliedPatches.length - 1]);
                if (lastReversedPatchIndex === -1) {
                    throw new Error("unexpected state: failed to find last reversed patch in original patches array");
                }
                savePatchApplicationState({
                    packageDetails: patches[0],
                    patches: patches.slice(0, lastReversedPatchIndex).map((patch) => ({
                        didApply: true,
                        patchContentHash: hashFile(join(appPath, patchDir, patch.patchFilename)),
                        patchFilename: patch.patchFilename,
                    })),
                    isRebasing: false,
                });
            }
        }
        else {
            const nextState = appliedPatches.map((patch) => ({
                didApply: true,
                patchContentHash: hashFile(join(appPath, patchDir, patch.patchFilename)),
                patchFilename: patch.patchFilename,
            }));
            if (failedPatch) {
                nextState.push({
                    didApply: false,
                    patchContentHash: hashFile(join(appPath, patchDir, failedPatch.patchFilename)),
                    patchFilename: failedPatch.patchFilename,
                });
            }
            savePatchApplicationState({
                packageDetails: patches[0],
                patches: nextState,
                isRebasing: !!failedPatch,
            });
        }
        if (failedPatch) {
            process.exit(1);
        }
    }
}
export function applyPatch({ patchFilePath, reverse, patchDetails, patchDir, cwd, bestEffort, }) {
    const patch = readPatch({
        patchFilePath,
        patchDetails,
        patchDir,
    });
    const forward = reverse ? reversePatch(patch) : patch;
    try {
        if (!bestEffort) {
            executeEffects(forward, { dryRun: true, cwd, bestEffort: false });
        }
        const errors = bestEffort ? [] : undefined;
        executeEffects(forward, { dryRun: false, cwd, bestEffort, errors });
        if (errors === null || errors === void 0 ? void 0 : errors.length) {
            console.log("Saving errors to", chalk.cyan.bold("./patch-package-errors.log"));
            writeFileSync("patch-package-errors.log", errors.join("\n\n"));
            process.exit(0);
        }
    }
    catch (e) {
        try {
            const backward = reverse ? patch : reversePatch(patch);
            executeEffects(backward, {
                dryRun: true,
                cwd,
                bestEffort: false,
            });
        }
        catch (e) {
            return false;
        }
    }
    return true;
}
function createVersionMismatchWarning({ packageName, actualVersion, originalVersion, pathSpecifier, path, }) {
    return `
${chalk.yellow("Warning:")} patch-package detected a patch file version mismatch

  Don't worry! This is probably fine. The patch was still applied
  successfully. Here's the deets:

  Patch file created for

    ${packageName}@${chalk.bold(originalVersion)}

  applied to

    ${packageName}@${chalk.bold(actualVersion)}
  
  At path
  
    ${path}

  This warning is just to give you a heads-up. There is a small chance of
  breakage even though the patch was applied successfully. Make sure the package
  still behaves like you expect (you wrote tests, right?) and then run

    ${chalk.bold(`patch-package ${pathSpecifier}`)}

  to update the version in the patch file name and make this warning go away.
`;
}
function createBrokenPatchFileError({ packageName, patchFilename, path, pathSpecifier, }) {
    return `
${chalk.red.bold("**ERROR**")} ${chalk.red(`Failed to apply patch for package ${chalk.bold(packageName)} at path`)}
  
    ${path}

  This error was caused because patch-package cannot apply the following patch file:

    patches/${patchFilename}

  Try removing node_modules and trying again. If that doesn't work, maybe there was
  an accidental change made to the patch file? Try recreating it by manually
  editing the appropriate files and running:
  
    patch-package ${pathSpecifier}
  
  If that doesn't work, then it's a bug in patch-package, so please submit a bug
  report. Thanks!

    https://github.com/ds300/patch-package/issues
    
`;
}
function createPatchApplicationFailureError({ packageName, actualVersion, originalVersion, patchFilename, path, pathSpecifier, }) {
    return `
${chalk.red.bold("**ERROR**")} ${chalk.red(`Failed to apply patch for package ${chalk.bold(packageName)} at path`)}
  
    ${path}

  This error was caused because ${chalk.bold(packageName)} has changed since you
  made the patch file for it. This introduced conflicts with your patch,
  just like a merge conflict in Git when separate incompatible changes are
  made to the same piece of code.

  Maybe this means your patch file is no longer necessary, in which case
  hooray! Just delete it!

  Otherwise, you need to generate a new patch file.

  To generate a new one, just repeat the steps you made to generate the first
  one.

  i.e. manually make the appropriate file changes, then run 

    patch-package ${pathSpecifier}

  Info:
    Patch file: patches/${patchFilename}
    Patch was made for version: ${chalk.green.bold(originalVersion)}
    Installed version: ${chalk.red.bold(actualVersion)}
`;
}
function createUnexpectedError({ filename, error, }) {
    return `
${chalk.red.bold("**ERROR**")} ${chalk.red(`Failed to apply patch file ${chalk.bold(filename)}`)}
  
${error.stack}

  `;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBwbHlQYXRjaGVzLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL2FwcGx5UGF0Y2hlcy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEtBQUssTUFBTSxPQUFPLENBQUE7QUFDekIsT0FBTyxFQUFFLGFBQWEsRUFBRSxNQUFNLElBQUksQ0FBQTtBQUNsQyxPQUFPLEVBQUUsTUFBTSxVQUFVLENBQUE7QUFDekIsT0FBTyxFQUFFLEtBQUssRUFBRSxNQUFNLE1BQU0sQ0FBQTtBQUM1QixPQUFPLE1BQU0sTUFBTSxRQUFRLENBQUE7QUFDM0IsT0FBTyxFQUFFLFFBQVEsRUFBRSxNQUFNLFdBQVcsQ0FBQTtBQUNwQyxPQUFPLEVBQUUscUJBQXFCLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQTtBQUV0RCxPQUFPLEVBQUUsc0JBQXNCLEVBQUUsTUFBTSw2QkFBNkIsQ0FBQTtBQUNwRSxPQUFPLEVBQUUsY0FBYyxFQUFFLE1BQU0sa0JBQWtCLENBQUE7QUFDakQsT0FBTyxFQUFFLFNBQVMsRUFBRSxNQUFNLGlCQUFpQixDQUFBO0FBQzNDLE9BQU8sRUFBRSxZQUFZLEVBQUUsTUFBTSxvQkFBb0IsQ0FBQTtBQUNqRCxPQUFPLEVBQUUsaUJBQWlCLEVBQUUsTUFBTSxjQUFjLENBQUE7QUFDaEQsT0FBTyxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsTUFBTSxXQUFXLENBQUE7QUFDMUMsT0FBTyxFQUNMLDBCQUEwQixFQUMxQix3QkFBd0IsRUFFeEIseUJBQXlCLEdBQzFCLE1BQU0sZ0JBQWdCLENBQUE7QUFFdkIsTUFBTSxxQkFBc0IsU0FBUSxLQUFLO0lBQ3ZDLFlBQVksR0FBVztRQUNyQixLQUFLLENBQUMsR0FBRyxDQUFDLENBQUE7SUFDWixDQUFDO0NBQ0Y7QUFFRCxTQUFTLDBCQUEwQixDQUFDLEVBQ2xDLE9BQU8sRUFDUCxJQUFJLEVBQ0osYUFBYSxFQUNiLFNBQVMsRUFDVCxhQUFhLEdBT2Q7SUFDQyxNQUFNLFVBQVUsR0FBRyxJQUFJLENBQUMsT0FBTyxFQUFFLElBQUksQ0FBQyxDQUFBO0lBQ3RDLElBQUksQ0FBQyxFQUFFLENBQUMsVUFBVSxDQUFDLFVBQVUsQ0FBQyxFQUFFLENBQUM7UUFDL0IsSUFBSSxPQUFPLENBQUMsR0FBRyxDQUFDLFFBQVEsS0FBSyxZQUFZLElBQUksU0FBUyxFQUFFLENBQUM7WUFDdkQsT0FBTyxJQUFJLENBQUE7UUFDYixDQUFDO1FBRUQsSUFBSSxHQUFHLEdBQ0wsR0FBRyxLQUFLLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxpQ0FBaUMsS0FBSyxDQUFDLFFBQVEsQ0FDbkUsYUFBYSxDQUNkLEVBQUUsR0FBRyw0QkFBNEIsUUFBUSxDQUFDLEdBQUcsRUFBRSxVQUFVLENBQUMsRUFBRSxDQUFBO1FBRS9ELElBQUksQ0FBQyxTQUFTLElBQUksT0FBTyxDQUFDLEdBQUcsQ0FBQyxRQUFRLEtBQUssWUFBWSxFQUFFLENBQUM7WUFDeEQsR0FBRyxJQUFJOzs7O01BSVAsS0FBSyxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsT0FBTyxDQUFDLFFBQVEsRUFBRSxZQUFZLENBQUMsQ0FBQztDQUM5RCxDQUFBO1FBQ0csQ0FBQztRQUNELE1BQU0sSUFBSSxxQkFBcUIsQ0FBQyxHQUFHLENBQUMsQ0FBQTtJQUN0QyxDQUFDO0lBRUQsTUFBTSxFQUFFLE9BQU8sRUFBRSxHQUFHLE9BQU8sQ0FBQyxJQUFJLENBQUMsVUFBVSxFQUFFLGNBQWMsQ0FBQyxDQUFDLENBQUE7SUFDN0QsaUNBQWlDO0lBQ2pDLE1BQU0sTUFBTSxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUE7SUFDcEMsSUFBSSxNQUFNLEtBQUssSUFBSSxFQUFFLENBQUM7UUFDcEIsTUFBTSxJQUFJLHFCQUFxQixDQUM3QixHQUFHLEtBQUssQ0FBQyxHQUFHLENBQ1YsUUFBUSxDQUNULG9CQUFvQixPQUFPLDJCQUEyQixJQUFJLENBQ3pELFVBQVUsRUFDVixjQUFjLENBQ2YsRUFBRSxDQUNKLENBQUE7SUFDSCxDQUFDO0lBRUQsT0FBTyxNQUFnQixDQUFBO0FBQ3pCLENBQUM7QUFFRCxTQUFTLG1CQUFtQixDQUFDLFlBQW1DO0lBQzlELE1BQU0sY0FBYyxHQUNsQixZQUFZLENBQUMsY0FBYyxJQUFJLElBQUk7UUFDakMsQ0FBQyxDQUFDLEtBQUssWUFBWSxDQUFDLGNBQWMsR0FDOUIsWUFBWSxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMsR0FBRyxHQUFHLFlBQVksQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLEVBQ2hFLEdBQUc7UUFDTCxDQUFDLENBQUMsRUFBRSxDQUFBO0lBQ1IsT0FBTyxDQUFDLEdBQUcsQ0FDVCxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLGFBQWEsQ0FBQyxJQUN2QyxZQUFZLENBQUMsT0FDZixHQUFHLGNBQWMsSUFBSSxLQUFLLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQ3hDLENBQUE7QUFDSCxDQUFDO0FBRUQsTUFBTSxVQUFVLGtCQUFrQixDQUFDLEVBQ2pDLE9BQU8sRUFDUCxPQUFPLEVBQ1AsUUFBUSxFQUNSLG1CQUFtQixFQUNuQixxQkFBcUIsRUFDckIsVUFBVSxHQVFYO0lBQ0MsTUFBTSxnQkFBZ0IsR0FBRyxJQUFJLENBQUMsT0FBTyxFQUFFLFFBQVEsQ0FBQyxDQUFBO0lBQ2hELE1BQU0sY0FBYyxHQUFHLGlCQUFpQixDQUFDLGdCQUFnQixDQUFDLENBQUE7SUFFMUQsSUFBSSxjQUFjLENBQUMsYUFBYSxLQUFLLENBQUMsRUFBRSxDQUFDO1FBQ3ZDLE9BQU8sQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLFVBQVUsQ0FBQyxzQkFBc0IsQ0FBQyxDQUFDLENBQUE7UUFDckQsT0FBTTtJQUNSLENBQUM7SUFFRCxNQUFNLE1BQU0sR0FBYSxFQUFFLENBQUE7SUFDM0IsTUFBTSxRQUFRLEdBQWEsQ0FBQyxHQUFHLGNBQWMsQ0FBQyxRQUFRLENBQUMsQ0FBQTtJQUV2RCxLQUFLLE1BQU0sT0FBTyxJQUFJLE1BQU0sQ0FBQyxNQUFNLENBQ2pDLGNBQWMsQ0FBQyx5QkFBeUIsQ0FDekMsRUFBRSxDQUFDO1FBQ0Ysc0JBQXNCLENBQUM7WUFDckIsT0FBTztZQUNQLE9BQU87WUFDUCxRQUFRO1lBQ1IsT0FBTztZQUNQLFFBQVE7WUFDUixNQUFNO1lBQ04sVUFBVTtTQUNYLENBQUMsQ0FBQTtJQUNKLENBQUM7SUFFRCxLQUFLLE1BQU0sT0FBTyxJQUFJLFFBQVEsRUFBRSxDQUFDO1FBQy9CLE9BQU8sQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLENBQUE7SUFDdEIsQ0FBQztJQUNELEtBQUssTUFBTSxLQUFLLElBQUksTUFBTSxFQUFFLENBQUM7UUFDM0IsT0FBTyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQTtJQUNwQixDQUFDO0lBRUQsTUFBTSxlQUFlLEdBQUcsRUFBRSxDQUFBO0lBQzFCLElBQUksUUFBUSxDQUFDLE1BQU0sRUFBRSxDQUFDO1FBQ3BCLGVBQWUsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxHQUFHLFFBQVEsQ0FBQyxNQUFNLGFBQWEsQ0FBQyxDQUFDLENBQUE7SUFDckUsQ0FBQztJQUNELElBQUksTUFBTSxDQUFDLE1BQU0sRUFBRSxDQUFDO1FBQ2xCLGVBQWUsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxHQUFHLE1BQU0sQ0FBQyxNQUFNLFdBQVcsQ0FBQyxDQUFDLENBQUE7SUFDOUQsQ0FBQztJQUVELElBQUksZUFBZSxDQUFDLE1BQU0sRUFBRSxDQUFDO1FBQzNCLE9BQU8sQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLENBQUE7UUFDbEIsT0FBTyxDQUFDLEdBQUcsQ0FBQyw2QkFBNkIsRUFBRSxlQUFlLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxHQUFHLEdBQUcsQ0FBQyxDQUFBO0lBQzlFLENBQUM7SUFFRCxJQUFJLE1BQU0sQ0FBQyxNQUFNLElBQUksbUJBQW1CLEVBQUUsQ0FBQztRQUN6QyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFBO0lBQ2pCLENBQUM7SUFFRCxJQUFJLFFBQVEsQ0FBQyxNQUFNLElBQUkscUJBQXFCLEVBQUUsQ0FBQztRQUM3QyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFBO0lBQ2pCLENBQUM7SUFFRCxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFBO0FBQ2pCLENBQUM7QUFFRCxNQUFNLFVBQVUsc0JBQXNCLENBQUMsRUFDckMsT0FBTyxFQUNQLE9BQU8sRUFDUCxRQUFRLEVBQ1IsT0FBTyxFQUNQLFFBQVEsRUFDUixNQUFNLEVBQ04sVUFBVSxHQVNYO0lBQ0MsTUFBTSxhQUFhLEdBQUcsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLGFBQWEsQ0FBQTtJQUM5QyxNQUFNLEtBQUssR0FBRyxPQUFPLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsd0JBQXdCLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQTtJQUM5RSxNQUFNLGdCQUFnQixHQUFHLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUE7SUFDekMsTUFBTSxjQUFjLEdBQTRCLEVBQUUsQ0FBQTtJQUNsRCxxSEFBcUg7SUFDckgsbUhBQW1IO0lBQ25ILDBKQUEwSjtJQUMxSixJQUFJLGdCQUFnQixJQUFJLEtBQUssRUFBRSxDQUFDO1FBQzlCLEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxLQUFLLENBQUMsT0FBTyxDQUFDLE1BQU0sRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFDO1lBQzlDLE1BQU0sbUJBQW1CLEdBQUcsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FBQTtZQUM1QyxJQUFJLENBQUMsbUJBQW1CLENBQUMsUUFBUSxFQUFFLENBQUM7Z0JBQ2xDLE1BQUs7WUFDUCxDQUFDO1lBQ0QsTUFBTSxZQUFZLEdBQUcsZ0JBQWdCLENBQUMsQ0FBQyxDQUFDLENBQUE7WUFDeEMsTUFBTSxnQkFBZ0IsR0FBRyxRQUFRLENBQy9CLElBQUksQ0FBQyxPQUFPLEVBQUUsUUFBUSxFQUFFLFlBQVksQ0FBQyxhQUFhLENBQUMsQ0FDcEQsQ0FBQTtZQUNELElBQUksbUJBQW1CLENBQUMsZ0JBQWdCLEtBQUssZ0JBQWdCLEVBQUUsQ0FBQztnQkFDOUQsd0NBQXdDO2dCQUN4QyxjQUFjLENBQUMsSUFBSSxDQUFDLGdCQUFnQixDQUFDLEtBQUssRUFBRyxDQUFDLENBQUE7WUFDaEQsQ0FBQztpQkFBTSxDQUFDO2dCQUNOLE9BQU8sQ0FBQyxHQUFHLENBQ1QsS0FBSyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsRUFDbkIsbUJBQW1CLEtBQUssQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLGdCQUFnQixFQUM1RCxzRkFBc0YsQ0FDdkYsQ0FBQTtnQkFDRCxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFBO1lBQ2pCLENBQUM7UUFDSCxDQUFDO0lBQ0gsQ0FBQztJQUVELElBQUksT0FBTyxJQUFJLEtBQUssRUFBRSxDQUFDO1FBQ3JCLDZFQUE2RTtRQUM3RSx1REFBdUQ7UUFDdkQsZ0ZBQWdGO1FBQ2hGLGtDQUFrQztRQUNsQyxnQkFBZ0IsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFBO1FBQzNCLGdCQUFnQixDQUFDLElBQUksQ0FBQyxHQUFHLGNBQWMsQ0FBQyxDQUFBO1FBQ3hDLGdCQUFnQixDQUFDLE9BQU8sRUFBRSxDQUFBO1FBQzFCLGNBQWMsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFBO0lBQzNCLENBQUM7SUFDRCxJQUFJLGNBQWMsQ0FBQyxNQUFNLEVBQUUsQ0FBQztRQUMxQix5Q0FBeUM7UUFDekMsY0FBYyxDQUFDLE9BQU8sQ0FBQyxtQkFBbUIsQ0FBQyxDQUFBO0lBQzdDLENBQUM7SUFDRCxJQUFJLENBQUMsZ0JBQWdCLENBQUMsTUFBTSxFQUFFLENBQUM7UUFDN0IsT0FBTTtJQUNSLENBQUM7SUFDRCxJQUFJLFdBQVcsR0FBaUMsSUFBSSxDQUFBO0lBQ3BELFdBQVcsRUFBRSxLQUFLLE1BQU0sWUFBWSxJQUFJLGdCQUFnQixFQUFFLENBQUM7UUFDekQsSUFBSSxDQUFDO1lBQ0gsTUFBTSxFQUFFLElBQUksRUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFLFNBQVMsRUFBRSxhQUFhLEVBQUUsR0FBRyxZQUFZLENBQUE7WUFFdEUsTUFBTSx1QkFBdUIsR0FBRywwQkFBMEIsQ0FBQztnQkFDekQsT0FBTztnQkFDUCxJQUFJO2dCQUNKLGFBQWE7Z0JBQ2IsU0FBUyxFQUNQLFNBQVM7b0JBQ1Qsc0NBQXNDO29CQUN0QyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsUUFBUSxLQUFLLFlBQVk7d0JBQ3BDLHNCQUFzQixDQUFDOzRCQUNyQixPQUFPOzRCQUNQLFlBQVk7eUJBQ2IsQ0FBQyxDQUFDO2dCQUNQLGFBQWE7YUFDZCxDQUFDLENBQUE7WUFDRixJQUFJLENBQUMsdUJBQXVCLEVBQUUsQ0FBQztnQkFDN0Isa0VBQWtFO2dCQUNsRSxPQUFPLENBQUMsR0FBRyxDQUNULHFCQUFxQixLQUFLLENBQUMsSUFBSSxDQUM3QixhQUFhLENBQ2QsSUFBSSxPQUFPLElBQUksS0FBSyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUNsQyxDQUFBO2dCQUNELFNBQVE7WUFDVixDQUFDO1lBRUQsSUFDRSxVQUFVLENBQUM7Z0JBQ1QsYUFBYSxFQUFFLElBQUksQ0FBQyxPQUFPLEVBQUUsUUFBUSxFQUFFLGFBQWEsQ0FBVztnQkFDL0QsT0FBTztnQkFDUCxZQUFZO2dCQUNaLFFBQVE7Z0JBQ1IsR0FBRyxFQUFFLE9BQU8sQ0FBQyxHQUFHLEVBQUU7Z0JBQ2xCLFVBQVU7YUFDWCxDQUFDLEVBQ0YsQ0FBQztnQkFDRCxjQUFjLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxDQUFBO2dCQUNqQyxxQ0FBcUM7Z0JBQ3JDLG9DQUFvQztnQkFDcEMsSUFBSSx1QkFBdUIsS0FBSyxPQUFPLEVBQUUsQ0FBQztvQkFDeEMsUUFBUSxDQUFDLElBQUksQ0FDWCw0QkFBNEIsQ0FBQzt3QkFDM0IsV0FBVyxFQUFFLElBQUk7d0JBQ2pCLGFBQWEsRUFBRSx1QkFBdUI7d0JBQ3RDLGVBQWUsRUFBRSxPQUFPO3dCQUN4QixhQUFhO3dCQUNiLElBQUk7cUJBQ0wsQ0FBQyxDQUNILENBQUE7Z0JBQ0gsQ0FBQztnQkFDRCxtQkFBbUIsQ0FBQyxZQUFZLENBQUMsQ0FBQTtZQUNuQyxDQUFDO2lCQUFNLElBQUksT0FBTyxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUUsQ0FBQztnQkFDOUIscUJBQXFCLENBQUMsRUFBRSxZQUFZLEVBQUUsQ0FBQyxDQUFBO2dCQUN2QyxvRkFBb0Y7Z0JBQ3BGLHlFQUF5RTtnQkFDekUsV0FBVyxHQUFHLFlBQVksQ0FBQTtnQkFDMUIsTUFBTSxXQUFXLENBQUE7WUFDbkIsQ0FBQztpQkFBTSxJQUFJLHVCQUF1QixLQUFLLE9BQU8sRUFBRSxDQUFDO2dCQUMvQyxtQ0FBbUM7Z0JBQ25DLCtEQUErRDtnQkFDL0QsTUFBTSxDQUFDLElBQUksQ0FDVCwwQkFBMEIsQ0FBQztvQkFDekIsV0FBVyxFQUFFLElBQUk7b0JBQ2pCLGFBQWE7b0JBQ2IsYUFBYTtvQkFDYixJQUFJO2lCQUNMLENBQUMsQ0FDSCxDQUFBO2dCQUNELE1BQU0sV0FBVyxDQUFBO1lBQ25CLENBQUM7aUJBQU0sQ0FBQztnQkFDTixNQUFNLENBQUMsSUFBSSxDQUNULGtDQUFrQyxDQUFDO29CQUNqQyxXQUFXLEVBQUUsSUFBSTtvQkFDakIsYUFBYSxFQUFFLHVCQUF1QjtvQkFDdEMsZUFBZSxFQUFFLE9BQU87b0JBQ3hCLGFBQWE7b0JBQ2IsSUFBSTtvQkFDSixhQUFhO2lCQUNkLENBQUMsQ0FDSCxDQUFBO2dCQUNELG9GQUFvRjtnQkFDcEYseUVBQXlFO2dCQUN6RSxNQUFNLFdBQVcsQ0FBQTtZQUNuQixDQUFDO1FBQ0gsQ0FBQztRQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7WUFDZixJQUFJLEtBQUssWUFBWSxxQkFBcUIsRUFBRSxDQUFDO2dCQUMzQyxNQUFNLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQTtZQUM1QixDQUFDO2lCQUFNLENBQUM7Z0JBQ04sTUFBTSxDQUFDLElBQUksQ0FDVCxxQkFBcUIsQ0FBQztvQkFDcEIsUUFBUSxFQUFFLFlBQVksQ0FBQyxhQUFhO29CQUNwQyxLQUFLLEVBQUUsS0FBYztpQkFDdEIsQ0FBQyxDQUNILENBQUE7WUFDSCxDQUFDO1lBQ0Qsb0ZBQW9GO1lBQ3BGLHlFQUF5RTtZQUN6RSxNQUFNLFdBQVcsQ0FBQTtRQUNuQixDQUFDO0lBQ0gsQ0FBQztJQUVELElBQUksT0FBTyxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUUsQ0FBQztRQUN2QixJQUFJLE9BQU8sRUFBRSxDQUFDO1lBQ1osSUFBSSxDQUFDLEtBQUssRUFBRSxDQUFDO2dCQUNYLE1BQU0sSUFBSSxLQUFLLENBQUMsdURBQXVELENBQUMsQ0FBQTtZQUMxRSxDQUFDO1lBQ0QsMEZBQTBGO1lBQzFGLElBQUksY0FBYyxDQUFDLE1BQU0sS0FBSyxPQUFPLENBQUMsTUFBTSxFQUFFLENBQUM7Z0JBQzdDLDBCQUEwQixDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFBO1lBQ3hDLENBQUM7aUJBQU0sQ0FBQztnQkFDTiw2RUFBNkU7Z0JBQzdFLG9EQUFvRDtnQkFDcEQsMkdBQTJHO2dCQUMzRyx3RkFBd0Y7Z0JBQ3hGLDRFQUE0RTtnQkFDNUUsTUFBTSxzQkFBc0IsR0FBRyxPQUFPLENBQUMsT0FBTyxDQUM1QyxjQUFjLENBQUMsY0FBYyxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FDMUMsQ0FBQTtnQkFDRCxJQUFJLHNCQUFzQixLQUFLLENBQUMsQ0FBQyxFQUFFLENBQUM7b0JBQ2xDLE1BQU0sSUFBSSxLQUFLLENBQ2IsZ0ZBQWdGLENBQ2pGLENBQUE7Z0JBQ0gsQ0FBQztnQkFFRCx5QkFBeUIsQ0FBQztvQkFDeEIsY0FBYyxFQUFFLE9BQU8sQ0FBQyxDQUFDLENBQUM7b0JBQzFCLE9BQU8sRUFBRSxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxzQkFBc0IsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQzt3QkFDaEUsUUFBUSxFQUFFLElBQUk7d0JBQ2QsZ0JBQWdCLEVBQUUsUUFBUSxDQUN4QixJQUFJLENBQUMsT0FBTyxFQUFFLFFBQVEsRUFBRSxLQUFLLENBQUMsYUFBYSxDQUFDLENBQzdDO3dCQUNELGFBQWEsRUFBRSxLQUFLLENBQUMsYUFBYTtxQkFDbkMsQ0FBQyxDQUFDO29CQUNILFVBQVUsRUFBRSxLQUFLO2lCQUNsQixDQUFDLENBQUE7WUFDSixDQUFDO1FBQ0gsQ0FBQzthQUFNLENBQUM7WUFDTixNQUFNLFNBQVMsR0FBRyxjQUFjLENBQUMsR0FBRyxDQUNsQyxDQUFDLEtBQUssRUFBYyxFQUFFLENBQUMsQ0FBQztnQkFDdEIsUUFBUSxFQUFFLElBQUk7Z0JBQ2QsZ0JBQWdCLEVBQUUsUUFBUSxDQUN4QixJQUFJLENBQUMsT0FBTyxFQUFFLFFBQVEsRUFBRSxLQUFLLENBQUMsYUFBYSxDQUFDLENBQzdDO2dCQUNELGFBQWEsRUFBRSxLQUFLLENBQUMsYUFBYTthQUNuQyxDQUFDLENBQ0gsQ0FBQTtZQUVELElBQUksV0FBVyxFQUFFLENBQUM7Z0JBQ2hCLFNBQVMsQ0FBQyxJQUFJLENBQUM7b0JBQ2IsUUFBUSxFQUFFLEtBQUs7b0JBQ2YsZ0JBQWdCLEVBQUUsUUFBUSxDQUN4QixJQUFJLENBQUMsT0FBTyxFQUFFLFFBQVEsRUFBRSxXQUFXLENBQUMsYUFBYSxDQUFDLENBQ25EO29CQUNELGFBQWEsRUFBRSxXQUFXLENBQUMsYUFBYTtpQkFDekMsQ0FBQyxDQUFBO1lBQ0osQ0FBQztZQUNELHlCQUF5QixDQUFDO2dCQUN4QixjQUFjLEVBQUUsT0FBTyxDQUFDLENBQUMsQ0FBQztnQkFDMUIsT0FBTyxFQUFFLFNBQVM7Z0JBQ2xCLFVBQVUsRUFBRSxDQUFDLENBQUMsV0FBVzthQUMxQixDQUFDLENBQUE7UUFDSixDQUFDO1FBQ0QsSUFBSSxXQUFXLEVBQUUsQ0FBQztZQUNoQixPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFBO1FBQ2pCLENBQUM7SUFDSCxDQUFDO0FBQ0gsQ0FBQztBQUVELE1BQU0sVUFBVSxVQUFVLENBQUMsRUFDekIsYUFBYSxFQUNiLE9BQU8sRUFDUCxZQUFZLEVBQ1osUUFBUSxFQUNSLEdBQUcsRUFDSCxVQUFVLEdBUVg7SUFDQyxNQUFNLEtBQUssR0FBRyxTQUFTLENBQUM7UUFDdEIsYUFBYTtRQUNiLFlBQVk7UUFDWixRQUFRO0tBQ1QsQ0FBQyxDQUFBO0lBRUYsTUFBTSxPQUFPLEdBQUcsT0FBTyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQTtJQUNyRCxJQUFJLENBQUM7UUFDSCxJQUFJLENBQUMsVUFBVSxFQUFFLENBQUM7WUFDaEIsY0FBYyxDQUFDLE9BQU8sRUFBRSxFQUFFLE1BQU0sRUFBRSxJQUFJLEVBQUUsR0FBRyxFQUFFLFVBQVUsRUFBRSxLQUFLLEVBQUUsQ0FBQyxDQUFBO1FBQ25FLENBQUM7UUFDRCxNQUFNLE1BQU0sR0FBeUIsVUFBVSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQTtRQUNoRSxjQUFjLENBQUMsT0FBTyxFQUFFLEVBQUUsTUFBTSxFQUFFLEtBQUssRUFBRSxHQUFHLEVBQUUsVUFBVSxFQUFFLE1BQU0sRUFBRSxDQUFDLENBQUE7UUFDbkUsSUFBSSxNQUFNLGFBQU4sTUFBTSx1QkFBTixNQUFNLENBQUUsTUFBTSxFQUFFLENBQUM7WUFDbkIsT0FBTyxDQUFDLEdBQUcsQ0FDVCxrQkFBa0IsRUFDbEIsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsNEJBQTRCLENBQUMsQ0FDOUMsQ0FBQTtZQUNELGFBQWEsQ0FBQywwQkFBMEIsRUFBRSxNQUFNLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUE7WUFDOUQsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQTtRQUNqQixDQUFDO0lBQ0gsQ0FBQztJQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7UUFDWCxJQUFJLENBQUM7WUFDSCxNQUFNLFFBQVEsR0FBRyxPQUFPLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLEtBQUssQ0FBQyxDQUFBO1lBQ3RELGNBQWMsQ0FBQyxRQUFRLEVBQUU7Z0JBQ3ZCLE1BQU0sRUFBRSxJQUFJO2dCQUNaLEdBQUc7Z0JBQ0gsVUFBVSxFQUFFLEtBQUs7YUFDbEIsQ0FBQyxDQUFBO1FBQ0osQ0FBQztRQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7WUFDWCxPQUFPLEtBQUssQ0FBQTtRQUNkLENBQUM7SUFDSCxDQUFDO0lBRUQsT0FBTyxJQUFJLENBQUE7QUFDYixDQUFDO0FBRUQsU0FBUyw0QkFBNEIsQ0FBQyxFQUNwQyxXQUFXLEVBQ1gsYUFBYSxFQUNiLGVBQWUsRUFDZixhQUFhLEVBQ2IsSUFBSSxHQU9MO0lBQ0MsT0FBTztFQUNQLEtBQUssQ0FBQyxNQUFNLENBQUMsVUFBVSxDQUFDOzs7Ozs7O01BT3BCLFdBQVcsSUFBSSxLQUFLLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQzs7OztNQUkxQyxXQUFXLElBQUksS0FBSyxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUM7Ozs7TUFJeEMsSUFBSTs7Ozs7O01BTUosS0FBSyxDQUFDLElBQUksQ0FBQyxpQkFBaUIsYUFBYSxFQUFFLENBQUM7OztDQUdqRCxDQUFBO0FBQ0QsQ0FBQztBQUVELFNBQVMsMEJBQTBCLENBQUMsRUFDbEMsV0FBVyxFQUNYLGFBQWEsRUFDYixJQUFJLEVBQ0osYUFBYSxHQU1kO0lBQ0MsT0FBTztFQUNQLEtBQUssQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxJQUFJLEtBQUssQ0FBQyxHQUFHLENBQ3RDLHFDQUFxQyxLQUFLLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxVQUFVLENBQ3ZFOztNQUVHLElBQUk7Ozs7Y0FJSSxhQUFhOzs7Ozs7b0JBTVAsYUFBYTs7Ozs7OztDQU9oQyxDQUFBO0FBQ0QsQ0FBQztBQUVELFNBQVMsa0NBQWtDLENBQUMsRUFDMUMsV0FBVyxFQUNYLGFBQWEsRUFDYixlQUFlLEVBQ2YsYUFBYSxFQUNiLElBQUksRUFDSixhQUFhLEdBUWQ7SUFDQyxPQUFPO0VBQ1AsS0FBSyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLElBQUksS0FBSyxDQUFDLEdBQUcsQ0FDdEMscUNBQXFDLEtBQUssQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLFVBQVUsQ0FDdkU7O01BRUcsSUFBSTs7a0NBRXdCLEtBQUssQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDOzs7Ozs7Ozs7Ozs7Ozs7b0JBZXJDLGFBQWE7OzswQkFHUCxhQUFhO2tDQUNMLEtBQUssQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQzt5QkFDMUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDO0NBQ3JELENBQUE7QUFDRCxDQUFDO0FBRUQsU0FBUyxxQkFBcUIsQ0FBQyxFQUM3QixRQUFRLEVBQ1IsS0FBSyxHQUlOO0lBQ0MsT0FBTztFQUNQLEtBQUssQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxJQUFJLEtBQUssQ0FBQyxHQUFHLENBQ3RDLDhCQUE4QixLQUFLLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQ3JEOztFQUVELEtBQUssQ0FBQyxLQUFLOztHQUVWLENBQUE7QUFDSCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IGNoYWxrIGZyb20gXCJjaGFsa1wiXG5pbXBvcnQgeyB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcImZzXCJcbmltcG9ydCBmcyBmcm9tIFwiZnMtZXh0cmFcIlxuaW1wb3J0IHsgcG9zaXggfSBmcm9tIFwicGF0aFwiXG5pbXBvcnQgc2VtdmVyIGZyb20gXCJzZW12ZXJcIlxuaW1wb3J0IHsgaGFzaEZpbGUgfSBmcm9tIFwiLi9oYXNoLmpzXCJcbmltcG9ydCB7IGxvZ1BhdGNoU2VxdWVuY2VFcnJvciB9IGZyb20gXCIuL21ha2VQYXRjaC5qc1wiXG5pbXBvcnQgeyBQYWNrYWdlRGV0YWlscywgUGF0Y2hlZFBhY2thZ2VEZXRhaWxzIH0gZnJvbSBcIi4vUGFja2FnZURldGFpbHMuanNcIlxuaW1wb3J0IHsgcGFja2FnZUlzRGV2RGVwZW5kZW5jeSB9IGZyb20gXCIuL3BhY2thZ2VJc0RldkRlcGVuZGVuY3kuanNcIlxuaW1wb3J0IHsgZXhlY3V0ZUVmZmVjdHMgfSBmcm9tIFwiLi9wYXRjaC9hcHBseS5qc1wiXG5pbXBvcnQgeyByZWFkUGF0Y2ggfSBmcm9tIFwiLi9wYXRjaC9yZWFkLmpzXCJcbmltcG9ydCB7IHJldmVyc2VQYXRjaCB9IGZyb20gXCIuL3BhdGNoL3JldmVyc2UuanNcIlxuaW1wb3J0IHsgZ2V0R3JvdXBlZFBhdGNoZXMgfSBmcm9tIFwiLi9wYXRjaEZzLmpzXCJcbmltcG9ydCB7IGpvaW4sIHJlbGF0aXZlIH0gZnJvbSBcIi4vcGF0aC5qc1wiXG5pbXBvcnQge1xuICBjbGVhclBhdGNoQXBwbGljYXRpb25TdGF0ZSxcbiAgZ2V0UGF0Y2hBcHBsaWNhdGlvblN0YXRlLFxuICBQYXRjaFN0YXRlLFxuICBzYXZlUGF0Y2hBcHBsaWNhdGlvblN0YXRlLFxufSBmcm9tIFwiLi9zdGF0ZUZpbGUuanNcIlxuXG5jbGFzcyBQYXRjaEFwcGxpY2F0aW9uRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKG1zZzogc3RyaW5nKSB7XG4gICAgc3VwZXIobXNnKVxuICB9XG59XG5cbmZ1bmN0aW9uIGdldEluc3RhbGxlZFBhY2thZ2VWZXJzaW9uKHtcbiAgYXBwUGF0aCxcbiAgcGF0aCxcbiAgcGF0aFNwZWNpZmllcixcbiAgaXNEZXZPbmx5LFxuICBwYXRjaEZpbGVuYW1lLFxufToge1xuICBhcHBQYXRoOiBzdHJpbmdcbiAgcGF0aDogc3RyaW5nXG4gIHBhdGhTcGVjaWZpZXI6IHN0cmluZ1xuICBpc0Rldk9ubHk6IGJvb2xlYW5cbiAgcGF0Y2hGaWxlbmFtZTogc3RyaW5nXG59KTogbnVsbCB8IHN0cmluZyB7XG4gIGNvbnN0IHBhY2thZ2VEaXIgPSBqb2luKGFwcFBhdGgsIHBhdGgpXG4gIGlmICghZnMuZXhpc3RzU3luYyhwYWNrYWdlRGlyKSkge1xuICAgIGlmIChwcm9jZXNzLmVudi5OT0RFX0VOViA9PT0gXCJwcm9kdWN0aW9uXCIgJiYgaXNEZXZPbmx5KSB7XG4gICAgICByZXR1cm4gbnVsbFxuICAgIH1cblxuICAgIGxldCBlcnIgPVxuICAgICAgYCR7Y2hhbGsucmVkKFwiRXJyb3I6XCIpfSBQYXRjaCBmaWxlIGZvdW5kIGZvciBwYWNrYWdlICR7cG9zaXguYmFzZW5hbWUoXG4gICAgICAgIHBhdGhTcGVjaWZpZXIsXG4gICAgICApfWAgKyBgIHdoaWNoIGlzIG5vdCBwcmVzZW50IGF0ICR7cmVsYXRpdmUoXCIuXCIsIHBhY2thZ2VEaXIpfWBcblxuICAgIGlmICghaXNEZXZPbmx5ICYmIHByb2Nlc3MuZW52Lk5PREVfRU5WID09PSBcInByb2R1Y3Rpb25cIikge1xuICAgICAgZXJyICs9IGBcblxuICBJZiB0aGlzIHBhY2thZ2UgaXMgYSBkZXYgZGVwZW5kZW5jeSwgcmVuYW1lIHRoZSBwYXRjaCBmaWxlIHRvXG4gIFxuICAgICR7Y2hhbGsuYm9sZChwYXRjaEZpbGVuYW1lLnJlcGxhY2UoXCIucGF0Y2hcIiwgXCIuZGV2LnBhdGNoXCIpKX1cbmBcbiAgICB9XG4gICAgdGhyb3cgbmV3IFBhdGNoQXBwbGljYXRpb25FcnJvcihlcnIpXG4gIH1cblxuICBjb25zdCB7IHZlcnNpb24gfSA9IHJlcXVpcmUoam9pbihwYWNrYWdlRGlyLCBcInBhY2thZ2UuanNvblwiKSlcbiAgLy8gbm9ybWFsaXplIHZlcnNpb24gZm9yIGBucG0gY2lgXG4gIGNvbnN0IHJlc3VsdCA9IHNlbXZlci52YWxpZCh2ZXJzaW9uKVxuICBpZiAocmVzdWx0ID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IFBhdGNoQXBwbGljYXRpb25FcnJvcihcbiAgICAgIGAke2NoYWxrLnJlZChcbiAgICAgICAgXCJFcnJvcjpcIixcbiAgICAgICl9IFZlcnNpb24gc3RyaW5nICcke3ZlcnNpb259JyBjYW5ub3QgYmUgcGFyc2VkIGZyb20gJHtqb2luKFxuICAgICAgICBwYWNrYWdlRGlyLFxuICAgICAgICBcInBhY2thZ2UuanNvblwiLFxuICAgICAgKX1gLFxuICAgIClcbiAgfVxuXG4gIHJldHVybiByZXN1bHQgYXMgc3RyaW5nXG59XG5cbmZ1bmN0aW9uIGxvZ1BhdGNoQXBwbGljYXRpb24ocGF0Y2hEZXRhaWxzOiBQYXRjaGVkUGFja2FnZURldGFpbHMpIHtcbiAgY29uc3Qgc2VxdWVuY2VTdHJpbmcgPVxuICAgIHBhdGNoRGV0YWlscy5zZXF1ZW5jZU51bWJlciAhPSBudWxsXG4gICAgICA/IGAgKCR7cGF0Y2hEZXRhaWxzLnNlcXVlbmNlTnVtYmVyfSR7XG4gICAgICAgICAgcGF0Y2hEZXRhaWxzLnNlcXVlbmNlTmFtZSA/IFwiIFwiICsgcGF0Y2hEZXRhaWxzLnNlcXVlbmNlTmFtZSA6IFwiXCJcbiAgICAgICAgfSlgXG4gICAgICA6IFwiXCJcbiAgY29uc29sZS5sb2coXG4gICAgYCR7Y2hhbGsuYm9sZChwYXRjaERldGFpbHMucGF0aFNwZWNpZmllcil9QCR7XG4gICAgICBwYXRjaERldGFpbHMudmVyc2lvblxuICAgIH0ke3NlcXVlbmNlU3RyaW5nfSAke2NoYWxrLmdyZWVuKFwi4pyUXCIpfWAsXG4gIClcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5UGF0Y2hlc0ZvckFwcCh7XG4gIGFwcFBhdGgsXG4gIHJldmVyc2UsXG4gIHBhdGNoRGlyLFxuICBzaG91bGRFeGl0V2l0aEVycm9yLFxuICBzaG91bGRFeGl0V2l0aFdhcm5pbmcsXG4gIGJlc3RFZmZvcnQsXG59OiB7XG4gIGFwcFBhdGg6IHN0cmluZ1xuICByZXZlcnNlOiBib29sZWFuXG4gIHBhdGNoRGlyOiBzdHJpbmdcbiAgc2hvdWxkRXhpdFdpdGhFcnJvcjogYm9vbGVhblxuICBzaG91bGRFeGl0V2l0aFdhcm5pbmc6IGJvb2xlYW5cbiAgYmVzdEVmZm9ydDogYm9vbGVhblxufSk6IHZvaWQge1xuICBjb25zdCBwYXRjaGVzRGlyZWN0b3J5ID0gam9pbihhcHBQYXRoLCBwYXRjaERpcilcbiAgY29uc3QgZ3JvdXBlZFBhdGNoZXMgPSBnZXRHcm91cGVkUGF0Y2hlcyhwYXRjaGVzRGlyZWN0b3J5KVxuXG4gIGlmIChncm91cGVkUGF0Y2hlcy5udW1QYXRjaEZpbGVzID09PSAwKSB7XG4gICAgY29uc29sZS5sb2coY2hhbGsuYmx1ZUJyaWdodChcIk5vIHBhdGNoIGZpbGVzIGZvdW5kXCIpKVxuICAgIHJldHVyblxuICB9XG5cbiAgY29uc3QgZXJyb3JzOiBzdHJpbmdbXSA9IFtdXG4gIGNvbnN0IHdhcm5pbmdzOiBzdHJpbmdbXSA9IFsuLi5ncm91cGVkUGF0Y2hlcy53YXJuaW5nc11cblxuICBmb3IgKGNvbnN0IHBhdGNoZXMgb2YgT2JqZWN0LnZhbHVlcyhcbiAgICBncm91cGVkUGF0Y2hlcy5wYXRoU3BlY2lmaWVyVG9QYXRjaEZpbGVzLFxuICApKSB7XG4gICAgYXBwbHlQYXRjaGVzRm9yUGFja2FnZSh7XG4gICAgICBwYXRjaGVzLFxuICAgICAgYXBwUGF0aCxcbiAgICAgIHBhdGNoRGlyLFxuICAgICAgcmV2ZXJzZSxcbiAgICAgIHdhcm5pbmdzLFxuICAgICAgZXJyb3JzLFxuICAgICAgYmVzdEVmZm9ydCxcbiAgICB9KVxuICB9XG5cbiAgZm9yIChjb25zdCB3YXJuaW5nIG9mIHdhcm5pbmdzKSB7XG4gICAgY29uc29sZS5sb2cod2FybmluZylcbiAgfVxuICBmb3IgKGNvbnN0IGVycm9yIG9mIGVycm9ycykge1xuICAgIGNvbnNvbGUubG9nKGVycm9yKVxuICB9XG5cbiAgY29uc3QgcHJvYmxlbXNTdW1tYXJ5ID0gW11cbiAgaWYgKHdhcm5pbmdzLmxlbmd0aCkge1xuICAgIHByb2JsZW1zU3VtbWFyeS5wdXNoKGNoYWxrLnllbGxvdyhgJHt3YXJuaW5ncy5sZW5ndGh9IHdhcm5pbmcocylgKSlcbiAgfVxuICBpZiAoZXJyb3JzLmxlbmd0aCkge1xuICAgIHByb2JsZW1zU3VtbWFyeS5wdXNoKGNoYWxrLnJlZChgJHtlcnJvcnMubGVuZ3RofSBlcnJvcihzKWApKVxuICB9XG5cbiAgaWYgKHByb2JsZW1zU3VtbWFyeS5sZW5ndGgpIHtcbiAgICBjb25zb2xlLmxvZyhcIi0tLVwiKVxuICAgIGNvbnNvbGUubG9nKFwicGF0Y2gtcGFja2FnZSBmaW5pc2hlZCB3aXRoXCIsIHByb2JsZW1zU3VtbWFyeS5qb2luKFwiLCBcIikgKyBcIi5cIilcbiAgfVxuXG4gIGlmIChlcnJvcnMubGVuZ3RoICYmIHNob3VsZEV4aXRXaXRoRXJyb3IpIHtcbiAgICBwcm9jZXNzLmV4aXQoMSlcbiAgfVxuXG4gIGlmICh3YXJuaW5ncy5sZW5ndGggJiYgc2hvdWxkRXhpdFdpdGhXYXJuaW5nKSB7XG4gICAgcHJvY2Vzcy5leGl0KDEpXG4gIH1cblxuICBwcm9jZXNzLmV4aXQoMClcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5UGF0Y2hlc0ZvclBhY2thZ2Uoe1xuICBwYXRjaGVzLFxuICBhcHBQYXRoLFxuICBwYXRjaERpcixcbiAgcmV2ZXJzZSxcbiAgd2FybmluZ3MsXG4gIGVycm9ycyxcbiAgYmVzdEVmZm9ydCxcbn06IHtcbiAgcGF0Y2hlczogUGF0Y2hlZFBhY2thZ2VEZXRhaWxzW11cbiAgYXBwUGF0aDogc3RyaW5nXG4gIHBhdGNoRGlyOiBzdHJpbmdcbiAgcmV2ZXJzZTogYm9vbGVhblxuICB3YXJuaW5nczogc3RyaW5nW11cbiAgZXJyb3JzOiBzdHJpbmdbXVxuICBiZXN0RWZmb3J0OiBib29sZWFuXG59KSB7XG4gIGNvbnN0IHBhdGhTcGVjaWZpZXIgPSBwYXRjaGVzWzBdLnBhdGhTcGVjaWZpZXJcbiAgY29uc3Qgc3RhdGUgPSBwYXRjaGVzLmxlbmd0aCA+IDEgPyBnZXRQYXRjaEFwcGxpY2F0aW9uU3RhdGUocGF0Y2hlc1swXSkgOiBudWxsXG4gIGNvbnN0IHVuYXBwbGllZFBhdGNoZXMgPSBwYXRjaGVzLnNsaWNlKDApXG4gIGNvbnN0IGFwcGxpZWRQYXRjaGVzOiBQYXRjaGVkUGFja2FnZURldGFpbHNbXSA9IFtdXG4gIC8vIGlmIHRoZXJlIGFyZSBtdWx0aXBsZSBwYXRjaGVzIHRvIGFwcGx5LCB3ZSBjYW4ndCByZWx5IG9uIHRoZSByZXZlcnNlLXBhdGNoLWRyeS1ydW4gYmVoYXZpb3IgdG8gbWFrZSB0aGlzIG9wZXJhdGlvblxuICAvLyBpZGVtcG90ZW50LCBzbyBpbnN0ZWFkIHdlIG5lZWQgdG8gY2hlY2sgdGhlIHN0YXRlIGZpbGUgdG8gc2VlIHdoZXRoZXIgd2UgaGF2ZSBhbHJlYWR5IGFwcGxpZWQgYW55IG9mIHRoZSBwYXRjaGVzXG4gIC8vIHRvZG86IG9uY2UgdGhpcyBpcyBiYXR0bGUgdGVzdGVkIHdlIG1pZ2h0IHdhbnQgdG8gdXNlIHRoZSBzYW1lIGFwcHJvYWNoIGZvciBzaW5nbGUgcGF0Y2hlcyBhcyB3ZWxsLCBidXQgaXQncyBub3QgYmlnZ2llIHNpbmNlIHRoZSBkcnkgcnVuIHRoaW5nIGlzIGZhc3RcbiAgaWYgKHVuYXBwbGllZFBhdGNoZXMgJiYgc3RhdGUpIHtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IHN0YXRlLnBhdGNoZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IHBhdGNoVGhhdFdhc0FwcGxpZWQgPSBzdGF0ZS5wYXRjaGVzW2ldXG4gICAgICBpZiAoIXBhdGNoVGhhdFdhc0FwcGxpZWQuZGlkQXBwbHkpIHtcbiAgICAgICAgYnJlYWtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHBhdGNoVG9BcHBseSA9IHVuYXBwbGllZFBhdGNoZXNbMF1cbiAgICAgIGNvbnN0IGN1cnJlbnRQYXRjaEhhc2ggPSBoYXNoRmlsZShcbiAgICAgICAgam9pbihhcHBQYXRoLCBwYXRjaERpciwgcGF0Y2hUb0FwcGx5LnBhdGNoRmlsZW5hbWUpLFxuICAgICAgKVxuICAgICAgaWYgKHBhdGNoVGhhdFdhc0FwcGxpZWQucGF0Y2hDb250ZW50SGFzaCA9PT0gY3VycmVudFBhdGNoSGFzaCkge1xuICAgICAgICAvLyB0aGlzIHBhdGNoIHdhcyBhcHBsaWVkIHdlIGNhbiBza2lwIGl0XG4gICAgICAgIGFwcGxpZWRQYXRjaGVzLnB1c2godW5hcHBsaWVkUGF0Y2hlcy5zaGlmdCgpISlcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnNvbGUubG9nKFxuICAgICAgICAgIGNoYWxrLnJlZChcIkVycm9yOlwiKSxcbiAgICAgICAgICBgVGhlIHBhdGNoZXMgZm9yICR7Y2hhbGsuYm9sZChwYXRoU3BlY2lmaWVyKX0gaGF2ZSBjaGFuZ2VkLmAsXG4gICAgICAgICAgYFlvdSBzaG91bGQgcmVpbnN0YWxsIHlvdXIgbm9kZV9tb2R1bGVzIGZvbGRlciB0byBtYWtlIHN1cmUgdGhlIHBhY2thZ2UgaXMgdXAgdG8gZGF0ZWAsXG4gICAgICAgIClcbiAgICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgaWYgKHJldmVyc2UgJiYgc3RhdGUpIHtcbiAgICAvLyBpZiB3ZSBhcmUgcmV2ZXJzaW5nIHRoZSBwYXRjaGVzIHdlIG5lZWQgdG8gbWFrZSB0aGUgdW5hcHBsaWVkUGF0Y2hlcyBhcnJheVxuICAgIC8vIGJlIHRoZSByZXZlcnNlZCB2ZXJzaW9uIG9mIHRoZSBhcHBsaWVkUGF0Y2hlcyBhcnJheS5cbiAgICAvLyBUaGUgYXBwbGllZCBwYXRjaGVzIGFycmF5IHNob3VsZCB0aGVuIGJlIGVtcHR5IGJlY2F1c2UgaXQgaXMgdXNlZCBkaWZmZXJlbnRseVxuICAgIC8vIHdoZW4gb3V0cHV0dGluZyB0aGUgc3RhdGUgZmlsZS5cbiAgICB1bmFwcGxpZWRQYXRjaGVzLmxlbmd0aCA9IDBcbiAgICB1bmFwcGxpZWRQYXRjaGVzLnB1c2goLi4uYXBwbGllZFBhdGNoZXMpXG4gICAgdW5hcHBsaWVkUGF0Y2hlcy5yZXZlcnNlKClcbiAgICBhcHBsaWVkUGF0Y2hlcy5sZW5ndGggPSAwXG4gIH1cbiAgaWYgKGFwcGxpZWRQYXRjaGVzLmxlbmd0aCkge1xuICAgIC8vIHNvbWUgcGF0Y2hlcyBoYXZlIGFscmVhZHkgYmVlbiBhcHBsaWVkXG4gICAgYXBwbGllZFBhdGNoZXMuZm9yRWFjaChsb2dQYXRjaEFwcGxpY2F0aW9uKVxuICB9XG4gIGlmICghdW5hcHBsaWVkUGF0Y2hlcy5sZW5ndGgpIHtcbiAgICByZXR1cm5cbiAgfVxuICBsZXQgZmFpbGVkUGF0Y2g6IFBhdGNoZWRQYWNrYWdlRGV0YWlscyB8IG51bGwgPSBudWxsXG4gIHBhY2thZ2VMb29wOiBmb3IgKGNvbnN0IHBhdGNoRGV0YWlscyBvZiB1bmFwcGxpZWRQYXRjaGVzKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgbmFtZSwgdmVyc2lvbiwgcGF0aCwgaXNEZXZPbmx5LCBwYXRjaEZpbGVuYW1lIH0gPSBwYXRjaERldGFpbHNcblxuICAgICAgY29uc3QgaW5zdGFsbGVkUGFja2FnZVZlcnNpb24gPSBnZXRJbnN0YWxsZWRQYWNrYWdlVmVyc2lvbih7XG4gICAgICAgIGFwcFBhdGgsXG4gICAgICAgIHBhdGgsXG4gICAgICAgIHBhdGhTcGVjaWZpZXIsXG4gICAgICAgIGlzRGV2T25seTpcbiAgICAgICAgICBpc0Rldk9ubHkgfHxcbiAgICAgICAgICAvLyBjaGVjayBmb3IgZGlyZWN0LWRlcGVuZGVudHMgaW4gcHJvZFxuICAgICAgICAgIChwcm9jZXNzLmVudi5OT0RFX0VOViA9PT0gXCJwcm9kdWN0aW9uXCIgJiZcbiAgICAgICAgICAgIHBhY2thZ2VJc0RldkRlcGVuZGVuY3koe1xuICAgICAgICAgICAgICBhcHBQYXRoLFxuICAgICAgICAgICAgICBwYXRjaERldGFpbHMsXG4gICAgICAgICAgICB9KSksXG4gICAgICAgIHBhdGNoRmlsZW5hbWUsXG4gICAgICB9KVxuICAgICAgaWYgKCFpbnN0YWxsZWRQYWNrYWdlVmVyc2lvbikge1xuICAgICAgICAvLyBpdCdzIG9rIHdlJ3JlIGluIHByb2R1Y3Rpb24gbW9kZSBhbmQgdGhpcyBpcyBhIGRldiBvbmx5IHBhY2thZ2VcbiAgICAgICAgY29uc29sZS5sb2coXG4gICAgICAgICAgYFNraXBwaW5nIGRldi1vbmx5ICR7Y2hhbGsuYm9sZChcbiAgICAgICAgICAgIHBhdGhTcGVjaWZpZXIsXG4gICAgICAgICAgKX1AJHt2ZXJzaW9ufSAke2NoYWxrLmJsdWUoXCLinJRcIil9YCxcbiAgICAgICAgKVxuICAgICAgICBjb250aW51ZVxuICAgICAgfVxuXG4gICAgICBpZiAoXG4gICAgICAgIGFwcGx5UGF0Y2goe1xuICAgICAgICAgIHBhdGNoRmlsZVBhdGg6IGpvaW4oYXBwUGF0aCwgcGF0Y2hEaXIsIHBhdGNoRmlsZW5hbWUpIGFzIHN0cmluZyxcbiAgICAgICAgICByZXZlcnNlLFxuICAgICAgICAgIHBhdGNoRGV0YWlscyxcbiAgICAgICAgICBwYXRjaERpcixcbiAgICAgICAgICBjd2Q6IHByb2Nlc3MuY3dkKCksXG4gICAgICAgICAgYmVzdEVmZm9ydCxcbiAgICAgICAgfSlcbiAgICAgICkge1xuICAgICAgICBhcHBsaWVkUGF0Y2hlcy5wdXNoKHBhdGNoRGV0YWlscylcbiAgICAgICAgLy8geWF5IHBhdGNoIHdhcyBhcHBsaWVkIHN1Y2Nlc3NmdWxseVxuICAgICAgICAvLyBwcmludCB3YXJuaW5nIGlmIHZlcnNpb24gbWlzbWF0Y2hcbiAgICAgICAgaWYgKGluc3RhbGxlZFBhY2thZ2VWZXJzaW9uICE9PSB2ZXJzaW9uKSB7XG4gICAgICAgICAgd2FybmluZ3MucHVzaChcbiAgICAgICAgICAgIGNyZWF0ZVZlcnNpb25NaXNtYXRjaFdhcm5pbmcoe1xuICAgICAgICAgICAgICBwYWNrYWdlTmFtZTogbmFtZSxcbiAgICAgICAgICAgICAgYWN0dWFsVmVyc2lvbjogaW5zdGFsbGVkUGFja2FnZVZlcnNpb24sXG4gICAgICAgICAgICAgIG9yaWdpbmFsVmVyc2lvbjogdmVyc2lvbixcbiAgICAgICAgICAgICAgcGF0aFNwZWNpZmllcixcbiAgICAgICAgICAgICAgcGF0aCxcbiAgICAgICAgICAgIH0pLFxuICAgICAgICAgIClcbiAgICAgICAgfVxuICAgICAgICBsb2dQYXRjaEFwcGxpY2F0aW9uKHBhdGNoRGV0YWlscylcbiAgICAgIH0gZWxzZSBpZiAocGF0Y2hlcy5sZW5ndGggPiAxKSB7XG4gICAgICAgIGxvZ1BhdGNoU2VxdWVuY2VFcnJvcih7IHBhdGNoRGV0YWlscyB9KVxuICAgICAgICAvLyBpbiBjYXNlIHRoZSBwYWNrYWdlIGhhcyBtdWx0aXBsZSBwYXRjaGVzLCB3ZSBuZWVkIHRvIGJyZWFrIG91dCBvZiB0aGlzIGlubmVyIGxvb3BcbiAgICAgICAgLy8gYmVjYXVzZSB3ZSBkb24ndCB3YW50IHRvIGFwcGx5IG1vcmUgcGF0Y2hlcyBvbiB0b3Agb2YgdGhlIGJyb2tlbiBzdGF0ZVxuICAgICAgICBmYWlsZWRQYXRjaCA9IHBhdGNoRGV0YWlsc1xuICAgICAgICBicmVhayBwYWNrYWdlTG9vcFxuICAgICAgfSBlbHNlIGlmIChpbnN0YWxsZWRQYWNrYWdlVmVyc2lvbiA9PT0gdmVyc2lvbikge1xuICAgICAgICAvLyBjb21wbGV0ZWx5IGZhaWxlZCB0byBhcHBseSBwYXRjaFxuICAgICAgICAvLyBUT0RPOiBwcm9wYWdhdGUgdXNlZnVsIGVycm9yIG1lc3NhZ2VzIGZyb20gcGF0Y2ggYXBwbGljYXRpb25cbiAgICAgICAgZXJyb3JzLnB1c2goXG4gICAgICAgICAgY3JlYXRlQnJva2VuUGF0Y2hGaWxlRXJyb3Ioe1xuICAgICAgICAgICAgcGFja2FnZU5hbWU6IG5hbWUsXG4gICAgICAgICAgICBwYXRjaEZpbGVuYW1lLFxuICAgICAgICAgICAgcGF0aFNwZWNpZmllcixcbiAgICAgICAgICAgIHBhdGgsXG4gICAgICAgICAgfSksXG4gICAgICAgIClcbiAgICAgICAgYnJlYWsgcGFja2FnZUxvb3BcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGVycm9ycy5wdXNoKFxuICAgICAgICAgIGNyZWF0ZVBhdGNoQXBwbGljYXRpb25GYWlsdXJlRXJyb3Ioe1xuICAgICAgICAgICAgcGFja2FnZU5hbWU6IG5hbWUsXG4gICAgICAgICAgICBhY3R1YWxWZXJzaW9uOiBpbnN0YWxsZWRQYWNrYWdlVmVyc2lvbixcbiAgICAgICAgICAgIG9yaWdpbmFsVmVyc2lvbjogdmVyc2lvbixcbiAgICAgICAgICAgIHBhdGNoRmlsZW5hbWUsXG4gICAgICAgICAgICBwYXRoLFxuICAgICAgICAgICAgcGF0aFNwZWNpZmllcixcbiAgICAgICAgICB9KSxcbiAgICAgICAgKVxuICAgICAgICAvLyBpbiBjYXNlIHRoZSBwYWNrYWdlIGhhcyBtdWx0aXBsZSBwYXRjaGVzLCB3ZSBuZWVkIHRvIGJyZWFrIG91dCBvZiB0aGlzIGlubmVyIGxvb3BcbiAgICAgICAgLy8gYmVjYXVzZSB3ZSBkb24ndCB3YW50IHRvIGFwcGx5IG1vcmUgcGF0Y2hlcyBvbiB0b3Agb2YgdGhlIGJyb2tlbiBzdGF0ZVxuICAgICAgICBicmVhayBwYWNrYWdlTG9vcFxuICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBQYXRjaEFwcGxpY2F0aW9uRXJyb3IpIHtcbiAgICAgICAgZXJyb3JzLnB1c2goZXJyb3IubWVzc2FnZSlcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGVycm9ycy5wdXNoKFxuICAgICAgICAgIGNyZWF0ZVVuZXhwZWN0ZWRFcnJvcih7XG4gICAgICAgICAgICBmaWxlbmFtZTogcGF0Y2hEZXRhaWxzLnBhdGNoRmlsZW5hbWUsXG4gICAgICAgICAgICBlcnJvcjogZXJyb3IgYXMgRXJyb3IsXG4gICAgICAgICAgfSksXG4gICAgICAgIClcbiAgICAgIH1cbiAgICAgIC8vIGluIGNhc2UgdGhlIHBhY2thZ2UgaGFzIG11bHRpcGxlIHBhdGNoZXMsIHdlIG5lZWQgdG8gYnJlYWsgb3V0IG9mIHRoaXMgaW5uZXIgbG9vcFxuICAgICAgLy8gYmVjYXVzZSB3ZSBkb24ndCB3YW50IHRvIGFwcGx5IG1vcmUgcGF0Y2hlcyBvbiB0b3Agb2YgdGhlIGJyb2tlbiBzdGF0ZVxuICAgICAgYnJlYWsgcGFja2FnZUxvb3BcbiAgICB9XG4gIH1cblxuICBpZiAocGF0Y2hlcy5sZW5ndGggPiAxKSB7XG4gICAgaWYgKHJldmVyc2UpIHtcbiAgICAgIGlmICghc3RhdGUpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwidW5leHBlY3RlZCBzdGF0ZTogbm8gc3RhdGUgZmlsZSBmb3VuZCB3aGlsZSByZXZlcnNpbmdcIilcbiAgICAgIH1cbiAgICAgIC8vIGlmIHdlIHJlbW92ZWQgYWxsIHRoZSBwYXRjaGVzIHRoYXQgd2VyZSBwcmV2aW91c2x5IGFwcGxpZWQgd2UgY2FuIGRlbGV0ZSB0aGUgc3RhdGUgZmlsZVxuICAgICAgaWYgKGFwcGxpZWRQYXRjaGVzLmxlbmd0aCA9PT0gcGF0Y2hlcy5sZW5ndGgpIHtcbiAgICAgICAgY2xlYXJQYXRjaEFwcGxpY2F0aW9uU3RhdGUocGF0Y2hlc1swXSlcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIFdlIGZhaWxlZCB3aGlsZSByZXZlcnNpbmcgcGF0Y2hlcyBhbmQgc29tZSBhcmUgc3RpbGwgaW4gdGhlIGFwcGxpZWQgc3RhdGUuXG4gICAgICAgIC8vIFdlIG5lZWQgdG8gdXBkYXRlIHRoZSBzdGF0ZSBmaWxlIHRvIHJlZmxlY3QgdGhhdC5cbiAgICAgICAgLy8gYXBwbGllZFBhdGNoZXMgaXMgY3VycmVudGx5IHRoZSBwYXRjaGVzIHRoYXQgd2VyZSBzdWNjZXNzZnVsbHkgcmV2ZXJzZWQsIGluIHRoZSBvcmRlciB0aGV5IHdlcmUgcmV2ZXJzZWRcbiAgICAgICAgLy8gU28gd2UgbmVlZCB0byBmaW5kIHRoZSBpbmRleCBvZiB0aGUgbGFzdCByZXZlcnNlZCBwYXRjaCBpbiB0aGUgb3JpZ2luYWwgcGF0Y2hlcyBhcnJheVxuICAgICAgICAvLyBhbmQgdGhlbiByZW1vdmUgYWxsIHRoZSBwYXRjaGVzIGFmdGVyIHRoYXQuIFNvcnJ5IGZvciB0aGUgY29uZnVzaW5nIGNvZGUuXG4gICAgICAgIGNvbnN0IGxhc3RSZXZlcnNlZFBhdGNoSW5kZXggPSBwYXRjaGVzLmluZGV4T2YoXG4gICAgICAgICAgYXBwbGllZFBhdGNoZXNbYXBwbGllZFBhdGNoZXMubGVuZ3RoIC0gMV0sXG4gICAgICAgIClcbiAgICAgICAgaWYgKGxhc3RSZXZlcnNlZFBhdGNoSW5kZXggPT09IC0xKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgXCJ1bmV4cGVjdGVkIHN0YXRlOiBmYWlsZWQgdG8gZmluZCBsYXN0IHJldmVyc2VkIHBhdGNoIGluIG9yaWdpbmFsIHBhdGNoZXMgYXJyYXlcIixcbiAgICAgICAgICApXG4gICAgICAgIH1cblxuICAgICAgICBzYXZlUGF0Y2hBcHBsaWNhdGlvblN0YXRlKHtcbiAgICAgICAgICBwYWNrYWdlRGV0YWlsczogcGF0Y2hlc1swXSxcbiAgICAgICAgICBwYXRjaGVzOiBwYXRjaGVzLnNsaWNlKDAsIGxhc3RSZXZlcnNlZFBhdGNoSW5kZXgpLm1hcCgocGF0Y2gpID0+ICh7XG4gICAgICAgICAgICBkaWRBcHBseTogdHJ1ZSxcbiAgICAgICAgICAgIHBhdGNoQ29udGVudEhhc2g6IGhhc2hGaWxlKFxuICAgICAgICAgICAgICBqb2luKGFwcFBhdGgsIHBhdGNoRGlyLCBwYXRjaC5wYXRjaEZpbGVuYW1lKSxcbiAgICAgICAgICAgICksXG4gICAgICAgICAgICBwYXRjaEZpbGVuYW1lOiBwYXRjaC5wYXRjaEZpbGVuYW1lLFxuICAgICAgICAgIH0pKSxcbiAgICAgICAgICBpc1JlYmFzaW5nOiBmYWxzZSxcbiAgICAgICAgfSlcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgbmV4dFN0YXRlID0gYXBwbGllZFBhdGNoZXMubWFwKFxuICAgICAgICAocGF0Y2gpOiBQYXRjaFN0YXRlID0+ICh7XG4gICAgICAgICAgZGlkQXBwbHk6IHRydWUsXG4gICAgICAgICAgcGF0Y2hDb250ZW50SGFzaDogaGFzaEZpbGUoXG4gICAgICAgICAgICBqb2luKGFwcFBhdGgsIHBhdGNoRGlyLCBwYXRjaC5wYXRjaEZpbGVuYW1lKSxcbiAgICAgICAgICApLFxuICAgICAgICAgIHBhdGNoRmlsZW5hbWU6IHBhdGNoLnBhdGNoRmlsZW5hbWUsXG4gICAgICAgIH0pLFxuICAgICAgKVxuXG4gICAgICBpZiAoZmFpbGVkUGF0Y2gpIHtcbiAgICAgICAgbmV4dFN0YXRlLnB1c2goe1xuICAgICAgICAgIGRpZEFwcGx5OiBmYWxzZSxcbiAgICAgICAgICBwYXRjaENvbnRlbnRIYXNoOiBoYXNoRmlsZShcbiAgICAgICAgICAgIGpvaW4oYXBwUGF0aCwgcGF0Y2hEaXIsIGZhaWxlZFBhdGNoLnBhdGNoRmlsZW5hbWUpLFxuICAgICAgICAgICksXG4gICAgICAgICAgcGF0Y2hGaWxlbmFtZTogZmFpbGVkUGF0Y2gucGF0Y2hGaWxlbmFtZSxcbiAgICAgICAgfSlcbiAgICAgIH1cbiAgICAgIHNhdmVQYXRjaEFwcGxpY2F0aW9uU3RhdGUoe1xuICAgICAgICBwYWNrYWdlRGV0YWlsczogcGF0Y2hlc1swXSxcbiAgICAgICAgcGF0Y2hlczogbmV4dFN0YXRlLFxuICAgICAgICBpc1JlYmFzaW5nOiAhIWZhaWxlZFBhdGNoLFxuICAgICAgfSlcbiAgICB9XG4gICAgaWYgKGZhaWxlZFBhdGNoKSB7XG4gICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICB9XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5UGF0Y2goe1xuICBwYXRjaEZpbGVQYXRoLFxuICByZXZlcnNlLFxuICBwYXRjaERldGFpbHMsXG4gIHBhdGNoRGlyLFxuICBjd2QsXG4gIGJlc3RFZmZvcnQsXG59OiB7XG4gIHBhdGNoRmlsZVBhdGg6IHN0cmluZ1xuICByZXZlcnNlOiBib29sZWFuXG4gIHBhdGNoRGV0YWlsczogUGFja2FnZURldGFpbHNcbiAgcGF0Y2hEaXI6IHN0cmluZ1xuICBjd2Q6IHN0cmluZ1xuICBiZXN0RWZmb3J0OiBib29sZWFuXG59KTogYm9vbGVhbiB7XG4gIGNvbnN0IHBhdGNoID0gcmVhZFBhdGNoKHtcbiAgICBwYXRjaEZpbGVQYXRoLFxuICAgIHBhdGNoRGV0YWlscyxcbiAgICBwYXRjaERpcixcbiAgfSlcblxuICBjb25zdCBmb3J3YXJkID0gcmV2ZXJzZSA/IHJldmVyc2VQYXRjaChwYXRjaCkgOiBwYXRjaFxuICB0cnkge1xuICAgIGlmICghYmVzdEVmZm9ydCkge1xuICAgICAgZXhlY3V0ZUVmZmVjdHMoZm9yd2FyZCwgeyBkcnlSdW46IHRydWUsIGN3ZCwgYmVzdEVmZm9ydDogZmFsc2UgfSlcbiAgICB9XG4gICAgY29uc3QgZXJyb3JzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZCA9IGJlc3RFZmZvcnQgPyBbXSA6IHVuZGVmaW5lZFxuICAgIGV4ZWN1dGVFZmZlY3RzKGZvcndhcmQsIHsgZHJ5UnVuOiBmYWxzZSwgY3dkLCBiZXN0RWZmb3J0LCBlcnJvcnMgfSlcbiAgICBpZiAoZXJyb3JzPy5sZW5ndGgpIHtcbiAgICAgIGNvbnNvbGUubG9nKFxuICAgICAgICBcIlNhdmluZyBlcnJvcnMgdG9cIixcbiAgICAgICAgY2hhbGsuY3lhbi5ib2xkKFwiLi9wYXRjaC1wYWNrYWdlLWVycm9ycy5sb2dcIiksXG4gICAgICApXG4gICAgICB3cml0ZUZpbGVTeW5jKFwicGF0Y2gtcGFja2FnZS1lcnJvcnMubG9nXCIsIGVycm9ycy5qb2luKFwiXFxuXFxuXCIpKVxuICAgICAgcHJvY2Vzcy5leGl0KDApXG4gICAgfVxuICB9IGNhdGNoIChlKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGJhY2t3YXJkID0gcmV2ZXJzZSA/IHBhdGNoIDogcmV2ZXJzZVBhdGNoKHBhdGNoKVxuICAgICAgZXhlY3V0ZUVmZmVjdHMoYmFja3dhcmQsIHtcbiAgICAgICAgZHJ5UnVuOiB0cnVlLFxuICAgICAgICBjd2QsXG4gICAgICAgIGJlc3RFZmZvcnQ6IGZhbHNlLFxuICAgICAgfSlcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICByZXR1cm4gZmFsc2VcbiAgICB9XG4gIH1cblxuICByZXR1cm4gdHJ1ZVxufVxuXG5mdW5jdGlvbiBjcmVhdGVWZXJzaW9uTWlzbWF0Y2hXYXJuaW5nKHtcbiAgcGFja2FnZU5hbWUsXG4gIGFjdHVhbFZlcnNpb24sXG4gIG9yaWdpbmFsVmVyc2lvbixcbiAgcGF0aFNwZWNpZmllcixcbiAgcGF0aCxcbn06IHtcbiAgcGFja2FnZU5hbWU6IHN0cmluZ1xuICBhY3R1YWxWZXJzaW9uOiBzdHJpbmdcbiAgb3JpZ2luYWxWZXJzaW9uOiBzdHJpbmdcbiAgcGF0aFNwZWNpZmllcjogc3RyaW5nXG4gIHBhdGg6IHN0cmluZ1xufSkge1xuICByZXR1cm4gYFxuJHtjaGFsay55ZWxsb3coXCJXYXJuaW5nOlwiKX0gcGF0Y2gtcGFja2FnZSBkZXRlY3RlZCBhIHBhdGNoIGZpbGUgdmVyc2lvbiBtaXNtYXRjaFxuXG4gIERvbid0IHdvcnJ5ISBUaGlzIGlzIHByb2JhYmx5IGZpbmUuIFRoZSBwYXRjaCB3YXMgc3RpbGwgYXBwbGllZFxuICBzdWNjZXNzZnVsbHkuIEhlcmUncyB0aGUgZGVldHM6XG5cbiAgUGF0Y2ggZmlsZSBjcmVhdGVkIGZvclxuXG4gICAgJHtwYWNrYWdlTmFtZX1AJHtjaGFsay5ib2xkKG9yaWdpbmFsVmVyc2lvbil9XG5cbiAgYXBwbGllZCB0b1xuXG4gICAgJHtwYWNrYWdlTmFtZX1AJHtjaGFsay5ib2xkKGFjdHVhbFZlcnNpb24pfVxuICBcbiAgQXQgcGF0aFxuICBcbiAgICAke3BhdGh9XG5cbiAgVGhpcyB3YXJuaW5nIGlzIGp1c3QgdG8gZ2l2ZSB5b3UgYSBoZWFkcy11cC4gVGhlcmUgaXMgYSBzbWFsbCBjaGFuY2Ugb2ZcbiAgYnJlYWthZ2UgZXZlbiB0aG91Z2ggdGhlIHBhdGNoIHdhcyBhcHBsaWVkIHN1Y2Nlc3NmdWxseS4gTWFrZSBzdXJlIHRoZSBwYWNrYWdlXG4gIHN0aWxsIGJlaGF2ZXMgbGlrZSB5b3UgZXhwZWN0ICh5b3Ugd3JvdGUgdGVzdHMsIHJpZ2h0PykgYW5kIHRoZW4gcnVuXG5cbiAgICAke2NoYWxrLmJvbGQoYHBhdGNoLXBhY2thZ2UgJHtwYXRoU3BlY2lmaWVyfWApfVxuXG4gIHRvIHVwZGF0ZSB0aGUgdmVyc2lvbiBpbiB0aGUgcGF0Y2ggZmlsZSBuYW1lIGFuZCBtYWtlIHRoaXMgd2FybmluZyBnbyBhd2F5LlxuYFxufVxuXG5mdW5jdGlvbiBjcmVhdGVCcm9rZW5QYXRjaEZpbGVFcnJvcih7XG4gIHBhY2thZ2VOYW1lLFxuICBwYXRjaEZpbGVuYW1lLFxuICBwYXRoLFxuICBwYXRoU3BlY2lmaWVyLFxufToge1xuICBwYWNrYWdlTmFtZTogc3RyaW5nXG4gIHBhdGNoRmlsZW5hbWU6IHN0cmluZ1xuICBwYXRoOiBzdHJpbmdcbiAgcGF0aFNwZWNpZmllcjogc3RyaW5nXG59KSB7XG4gIHJldHVybiBgXG4ke2NoYWxrLnJlZC5ib2xkKFwiKipFUlJPUioqXCIpfSAke2NoYWxrLnJlZChcbiAgICBgRmFpbGVkIHRvIGFwcGx5IHBhdGNoIGZvciBwYWNrYWdlICR7Y2hhbGsuYm9sZChwYWNrYWdlTmFtZSl9IGF0IHBhdGhgLFxuICApfVxuICBcbiAgICAke3BhdGh9XG5cbiAgVGhpcyBlcnJvciB3YXMgY2F1c2VkIGJlY2F1c2UgcGF0Y2gtcGFja2FnZSBjYW5ub3QgYXBwbHkgdGhlIGZvbGxvd2luZyBwYXRjaCBmaWxlOlxuXG4gICAgcGF0Y2hlcy8ke3BhdGNoRmlsZW5hbWV9XG5cbiAgVHJ5IHJlbW92aW5nIG5vZGVfbW9kdWxlcyBhbmQgdHJ5aW5nIGFnYWluLiBJZiB0aGF0IGRvZXNuJ3Qgd29yaywgbWF5YmUgdGhlcmUgd2FzXG4gIGFuIGFjY2lkZW50YWwgY2hhbmdlIG1hZGUgdG8gdGhlIHBhdGNoIGZpbGU/IFRyeSByZWNyZWF0aW5nIGl0IGJ5IG1hbnVhbGx5XG4gIGVkaXRpbmcgdGhlIGFwcHJvcHJpYXRlIGZpbGVzIGFuZCBydW5uaW5nOlxuICBcbiAgICBwYXRjaC1wYWNrYWdlICR7cGF0aFNwZWNpZmllcn1cbiAgXG4gIElmIHRoYXQgZG9lc24ndCB3b3JrLCB0aGVuIGl0J3MgYSBidWcgaW4gcGF0Y2gtcGFja2FnZSwgc28gcGxlYXNlIHN1Ym1pdCBhIGJ1Z1xuICByZXBvcnQuIFRoYW5rcyFcblxuICAgIGh0dHBzOi8vZ2l0aHViLmNvbS9kczMwMC9wYXRjaC1wYWNrYWdlL2lzc3Vlc1xuICAgIFxuYFxufVxuXG5mdW5jdGlvbiBjcmVhdGVQYXRjaEFwcGxpY2F0aW9uRmFpbHVyZUVycm9yKHtcbiAgcGFja2FnZU5hbWUsXG4gIGFjdHVhbFZlcnNpb24sXG4gIG9yaWdpbmFsVmVyc2lvbixcbiAgcGF0Y2hGaWxlbmFtZSxcbiAgcGF0aCxcbiAgcGF0aFNwZWNpZmllcixcbn06IHtcbiAgcGFja2FnZU5hbWU6IHN0cmluZ1xuICBhY3R1YWxWZXJzaW9uOiBzdHJpbmdcbiAgb3JpZ2luYWxWZXJzaW9uOiBzdHJpbmdcbiAgcGF0Y2hGaWxlbmFtZTogc3RyaW5nXG4gIHBhdGg6IHN0cmluZ1xuICBwYXRoU3BlY2lmaWVyOiBzdHJpbmdcbn0pIHtcbiAgcmV0dXJuIGBcbiR7Y2hhbGsucmVkLmJvbGQoXCIqKkVSUk9SKipcIil9ICR7Y2hhbGsucmVkKFxuICAgIGBGYWlsZWQgdG8gYXBwbHkgcGF0Y2ggZm9yIHBhY2thZ2UgJHtjaGFsay5ib2xkKHBhY2thZ2VOYW1lKX0gYXQgcGF0aGAsXG4gICl9XG4gIFxuICAgICR7cGF0aH1cblxuICBUaGlzIGVycm9yIHdhcyBjYXVzZWQgYmVjYXVzZSAke2NoYWxrLmJvbGQocGFja2FnZU5hbWUpfSBoYXMgY2hhbmdlZCBzaW5jZSB5b3VcbiAgbWFkZSB0aGUgcGF0Y2ggZmlsZSBmb3IgaXQuIFRoaXMgaW50cm9kdWNlZCBjb25mbGljdHMgd2l0aCB5b3VyIHBhdGNoLFxuICBqdXN0IGxpa2UgYSBtZXJnZSBjb25mbGljdCBpbiBHaXQgd2hlbiBzZXBhcmF0ZSBpbmNvbXBhdGlibGUgY2hhbmdlcyBhcmVcbiAgbWFkZSB0byB0aGUgc2FtZSBwaWVjZSBvZiBjb2RlLlxuXG4gIE1heWJlIHRoaXMgbWVhbnMgeW91ciBwYXRjaCBmaWxlIGlzIG5vIGxvbmdlciBuZWNlc3NhcnksIGluIHdoaWNoIGNhc2VcbiAgaG9vcmF5ISBKdXN0IGRlbGV0ZSBpdCFcblxuICBPdGhlcndpc2UsIHlvdSBuZWVkIHRvIGdlbmVyYXRlIGEgbmV3IHBhdGNoIGZpbGUuXG5cbiAgVG8gZ2VuZXJhdGUgYSBuZXcgb25lLCBqdXN0IHJlcGVhdCB0aGUgc3RlcHMgeW91IG1hZGUgdG8gZ2VuZXJhdGUgdGhlIGZpcnN0XG4gIG9uZS5cblxuICBpLmUuIG1hbnVhbGx5IG1ha2UgdGhlIGFwcHJvcHJpYXRlIGZpbGUgY2hhbmdlcywgdGhlbiBydW4gXG5cbiAgICBwYXRjaC1wYWNrYWdlICR7cGF0aFNwZWNpZmllcn1cblxuICBJbmZvOlxuICAgIFBhdGNoIGZpbGU6IHBhdGNoZXMvJHtwYXRjaEZpbGVuYW1lfVxuICAgIFBhdGNoIHdhcyBtYWRlIGZvciB2ZXJzaW9uOiAke2NoYWxrLmdyZWVuLmJvbGQob3JpZ2luYWxWZXJzaW9uKX1cbiAgICBJbnN0YWxsZWQgdmVyc2lvbjogJHtjaGFsay5yZWQuYm9sZChhY3R1YWxWZXJzaW9uKX1cbmBcbn1cblxuZnVuY3Rpb24gY3JlYXRlVW5leHBlY3RlZEVycm9yKHtcbiAgZmlsZW5hbWUsXG4gIGVycm9yLFxufToge1xuICBmaWxlbmFtZTogc3RyaW5nXG4gIGVycm9yOiBFcnJvclxufSkge1xuICByZXR1cm4gYFxuJHtjaGFsay5yZWQuYm9sZChcIioqRVJST1IqKlwiKX0gJHtjaGFsay5yZWQoXG4gICAgYEZhaWxlZCB0byBhcHBseSBwYXRjaCBmaWxlICR7Y2hhbGsuYm9sZChmaWxlbmFtZSl9YCxcbiAgKX1cbiAgXG4ke2Vycm9yLnN0YWNrfVxuXG4gIGBcbn1cbiJdfQ==