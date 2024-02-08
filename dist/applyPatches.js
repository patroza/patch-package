import chalk from "chalk";
import { writeFileSync } from "fs";
import { existsSync } from "fs-extra";
import { posix } from "path";
import semver from "semver";
import { hashFile } from "./hash";
import { logPatchSequenceError } from "./makePatch";
import { packageIsDevDependency } from "./packageIsDevDependency";
import { executeEffects } from "./patch/apply";
import { readPatch } from "./patch/read";
import { reversePatch } from "./patch/reverse";
import { getGroupedPatches } from "./patchFs";
import { join, relative } from "./path";
import { clearPatchApplicationState, getPatchApplicationState, savePatchApplicationState, } from "./stateFile";
class PatchApplicationError extends Error {
    constructor(msg) {
        super(msg);
    }
}
function getInstalledPackageVersion({ appPath, path, pathSpecifier, isDevOnly, patchFilename, }) {
    const packageDir = join(appPath, path);
    if (!existsSync(packageDir)) {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBwbHlQYXRjaGVzLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL2FwcGx5UGF0Y2hlcy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEtBQUssTUFBTSxPQUFPLENBQUE7QUFDekIsT0FBTyxFQUFFLGFBQWEsRUFBRSxNQUFNLElBQUksQ0FBQTtBQUNsQyxPQUFPLEVBQUUsVUFBVSxFQUFFLE1BQU0sVUFBVSxDQUFBO0FBQ3JDLE9BQU8sRUFBRSxLQUFLLEVBQUUsTUFBTSxNQUFNLENBQUE7QUFDNUIsT0FBTyxNQUFNLE1BQU0sUUFBUSxDQUFBO0FBQzNCLE9BQU8sRUFBRSxRQUFRLEVBQUUsTUFBTSxRQUFRLENBQUE7QUFDakMsT0FBTyxFQUFFLHFCQUFxQixFQUFFLE1BQU0sYUFBYSxDQUFBO0FBRW5ELE9BQU8sRUFBRSxzQkFBc0IsRUFBRSxNQUFNLDBCQUEwQixDQUFBO0FBQ2pFLE9BQU8sRUFBRSxjQUFjLEVBQUUsTUFBTSxlQUFlLENBQUE7QUFDOUMsT0FBTyxFQUFFLFNBQVMsRUFBRSxNQUFNLGNBQWMsQ0FBQTtBQUN4QyxPQUFPLEVBQUUsWUFBWSxFQUFFLE1BQU0saUJBQWlCLENBQUE7QUFDOUMsT0FBTyxFQUFFLGlCQUFpQixFQUFFLE1BQU0sV0FBVyxDQUFBO0FBQzdDLE9BQU8sRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLE1BQU0sUUFBUSxDQUFBO0FBQ3ZDLE9BQU8sRUFDTCwwQkFBMEIsRUFDMUIsd0JBQXdCLEVBRXhCLHlCQUF5QixHQUMxQixNQUFNLGFBQWEsQ0FBQTtBQUVwQixNQUFNLHFCQUFzQixTQUFRLEtBQUs7SUFDdkMsWUFBWSxHQUFXO1FBQ3JCLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQTtJQUNaLENBQUM7Q0FDRjtBQUVELFNBQVMsMEJBQTBCLENBQUMsRUFDbEMsT0FBTyxFQUNQLElBQUksRUFDSixhQUFhLEVBQ2IsU0FBUyxFQUNULGFBQWEsR0FPZDtJQUNDLE1BQU0sVUFBVSxH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OEJBQThCLEtBQUssQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FDckQ7O0VBRUQsS0FBSyxDQUFDLEtBQUs7O0dBRVYsQ0FBQTtBQUNILENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgY2hhbGsgZnJvbSBcImNoYWxrXCJcbmltcG9ydCB7IHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwiZnNcIlxuaW1wb3J0IHsgZXhpc3RzU3luYyB9IGZyb20gXCJmcy1leHRyYVwiXG5pbXBvcnQgeyBwb3NpeCB9IGZyb20gXCJwYXRoXCJcbmltcG9ydCBzZW12ZXIgZnJvbSBcInNlbXZlclwiXG5pbXBvcnQgeyBoYXNoRmlsZSB9IGZyb20gXCIuL2hhc2hcIlxuaW1wb3J0IHsgbG9nUGF0Y2hTZXF1ZW5jZUVycm9yIH0gZnJvbSBcIi4vbWFrZVBhdGNoXCJcbmltcG9ydCB7IFBhY2thZ2VEZXRhaWxzLCBQYXRjaGVkUGFja2FnZURldGFpbHMgfSBmcm9tIFwiLi9QYWNrYWdlRGV0YWlsc1wiXG5pbXBvcnQgeyBwYWNrYWdlSXNEZXZEZXBlbmRlbmN5IH0gZnJvbSBcIi4vcGFja2FnZUlzRGV2RGVwZW5kZW5jeVwiXG5pbXBvcnQgeyBleGVjdXRlRWZmZWN0cyB9IGZyb20gXCIuL3BhdGNoL2FwcGx5XCJcbmltcG9ydCB7IHJlYWRQYXRjaCB9IGZyb20gXCIuL3BhdGNoL3JlYWRcIlxuaW1wb3J0IHsgcmV2ZXJzZVBhdGNoIH0gZnJvbSBcIi4vcGF0Y2gvcmV2ZXJzZVwiXG5pbXBvcnQgeyBnZXRHcm91cGVkUGF0Y2hlcyB9IGZyb20gXCIuL3BhdGNoRnNcIlxuaW1wb3J0IHsgam9pbiwgcmVsYXRpdmUgfSBmcm9tIFwiLi9wYXRoXCJcbmltcG9ydCB7XG4gIGNsZWFyUGF0Y2hBcHBsaWNhdGlvblN0YXRlLFxuICBnZXRQYXRjaEFwcGxpY2F0aW9uU3RhdGUsXG4gIFBhdGNoU3RhdGUsXG4gIHNhdmVQYXRjaEFwcGxpY2F0aW9uU3RhdGUsXG59IGZyb20gXCIuL3N0YXRlRmlsZVwiXG5cbmNsYXNzIFBhdGNoQXBwbGljYXRpb25FcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IobXNnOiBzdHJpbmcpIHtcbiAgICBzdXBlcihtc2cpXG4gIH1cbn1cblxuZnVuY3Rpb24gZ2V0SW5zdGFsbGVkUGFja2FnZVZlcnNpb24oe1xuICBhcHBQYXRoLFxuICBwYXRoLFxuICBwYXRoU3BlY2lmaWVyLFxuICBpc0Rldk9ubHksXG4gIHBhdGNoRmlsZW5hbWUsXG59OiB7XG4gIGFwcFBhdGg6IHN0cmluZ1xuICBwYXRoOiBzdHJpbmdcbiAgcGF0aFNwZWNpZmllcjogc3RyaW5nXG4gIGlzRGV2T25seTogYm9vbGVhblxuICBwYXRjaEZpbGVuYW1lOiBzdHJpbmdcbn0pOiBudWxsIHwgc3RyaW5nIHtcbiAgY29uc3QgcGFja2FnZURpciA9IGpvaW4oYXBwUGF0aCwgcGF0aClcbiAgaWYgKCFleGlzdHNTeW5jKHBhY2thZ2VEaXIpKSB7XG4gICAgaWYgKHByb2Nlc3MuZW52Lk5PREVfRU5WID09PSBcInByb2R1Y3Rpb25cIiAmJiBpc0Rldk9ubHkpIHtcbiAgICAgIHJldHVybiBudWxsXG4gICAgfVxuXG4gICAgbGV0IGVyciA9XG4gICAgICBgJHtjaGFsay5yZWQoXCJFcnJvcjpcIil9IFBhdGNoIGZpbGUgZm91bmQgZm9yIHBhY2thZ2UgJHtwb3NpeC5iYXNlbmFtZShcbiAgICAgICAgcGF0aFNwZWNpZmllcixcbiAgICAgICl9YCArIGAgd2hpY2ggaXMgbm90IHByZXNlbnQgYXQgJHtyZWxhdGl2ZShcIi5cIiwgcGFja2FnZURpcil9YFxuXG4gICAgaWYgKCFpc0Rldk9ubHkgJiYgcHJvY2Vzcy5lbnYuTk9ERV9FTlYgPT09IFwicHJvZHVjdGlvblwiKSB7XG4gICAgICBlcnIgKz0gYFxuXG4gIElmIHRoaXMgcGFja2FnZSBpcyBhIGRldiBkZXBlbmRlbmN5LCByZW5hbWUgdGhlIHBhdGNoIGZpbGUgdG9cbiAgXG4gICAgJHtjaGFsay5ib2xkKHBhdGNoRmlsZW5hbWUucmVwbGFjZShcIi5wYXRjaFwiLCBcIi5kZXYucGF0Y2hcIikpfVxuYFxuICAgIH1cbiAgICB0aHJvdyBuZXcgUGF0Y2hBcHBsaWNhdGlvbkVycm9yKGVycilcbiAgfVxuXG4gIGNvbnN0IHsgdmVyc2lvbiB9ID0gcmVxdWlyZShqb2luKHBhY2thZ2VEaXIsIFwicGFja2FnZS5qc29uXCIpKVxuICAvLyBub3JtYWxpemUgdmVyc2lvbiBmb3IgYG5wbSBjaWBcbiAgY29uc3QgcmVzdWx0ID0gc2VtdmVyLnZhbGlkKHZlcnNpb24pXG4gIGlmIChyZXN1bHQgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgUGF0Y2hBcHBsaWNhdGlvbkVycm9yKFxuICAgICAgYCR7Y2hhbGsucmVkKFxuICAgICAgICBcIkVycm9yOlwiLFxuICAgICAgKX0gVmVyc2lvbiBzdHJpbmcgJyR7dmVyc2lvbn0nIGNhbm5vdCBiZSBwYXJzZWQgZnJvbSAke2pvaW4oXG4gICAgICAgIHBhY2thZ2VEaXIsXG4gICAgICAgIFwicGFja2FnZS5qc29uXCIsXG4gICAgICApfWAsXG4gICAgKVxuICB9XG5cbiAgcmV0dXJuIHJlc3VsdCBhcyBzdHJpbmdcbn1cblxuZnVuY3Rpb24gbG9nUGF0Y2hBcHBsaWNhdGlvbihwYXRjaERldGFpbHM6IFBhdGNoZWRQYWNrYWdlRGV0YWlscykge1xuICBjb25zdCBzZXF1ZW5jZVN0cmluZyA9XG4gICAgcGF0Y2hEZXRhaWxzLnNlcXVlbmNlTnVtYmVyICE9IG51bGxcbiAgICAgID8gYCAoJHtwYXRjaERldGFpbHMuc2VxdWVuY2VOdW1iZXJ9JHtcbiAgICAgICAgICBwYXRjaERldGFpbHMuc2VxdWVuY2VOYW1lID8gXCIgXCIgKyBwYXRjaERldGFpbHMuc2VxdWVuY2VOYW1lIDogXCJcIlxuICAgICAgICB9KWBcbiAgICAgIDogXCJcIlxuICBjb25zb2xlLmxvZyhcbiAgICBgJHtjaGFsay5ib2xkKHBhdGNoRGV0YWlscy5wYXRoU3BlY2lmaWVyKX1AJHtcbiAgICAgIHBhdGNoRGV0YWlscy52ZXJzaW9uXG4gICAgfSR7c2VxdWVuY2VTdHJpbmd9ICR7Y2hhbGsuZ3JlZW4oXCLinJRcIil9YCxcbiAgKVxufVxuXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlQYXRjaGVzRm9yQXBwKHtcbiAgYXBwUGF0aCxcbiAgcmV2ZXJzZSxcbiAgcGF0Y2hEaXIsXG4gIHNob3VsZEV4aXRXaXRoRXJyb3IsXG4gIHNob3VsZEV4aXRXaXRoV2FybmluZyxcbiAgYmVzdEVmZm9ydCxcbn06IHtcbiAgYXBwUGF0aDogc3RyaW5nXG4gIHJldmVyc2U6IGJvb2xlYW5cbiAgcGF0Y2hEaXI6IHN0cmluZ1xuICBzaG91bGRFeGl0V2l0aEVycm9yOiBib29sZWFuXG4gIHNob3VsZEV4aXRXaXRoV2FybmluZzogYm9vbGVhblxuICBiZXN0RWZmb3J0OiBib29sZWFuXG59KTogdm9pZCB7XG4gIGNvbnN0IHBhdGNoZXNEaXJlY3RvcnkgPSBqb2luKGFwcFBhdGgsIHBhdGNoRGlyKVxuICBjb25zdCBncm91cGVkUGF0Y2hlcyA9IGdldEdyb3VwZWRQYXRjaGVzKHBhdGNoZXNEaXJlY3RvcnkpXG5cbiAgaWYgKGdyb3VwZWRQYXRjaGVzLm51bVBhdGNoRmlsZXMgPT09IDApIHtcbiAgICBjb25zb2xlLmxvZyhjaGFsay5ibHVlQnJpZ2h0KFwiTm8gcGF0Y2ggZmlsZXMgZm91bmRcIikpXG4gICAgcmV0dXJuXG4gIH1cblxuICBjb25zdCBlcnJvcnM6IHN0cmluZ1tdID0gW11cbiAgY29uc3Qgd2FybmluZ3M6IHN0cmluZ1tdID0gWy4uLmdyb3VwZWRQYXRjaGVzLndhcm5pbmdzXVxuXG4gIGZvciAoY29uc3QgcGF0Y2hlcyBvZiBPYmplY3QudmFsdWVzKFxuICAgIGdyb3VwZWRQYXRjaGVzLnBhdGhTcGVjaWZpZXJUb1BhdGNoRmlsZXMsXG4gICkpIHtcbiAgICBhcHBseVBhdGNoZXNGb3JQYWNrYWdlKHtcbiAgICAgIHBhdGNoZXMsXG4gICAgICBhcHBQYXRoLFxuICAgICAgcGF0Y2hEaXIsXG4gICAgICByZXZlcnNlLFxuICAgICAgd2FybmluZ3MsXG4gICAgICBlcnJvcnMsXG4gICAgICBiZXN0RWZmb3J0LFxuICAgIH0pXG4gIH1cblxuICBmb3IgKGNvbnN0IHdhcm5pbmcgb2Ygd2FybmluZ3MpIHtcbiAgICBjb25zb2xlLmxvZyh3YXJuaW5nKVxuICB9XG4gIGZvciAoY29uc3QgZXJyb3Igb2YgZXJyb3JzKSB7XG4gICAgY29uc29sZS5sb2coZXJyb3IpXG4gIH1cblxuICBjb25zdCBwcm9ibGVtc1N1bW1hcnkgPSBbXVxuICBpZiAod2FybmluZ3MubGVuZ3RoKSB7XG4gICAgcHJvYmxlbXNTdW1tYXJ5LnB1c2goY2hhbGsueWVsbG93KGAke3dhcm5pbmdzLmxlbmd0aH0gd2FybmluZyhzKWApKVxuICB9XG4gIGlmIChlcnJvcnMubGVuZ3RoKSB7XG4gICAgcHJvYmxlbXNTdW1tYXJ5LnB1c2goY2hhbGsucmVkKGAke2Vycm9ycy5sZW5ndGh9IGVycm9yKHMpYCkpXG4gIH1cblxuICBpZiAocHJvYmxlbXNTdW1tYXJ5Lmxlbmd0aCkge1xuICAgIGNvbnNvbGUubG9nKFwiLS0tXCIpXG4gICAgY29uc29sZS5sb2coXCJwYXRjaC1wYWNrYWdlIGZpbmlzaGVkIHdpdGhcIiwgcHJvYmxlbXNTdW1tYXJ5LmpvaW4oXCIsIFwiKSArIFwiLlwiKVxuICB9XG5cbiAgaWYgKGVycm9ycy5sZW5ndGggJiYgc2hvdWxkRXhpdFdpdGhFcnJvcikge1xuICAgIHByb2Nlc3MuZXhpdCgxKVxuICB9XG5cbiAgaWYgKHdhcm5pbmdzLmxlbmd0aCAmJiBzaG91bGRFeGl0V2l0aFdhcm5pbmcpIHtcbiAgICBwcm9jZXNzLmV4aXQoMSlcbiAgfVxuXG4gIHByb2Nlc3MuZXhpdCgwKVxufVxuXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlQYXRjaGVzRm9yUGFja2FnZSh7XG4gIHBhdGNoZXMsXG4gIGFwcFBhdGgsXG4gIHBhdGNoRGlyLFxuICByZXZlcnNlLFxuICB3YXJuaW5ncyxcbiAgZXJyb3JzLFxuICBiZXN0RWZmb3J0LFxufToge1xuICBwYXRjaGVzOiBQYXRjaGVkUGFja2FnZURldGFpbHNbXVxuICBhcHBQYXRoOiBzdHJpbmdcbiAgcGF0Y2hEaXI6IHN0cmluZ1xuICByZXZlcnNlOiBib29sZWFuXG4gIHdhcm5pbmdzOiBzdHJpbmdbXVxuICBlcnJvcnM6IHN0cmluZ1tdXG4gIGJlc3RFZmZvcnQ6IGJvb2xlYW5cbn0pIHtcbiAgY29uc3QgcGF0aFNwZWNpZmllciA9IHBhdGNoZXNbMF0ucGF0aFNwZWNpZmllclxuICBjb25zdCBzdGF0ZSA9IHBhdGNoZXMubGVuZ3RoID4gMSA/IGdldFBhdGNoQXBwbGljYXRpb25TdGF0ZShwYXRjaGVzWzBdKSA6IG51bGxcbiAgY29uc3QgdW5hcHBsaWVkUGF0Y2hlcyA9IHBhdGNoZXMuc2xpY2UoMClcbiAgY29uc3QgYXBwbGllZFBhdGNoZXM6IFBhdGNoZWRQYWNrYWdlRGV0YWlsc1tdID0gW11cbiAgLy8gaWYgdGhlcmUgYXJlIG11bHRpcGxlIHBhdGNoZXMgdG8gYXBwbHksIHdlIGNhbid0IHJlbHkgb24gdGhlIHJldmVyc2UtcGF0Y2gtZHJ5LXJ1biBiZWhhdmlvciB0byBtYWtlIHRoaXMgb3BlcmF0aW9uXG4gIC8vIGlkZW1wb3RlbnQsIHNvIGluc3RlYWQgd2UgbmVlZCB0byBjaGVjayB0aGUgc3RhdGUgZmlsZSB0byBzZWUgd2hldGhlciB3ZSBoYXZlIGFscmVhZHkgYXBwbGllZCBhbnkgb2YgdGhlIHBhdGNoZXNcbiAgLy8gdG9kbzogb25jZSB0aGlzIGlzIGJhdHRsZSB0ZXN0ZWQgd2UgbWlnaHQgd2FudCB0byB1c2UgdGhlIHNhbWUgYXBwcm9hY2ggZm9yIHNpbmdsZSBwYXRjaGVzIGFzIHdlbGwsIGJ1dCBpdCdzIG5vdCBiaWdnaWUgc2luY2UgdGhlIGRyeSBydW4gdGhpbmcgaXMgZmFzdFxuICBpZiAodW5hcHBsaWVkUGF0Y2hlcyAmJiBzdGF0ZSkge1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgc3RhdGUucGF0Y2hlcy5sZW5ndGg7IGkrKykge1xuICAgICAgY29uc3QgcGF0Y2hUaGF0V2FzQXBwbGllZCA9IHN0YXRlLnBhdGNoZXNbaV1cbiAgICAgIGlmICghcGF0Y2hUaGF0V2FzQXBwbGllZC5kaWRBcHBseSkge1xuICAgICAgICBicmVha1xuICAgICAgfVxuICAgICAgY29uc3QgcGF0Y2hUb0FwcGx5ID0gdW5hcHBsaWVkUGF0Y2hlc1swXVxuICAgICAgY29uc3QgY3VycmVudFBhdGNoSGFzaCA9IGhhc2hGaWxlKFxuICAgICAgICBqb2luKGFwcFBhdGgsIHBhdGNoRGlyLCBwYXRjaFRvQXBwbHkucGF0Y2hGaWxlbmFtZSksXG4gICAgICApXG4gICAgICBpZiAocGF0Y2hUaGF0V2FzQXBwbGllZC5wYXRjaENvbnRlbnRIYXNoID09PSBjdXJyZW50UGF0Y2hIYXNoKSB7XG4gICAgICAgIC8vIHRoaXMgcGF0Y2ggd2FzIGFwcGxpZWQgd2UgY2FuIHNraXAgaXRcbiAgICAgICAgYXBwbGllZFBhdGNoZXMucHVzaCh1bmFwcGxpZWRQYXRjaGVzLnNoaWZ0KCkhKVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc29sZS5sb2coXG4gICAgICAgICAgY2hhbGsucmVkKFwiRXJyb3I6XCIpLFxuICAgICAgICAgIGBUaGUgcGF0Y2hlcyBmb3IgJHtjaGFsay5ib2xkKHBhdGhTcGVjaWZpZXIpfSBoYXZlIGNoYW5nZWQuYCxcbiAgICAgICAgICBgWW91IHNob3VsZCByZWluc3RhbGwgeW91ciBub2RlX21vZHVsZXMgZm9sZGVyIHRvIG1ha2Ugc3VyZSB0aGUgcGFja2FnZSBpcyB1cCB0byBkYXRlYCxcbiAgICAgICAgKVxuICAgICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBpZiAocmV2ZXJzZSAmJiBzdGF0ZSkge1xuICAgIC8vIGlmIHdlIGFyZSByZXZlcnNpbmcgdGhlIHBhdGNoZXMgd2UgbmVlZCB0byBtYWtlIHRoZSB1bmFwcGxpZWRQYXRjaGVzIGFycmF5XG4gICAgLy8gYmUgdGhlIHJldmVyc2VkIHZlcnNpb24gb2YgdGhlIGFwcGxpZWRQYXRjaGVzIGFycmF5LlxuICAgIC8vIFRoZSBhcHBsaWVkIHBhdGNoZXMgYXJyYXkgc2hvdWxkIHRoZW4gYmUgZW1wdHkgYmVjYXVzZSBpdCBpcyB1c2VkIGRpZmZlcmVudGx5XG4gICAgLy8gd2hlbiBvdXRwdXR0aW5nIHRoZSBzdGF0ZSBmaWxlLlxuICAgIHVuYXBwbGllZFBhdGNoZXMubGVuZ3RoID0gMFxuICAgIHVuYXBwbGllZFBhdGNoZXMucHVzaCguLi5hcHBsaWVkUGF0Y2hlcylcbiAgICB1bmFwcGxpZWRQYXRjaGVzLnJldmVyc2UoKVxuICAgIGFwcGxpZWRQYXRjaGVzLmxlbmd0aCA9IDBcbiAgfVxuICBpZiAoYXBwbGllZFBhdGNoZXMubGVuZ3RoKSB7XG4gICAgLy8gc29tZSBwYXRjaGVzIGhhdmUgYWxyZWFkeSBiZWVuIGFwcGxpZWRcbiAgICBhcHBsaWVkUGF0Y2hlcy5mb3JFYWNoKGxvZ1BhdGNoQXBwbGljYXRpb24pXG4gIH1cbiAgaWYgKCF1bmFwcGxpZWRQYXRjaGVzLmxlbmd0aCkge1xuICAgIHJldHVyblxuICB9XG4gIGxldCBmYWlsZWRQYXRjaDogUGF0Y2hlZFBhY2thZ2VEZXRhaWxzIHwgbnVsbCA9IG51bGxcbiAgcGFja2FnZUxvb3A6IGZvciAoY29uc3QgcGF0Y2hEZXRhaWxzIG9mIHVuYXBwbGllZFBhdGNoZXMpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgeyBuYW1lLCB2ZXJzaW9uLCBwYXRoLCBpc0Rldk9ubHksIHBhdGNoRmlsZW5hbWUgfSA9IHBhdGNoRGV0YWlsc1xuXG4gICAgICBjb25zdCBpbnN0YWxsZWRQYWNrYWdlVmVyc2lvbiA9IGdldEluc3RhbGxlZFBhY2thZ2VWZXJzaW9uKHtcbiAgICAgICAgYXBwUGF0aCxcbiAgICAgICAgcGF0aCxcbiAgICAgICAgcGF0aFNwZWNpZmllcixcbiAgICAgICAgaXNEZXZPbmx5OlxuICAgICAgICAgIGlzRGV2T25seSB8fFxuICAgICAgICAgIC8vIGNoZWNrIGZvciBkaXJlY3QtZGVwZW5kZW50cyBpbiBwcm9kXG4gICAgICAgICAgKHByb2Nlc3MuZW52Lk5PREVfRU5WID09PSBcInByb2R1Y3Rpb25cIiAmJlxuICAgICAgICAgICAgcGFja2FnZUlzRGV2RGVwZW5kZW5jeSh7XG4gICAgICAgICAgICAgIGFwcFBhdGgsXG4gICAgICAgICAgICAgIHBhdGNoRGV0YWlscyxcbiAgICAgICAgICAgIH0pKSxcbiAgICAgICAgcGF0Y2hGaWxlbmFtZSxcbiAgICAgIH0pXG4gICAgICBpZiAoIWluc3RhbGxlZFBhY2thZ2VWZXJzaW9uKSB7XG4gICAgICAgIC8vIGl0J3Mgb2sgd2UncmUgaW4gcHJvZHVjdGlvbiBtb2RlIGFuZCB0aGlzIGlzIGEgZGV2IG9ubHkgcGFja2FnZVxuICAgICAgICBjb25zb2xlLmxvZyhcbiAgICAgICAgICBgU2tpcHBpbmcgZGV2LW9ubHkgJHtjaGFsay5ib2xkKFxuICAgICAgICAgICAgcGF0aFNwZWNpZmllcixcbiAgICAgICAgICApfUAke3ZlcnNpb259ICR7Y2hhbGsuYmx1ZShcIuKclFwiKX1gLFxuICAgICAgICApXG4gICAgICAgIGNvbnRpbnVlXG4gICAgICB9XG5cbiAgICAgIGlmIChcbiAgICAgICAgYXBwbHlQYXRjaCh7XG4gICAgICAgICAgcGF0Y2hGaWxlUGF0aDogam9pbihhcHBQYXRoLCBwYXRjaERpciwgcGF0Y2hGaWxlbmFtZSkgYXMgc3RyaW5nLFxuICAgICAgICAgIHJldmVyc2UsXG4gICAgICAgICAgcGF0Y2hEZXRhaWxzLFxuICAgICAgICAgIHBhdGNoRGlyLFxuICAgICAgICAgIGN3ZDogcHJvY2Vzcy5jd2QoKSxcbiAgICAgICAgICBiZXN0RWZmb3J0LFxuICAgICAgICB9KVxuICAgICAgKSB7XG4gICAgICAgIGFwcGxpZWRQYXRjaGVzLnB1c2gocGF0Y2hEZXRhaWxzKVxuICAgICAgICAvLyB5YXkgcGF0Y2ggd2FzIGFwcGxpZWQgc3VjY2Vzc2Z1bGx5XG4gICAgICAgIC8vIHByaW50IHdhcm5pbmcgaWYgdmVyc2lvbiBtaXNtYXRjaFxuICAgICAgICBpZiAoaW5zdGFsbGVkUGFja2FnZVZlcnNpb24gIT09IHZlcnNpb24pIHtcbiAgICAgICAgICB3YXJuaW5ncy5wdXNoKFxuICAgICAgICAgICAgY3JlYXRlVmVyc2lvbk1pc21hdGNoV2FybmluZyh7XG4gICAgICAgICAgICAgIHBhY2thZ2VOYW1lOiBuYW1lLFxuICAgICAgICAgICAgICBhY3R1YWxWZXJzaW9uOiBpbnN0YWxsZWRQYWNrYWdlVmVyc2lvbixcbiAgICAgICAgICAgICAgb3JpZ2luYWxWZXJzaW9uOiB2ZXJzaW9uLFxuICAgICAgICAgICAgICBwYXRoU3BlY2lmaWVyLFxuICAgICAgICAgICAgICBwYXRoLFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgKVxuICAgICAgICB9XG4gICAgICAgIGxvZ1BhdGNoQXBwbGljYXRpb24ocGF0Y2hEZXRhaWxzKVxuICAgICAgfSBlbHNlIGlmIChwYXRjaGVzLmxlbmd0aCA+IDEpIHtcbiAgICAgICAgbG9nUGF0Y2hTZXF1ZW5jZUVycm9yKHsgcGF0Y2hEZXRhaWxzIH0pXG4gICAgICAgIC8vIGluIGNhc2UgdGhlIHBhY2thZ2UgaGFzIG11bHRpcGxlIHBhdGNoZXMsIHdlIG5lZWQgdG8gYnJlYWsgb3V0IG9mIHRoaXMgaW5uZXIgbG9vcFxuICAgICAgICAvLyBiZWNhdXNlIHdlIGRvbid0IHdhbnQgdG8gYXBwbHkgbW9yZSBwYXRjaGVzIG9uIHRvcCBvZiB0aGUgYnJva2VuIHN0YXRlXG4gICAgICAgIGZhaWxlZFBhdGNoID0gcGF0Y2hEZXRhaWxzXG4gICAgICAgIGJyZWFrIHBhY2thZ2VMb29wXG4gICAgICB9IGVsc2UgaWYgKGluc3RhbGxlZFBhY2thZ2VWZXJzaW9uID09PSB2ZXJzaW9uKSB7XG4gICAgICAgIC8vIGNvbXBsZXRlbHkgZmFpbGVkIHRvIGFwcGx5IHBhdGNoXG4gICAgICAgIC8vIFRPRE86IHByb3BhZ2F0ZSB1c2VmdWwgZXJyb3IgbWVzc2FnZXMgZnJvbSBwYXRjaCBhcHBsaWNhdGlvblxuICAgICAgICBlcnJvcnMucHVzaChcbiAgICAgICAgICBjcmVhdGVCcm9rZW5QYXRjaEZpbGVFcnJvcih7XG4gICAgICAgICAgICBwYWNrYWdlTmFtZTogbmFtZSxcbiAgICAgICAgICAgIHBhdGNoRmlsZW5hbWUsXG4gICAgICAgICAgICBwYXRoU3BlY2lmaWVyLFxuICAgICAgICAgICAgcGF0aCxcbiAgICAgICAgICB9KSxcbiAgICAgICAgKVxuICAgICAgICBicmVhayBwYWNrYWdlTG9vcFxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgZXJyb3JzLnB1c2goXG4gICAgICAgICAgY3JlYXRlUGF0Y2hBcHBsaWNhdGlvbkZhaWx1cmVFcnJvcih7XG4gICAgICAgICAgICBwYWNrYWdlTmFtZTogbmFtZSxcbiAgICAgICAgICAgIGFjdHVhbFZlcnNpb246IGluc3RhbGxlZFBhY2thZ2VWZXJzaW9uLFxuICAgICAgICAgICAgb3JpZ2luYWxWZXJzaW9uOiB2ZXJzaW9uLFxuICAgICAgICAgICAgcGF0Y2hGaWxlbmFtZSxcbiAgICAgICAgICAgIHBhdGgsXG4gICAgICAgICAgICBwYXRoU3BlY2lmaWVyLFxuICAgICAgICAgIH0pLFxuICAgICAgICApXG4gICAgICAgIC8vIGluIGNhc2UgdGhlIHBhY2thZ2UgaGFzIG11bHRpcGxlIHBhdGNoZXMsIHdlIG5lZWQgdG8gYnJlYWsgb3V0IG9mIHRoaXMgaW5uZXIgbG9vcFxuICAgICAgICAvLyBiZWNhdXNlIHdlIGRvbid0IHdhbnQgdG8gYXBwbHkgbW9yZSBwYXRjaGVzIG9uIHRvcCBvZiB0aGUgYnJva2VuIHN0YXRlXG4gICAgICAgIGJyZWFrIHBhY2thZ2VMb29wXG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIFBhdGNoQXBwbGljYXRpb25FcnJvcikge1xuICAgICAgICBlcnJvcnMucHVzaChlcnJvci5tZXNzYWdlKVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgZXJyb3JzLnB1c2goXG4gICAgICAgICAgY3JlYXRlVW5leHBlY3RlZEVycm9yKHtcbiAgICAgICAgICAgIGZpbGVuYW1lOiBwYXRjaERldGFpbHMucGF0Y2hGaWxlbmFtZSxcbiAgICAgICAgICAgIGVycm9yOiBlcnJvciBhcyBFcnJvcixcbiAgICAgICAgICB9KSxcbiAgICAgICAgKVxuICAgICAgfVxuICAgICAgLy8gaW4gY2FzZSB0aGUgcGFja2FnZSBoYXMgbXVsdGlwbGUgcGF0Y2hlcywgd2UgbmVlZCB0byBicmVhayBvdXQgb2YgdGhpcyBpbm5lciBsb29wXG4gICAgICAvLyBiZWNhdXNlIHdlIGRvbid0IHdhbnQgdG8gYXBwbHkgbW9yZSBwYXRjaGVzIG9uIHRvcCBvZiB0aGUgYnJva2VuIHN0YXRlXG4gICAgICBicmVhayBwYWNrYWdlTG9vcFxuICAgIH1cbiAgfVxuXG4gIGlmIChwYXRjaGVzLmxlbmd0aCA+IDEpIHtcbiAgICBpZiAocmV2ZXJzZSkge1xuICAgICAgaWYgKCFzdGF0ZSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJ1bmV4cGVjdGVkIHN0YXRlOiBubyBzdGF0ZSBmaWxlIGZvdW5kIHdoaWxlIHJldmVyc2luZ1wiKVxuICAgICAgfVxuICAgICAgLy8gaWYgd2UgcmVtb3ZlZCBhbGwgdGhlIHBhdGNoZXMgdGhhdCB3ZXJlIHByZXZpb3VzbHkgYXBwbGllZCB3ZSBjYW4gZGVsZXRlIHRoZSBzdGF0ZSBmaWxlXG4gICAgICBpZiAoYXBwbGllZFBhdGNoZXMubGVuZ3RoID09PSBwYXRjaGVzLmxlbmd0aCkge1xuICAgICAgICBjbGVhclBhdGNoQXBwbGljYXRpb25TdGF0ZShwYXRjaGVzWzBdKVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gV2UgZmFpbGVkIHdoaWxlIHJldmVyc2luZyBwYXRjaGVzIGFuZCBzb21lIGFyZSBzdGlsbCBpbiB0aGUgYXBwbGllZCBzdGF0ZS5cbiAgICAgICAgLy8gV2UgbmVlZCB0byB1cGRhdGUgdGhlIHN0YXRlIGZpbGUgdG8gcmVmbGVjdCB0aGF0LlxuICAgICAgICAvLyBhcHBsaWVkUGF0Y2hlcyBpcyBjdXJyZW50bHkgdGhlIHBhdGNoZXMgdGhhdCB3ZXJlIHN1Y2Nlc3NmdWxseSByZXZlcnNlZCwgaW4gdGhlIG9yZGVyIHRoZXkgd2VyZSByZXZlcnNlZFxuICAgICAgICAvLyBTbyB3ZSBuZWVkIHRvIGZpbmQgdGhlIGluZGV4IG9mIHRoZSBsYXN0IHJldmVyc2VkIHBhdGNoIGluIHRoZSBvcmlnaW5hbCBwYXRjaGVzIGFycmF5XG4gICAgICAgIC8vIGFuZCB0aGVuIHJlbW92ZSBhbGwgdGhlIHBhdGNoZXMgYWZ0ZXIgdGhhdC4gU29ycnkgZm9yIHRoZSBjb25mdXNpbmcgY29kZS5cbiAgICAgICAgY29uc3QgbGFzdFJldmVyc2VkUGF0Y2hJbmRleCA9IHBhdGNoZXMuaW5kZXhPZihcbiAgICAgICAgICBhcHBsaWVkUGF0Y2hlc1thcHBsaWVkUGF0Y2hlcy5sZW5ndGggLSAxXSxcbiAgICAgICAgKVxuICAgICAgICBpZiAobGFzdFJldmVyc2VkUGF0Y2hJbmRleCA9PT0gLTEpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICBcInVuZXhwZWN0ZWQgc3RhdGU6IGZhaWxlZCB0byBmaW5kIGxhc3QgcmV2ZXJzZWQgcGF0Y2ggaW4gb3JpZ2luYWwgcGF0Y2hlcyBhcnJheVwiLFxuICAgICAgICAgIClcbiAgICAgICAgfVxuXG4gICAgICAgIHNhdmVQYXRjaEFwcGxpY2F0aW9uU3RhdGUoe1xuICAgICAgICAgIHBhY2thZ2VEZXRhaWxzOiBwYXRjaGVzWzBdLFxuICAgICAgICAgIHBhdGNoZXM6IHBhdGNoZXMuc2xpY2UoMCwgbGFzdFJldmVyc2VkUGF0Y2hJbmRleCkubWFwKChwYXRjaCkgPT4gKHtcbiAgICAgICAgICAgIGRpZEFwcGx5OiB0cnVlLFxuICAgICAgICAgICAgcGF0Y2hDb250ZW50SGFzaDogaGFzaEZpbGUoXG4gICAgICAgICAgICAgIGpvaW4oYXBwUGF0aCwgcGF0Y2hEaXIsIHBhdGNoLnBhdGNoRmlsZW5hbWUpLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgICAgIHBhdGNoRmlsZW5hbWU6IHBhdGNoLnBhdGNoRmlsZW5hbWUsXG4gICAgICAgICAgfSkpLFxuICAgICAgICAgIGlzUmViYXNpbmc6IGZhbHNlLFxuICAgICAgICB9KVxuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBuZXh0U3RhdGUgPSBhcHBsaWVkUGF0Y2hlcy5tYXAoXG4gICAgICAgIChwYXRjaCk6IFBhdGNoU3RhdGUgPT4gKHtcbiAgICAgICAgICBkaWRBcHBseTogdHJ1ZSxcbiAgICAgICAgICBwYXRjaENvbnRlbnRIYXNoOiBoYXNoRmlsZShcbiAgICAgICAgICAgIGpvaW4oYXBwUGF0aCwgcGF0Y2hEaXIsIHBhdGNoLnBhdGNoRmlsZW5hbWUpLFxuICAgICAgICAgICksXG4gICAgICAgICAgcGF0Y2hGaWxlbmFtZTogcGF0Y2gucGF0Y2hGaWxlbmFtZSxcbiAgICAgICAgfSksXG4gICAgICApXG5cbiAgICAgIGlmIChmYWlsZWRQYXRjaCkge1xuICAgICAgICBuZXh0U3RhdGUucHVzaCh7XG4gICAgICAgICAgZGlkQXBwbHk6IGZhbHNlLFxuICAgICAgICAgIHBhdGNoQ29udGVudEhhc2g6IGhhc2hGaWxlKFxuICAgICAgICAgICAgam9pbihhcHBQYXRoLCBwYXRjaERpciwgZmFpbGVkUGF0Y2gucGF0Y2hGaWxlbmFtZSksXG4gICAgICAgICAgKSxcbiAgICAgICAgICBwYXRjaEZpbGVuYW1lOiBmYWlsZWRQYXRjaC5wYXRjaEZpbGVuYW1lLFxuICAgICAgICB9KVxuICAgICAgfVxuICAgICAgc2F2ZVBhdGNoQXBwbGljYXRpb25TdGF0ZSh7XG4gICAgICAgIHBhY2thZ2VEZXRhaWxzOiBwYXRjaGVzWzBdLFxuICAgICAgICBwYXRjaGVzOiBuZXh0U3RhdGUsXG4gICAgICAgIGlzUmViYXNpbmc6ICEhZmFpbGVkUGF0Y2gsXG4gICAgICB9KVxuICAgIH1cbiAgICBpZiAoZmFpbGVkUGF0Y2gpIHtcbiAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgIH1cbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlQYXRjaCh7XG4gIHBhdGNoRmlsZVBhdGgsXG4gIHJldmVyc2UsXG4gIHBhdGNoRGV0YWlscyxcbiAgcGF0Y2hEaXIsXG4gIGN3ZCxcbiAgYmVzdEVmZm9ydCxcbn06IHtcbiAgcGF0Y2hGaWxlUGF0aDogc3RyaW5nXG4gIHJldmVyc2U6IGJvb2xlYW5cbiAgcGF0Y2hEZXRhaWxzOiBQYWNrYWdlRGV0YWlsc1xuICBwYXRjaERpcjogc3RyaW5nXG4gIGN3ZDogc3RyaW5nXG4gIGJlc3RFZmZvcnQ6IGJvb2xlYW5cbn0pOiBib29sZWFuIHtcbiAgY29uc3QgcGF0Y2ggPSByZWFkUGF0Y2goe1xuICAgIHBhdGNoRmlsZVBhdGgsXG4gICAgcGF0Y2hEZXRhaWxzLFxuICAgIHBhdGNoRGlyLFxuICB9KVxuXG4gIGNvbnN0IGZvcndhcmQgPSByZXZlcnNlID8gcmV2ZXJzZVBhdGNoKHBhdGNoKSA6IHBhdGNoXG4gIHRyeSB7XG4gICAgaWYgKCFiZXN0RWZmb3J0KSB7XG4gICAgICBleGVjdXRlRWZmZWN0cyhmb3J3YXJkLCB7IGRyeVJ1bjogdHJ1ZSwgY3dkLCBiZXN0RWZmb3J0OiBmYWxzZSB9KVxuICAgIH1cbiAgICBjb25zdCBlcnJvcnM6IHN0cmluZ1tdIHwgdW5kZWZpbmVkID0gYmVzdEVmZm9ydCA/IFtdIDogdW5kZWZpbmVkXG4gICAgZXhlY3V0ZUVmZmVjdHMoZm9yd2FyZCwgeyBkcnlSdW46IGZhbHNlLCBjd2QsIGJlc3RFZmZvcnQsIGVycm9ycyB9KVxuICAgIGlmIChlcnJvcnM/Lmxlbmd0aCkge1xuICAgICAgY29uc29sZS5sb2coXG4gICAgICAgIFwiU2F2aW5nIGVycm9ycyB0b1wiLFxuICAgICAgICBjaGFsay5jeWFuLmJvbGQoXCIuL3BhdGNoLXBhY2thZ2UtZXJyb3JzLmxvZ1wiKSxcbiAgICAgIClcbiAgICAgIHdyaXRlRmlsZVN5bmMoXCJwYXRjaC1wYWNrYWdlLWVycm9ycy5sb2dcIiwgZXJyb3JzLmpvaW4oXCJcXG5cXG5cIikpXG4gICAgICBwcm9jZXNzLmV4aXQoMClcbiAgICB9XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgYmFja3dhcmQgPSByZXZlcnNlID8gcGF0Y2ggOiByZXZlcnNlUGF0Y2gocGF0Y2gpXG4gICAgICBleGVjdXRlRWZmZWN0cyhiYWNrd2FyZCwge1xuICAgICAgICBkcnlSdW46IHRydWUsXG4gICAgICAgIGN3ZCxcbiAgICAgICAgYmVzdEVmZm9ydDogZmFsc2UsXG4gICAgICB9KVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHJldHVybiBmYWxzZVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiB0cnVlXG59XG5cbmZ1bmN0aW9uIGNyZWF0ZVZlcnNpb25NaXNtYXRjaFdhcm5pbmcoe1xuICBwYWNrYWdlTmFtZSxcbiAgYWN0dWFsVmVyc2lvbixcbiAgb3JpZ2luYWxWZXJzaW9uLFxuICBwYXRoU3BlY2lmaWVyLFxuICBwYXRoLFxufToge1xuICBwYWNrYWdlTmFtZTogc3RyaW5nXG4gIGFjdHVhbFZlcnNpb246IHN0cmluZ1xuICBvcmlnaW5hbFZlcnNpb246IHN0cmluZ1xuICBwYXRoU3BlY2lmaWVyOiBzdHJpbmdcbiAgcGF0aDogc3RyaW5nXG59KSB7XG4gIHJldHVybiBgXG4ke2NoYWxrLnllbGxvdyhcIldhcm5pbmc6XCIpfSBwYXRjaC1wYWNrYWdlIGRldGVjdGVkIGEgcGF0Y2ggZmlsZSB2ZXJzaW9uIG1pc21hdGNoXG5cbiAgRG9uJ3Qgd29ycnkhIFRoaXMgaXMgcHJvYmFibHkgZmluZS4gVGhlIHBhdGNoIHdhcyBzdGlsbCBhcHBsaWVkXG4gIHN1Y2Nlc3NmdWxseS4gSGVyZSdzIHRoZSBkZWV0czpcblxuICBQYXRjaCBmaWxlIGNyZWF0ZWQgZm9yXG5cbiAgICAke3BhY2thZ2VOYW1lfUAke2NoYWxrLmJvbGQob3JpZ2luYWxWZXJzaW9uKX1cblxuICBhcHBsaWVkIHRvXG5cbiAgICAke3BhY2thZ2VOYW1lfUAke2NoYWxrLmJvbGQoYWN0dWFsVmVyc2lvbil9XG4gIFxuICBBdCBwYXRoXG4gIFxuICAgICR7cGF0aH1cblxuICBUaGlzIHdhcm5pbmcgaXMganVzdCB0byBnaXZlIHlvdSBhIGhlYWRzLXVwLiBUaGVyZSBpcyBhIHNtYWxsIGNoYW5jZSBvZlxuICBicmVha2FnZSBldmVuIHRob3VnaCB0aGUgcGF0Y2ggd2FzIGFwcGxpZWQgc3VjY2Vzc2Z1bGx5LiBNYWtlIHN1cmUgdGhlIHBhY2thZ2VcbiAgc3RpbGwgYmVoYXZlcyBsaWtlIHlvdSBleHBlY3QgKHlvdSB3cm90ZSB0ZXN0cywgcmlnaHQ/KSBhbmQgdGhlbiBydW5cblxuICAgICR7Y2hhbGsuYm9sZChgcGF0Y2gtcGFja2FnZSAke3BhdGhTcGVjaWZpZXJ9YCl9XG5cbiAgdG8gdXBkYXRlIHRoZSB2ZXJzaW9uIGluIHRoZSBwYXRjaCBmaWxlIG5hbWUgYW5kIG1ha2UgdGhpcyB3YXJuaW5nIGdvIGF3YXkuXG5gXG59XG5cbmZ1bmN0aW9uIGNyZWF0ZUJyb2tlblBhdGNoRmlsZUVycm9yKHtcbiAgcGFja2FnZU5hbWUsXG4gIHBhdGNoRmlsZW5hbWUsXG4gIHBhdGgsXG4gIHBhdGhTcGVjaWZpZXIsXG59OiB7XG4gIHBhY2thZ2VOYW1lOiBzdHJpbmdcbiAgcGF0Y2hGaWxlbmFtZTogc3RyaW5nXG4gIHBhdGg6IHN0cmluZ1xuICBwYXRoU3BlY2lmaWVyOiBzdHJpbmdcbn0pIHtcbiAgcmV0dXJuIGBcbiR7Y2hhbGsucmVkLmJvbGQoXCIqKkVSUk9SKipcIil9ICR7Y2hhbGsucmVkKFxuICAgIGBGYWlsZWQgdG8gYXBwbHkgcGF0Y2ggZm9yIHBhY2thZ2UgJHtjaGFsay5ib2xkKHBhY2thZ2VOYW1lKX0gYXQgcGF0aGAsXG4gICl9XG4gIFxuICAgICR7cGF0aH1cblxuICBUaGlzIGVycm9yIHdhcyBjYXVzZWQgYmVjYXVzZSBwYXRjaC1wYWNrYWdlIGNhbm5vdCBhcHBseSB0aGUgZm9sbG93aW5nIHBhdGNoIGZpbGU6XG5cbiAgICBwYXRjaGVzLyR7cGF0Y2hGaWxlbmFtZX1cblxuICBUcnkgcmVtb3Zpbmcgbm9kZV9tb2R1bGVzIGFuZCB0cnlpbmcgYWdhaW4uIElmIHRoYXQgZG9lc24ndCB3b3JrLCBtYXliZSB0aGVyZSB3YXNcbiAgYW4gYWNjaWRlbnRhbCBjaGFuZ2UgbWFkZSB0byB0aGUgcGF0Y2ggZmlsZT8gVHJ5IHJlY3JlYXRpbmcgaXQgYnkgbWFudWFsbHlcbiAgZWRpdGluZyB0aGUgYXBwcm9wcmlhdGUgZmlsZXMgYW5kIHJ1bm5pbmc6XG4gIFxuICAgIHBhdGNoLXBhY2thZ2UgJHtwYXRoU3BlY2lmaWVyfVxuICBcbiAgSWYgdGhhdCBkb2Vzbid0IHdvcmssIHRoZW4gaXQncyBhIGJ1ZyBpbiBwYXRjaC1wYWNrYWdlLCBzbyBwbGVhc2Ugc3VibWl0IGEgYnVnXG4gIHJlcG9ydC4gVGhhbmtzIVxuXG4gICAgaHR0cHM6Ly9naXRodWIuY29tL2RzMzAwL3BhdGNoLXBhY2thZ2UvaXNzdWVzXG4gICAgXG5gXG59XG5cbmZ1bmN0aW9uIGNyZWF0ZVBhdGNoQXBwbGljYXRpb25GYWlsdXJlRXJyb3Ioe1xuICBwYWNrYWdlTmFtZSxcbiAgYWN0dWFsVmVyc2lvbixcbiAgb3JpZ2luYWxWZXJzaW9uLFxuICBwYXRjaEZpbGVuYW1lLFxuICBwYXRoLFxuICBwYXRoU3BlY2lmaWVyLFxufToge1xuICBwYWNrYWdlTmFtZTogc3RyaW5nXG4gIGFjdHVhbFZlcnNpb246IHN0cmluZ1xuICBvcmlnaW5hbFZlcnNpb246IHN0cmluZ1xuICBwYXRjaEZpbGVuYW1lOiBzdHJpbmdcbiAgcGF0aDogc3RyaW5nXG4gIHBhdGhTcGVjaWZpZXI6IHN0cmluZ1xufSkge1xuICByZXR1cm4gYFxuJHtjaGFsay5yZWQuYm9sZChcIioqRVJST1IqKlwiKX0gJHtjaGFsay5yZWQoXG4gICAgYEZhaWxlZCB0byBhcHBseSBwYXRjaCBmb3IgcGFja2FnZSAke2NoYWxrLmJvbGQocGFja2FnZU5hbWUpfSBhdCBwYXRoYCxcbiAgKX1cbiAgXG4gICAgJHtwYXRofVxuXG4gIFRoaXMgZXJyb3Igd2FzIGNhdXNlZCBiZWNhdXNlICR7Y2hhbGsuYm9sZChwYWNrYWdlTmFtZSl9IGhhcyBjaGFuZ2VkIHNpbmNlIHlvdVxuICBtYWRlIHRoZSBwYXRjaCBmaWxlIGZvciBpdC4gVGhpcyBpbnRyb2R1Y2VkIGNvbmZsaWN0cyB3aXRoIHlvdXIgcGF0Y2gsXG4gIGp1c3QgbGlrZSBhIG1lcmdlIGNvbmZsaWN0IGluIEdpdCB3aGVuIHNlcGFyYXRlIGluY29tcGF0aWJsZSBjaGFuZ2VzIGFyZVxuICBtYWRlIHRvIHRoZSBzYW1lIHBpZWNlIG9mIGNvZGUuXG5cbiAgTWF5YmUgdGhpcyBtZWFucyB5b3VyIHBhdGNoIGZpbGUgaXMgbm8gbG9uZ2VyIG5lY2Vzc2FyeSwgaW4gd2hpY2ggY2FzZVxuICBob29yYXkhIEp1c3QgZGVsZXRlIGl0IVxuXG4gIE90aGVyd2lzZSwgeW91IG5lZWQgdG8gZ2VuZXJhdGUgYSBuZXcgcGF0Y2ggZmlsZS5cblxuICBUbyBnZW5lcmF0ZSBhIG5ldyBvbmUsIGp1c3QgcmVwZWF0IHRoZSBzdGVwcyB5b3UgbWFkZSB0byBnZW5lcmF0ZSB0aGUgZmlyc3RcbiAgb25lLlxuXG4gIGkuZS4gbWFudWFsbHkgbWFrZSB0aGUgYXBwcm9wcmlhdGUgZmlsZSBjaGFuZ2VzLCB0aGVuIHJ1biBcblxuICAgIHBhdGNoLXBhY2thZ2UgJHtwYXRoU3BlY2lmaWVyfVxuXG4gIEluZm86XG4gICAgUGF0Y2ggZmlsZTogcGF0Y2hlcy8ke3BhdGNoRmlsZW5hbWV9XG4gICAgUGF0Y2ggd2FzIG1hZGUgZm9yIHZlcnNpb246ICR7Y2hhbGsuZ3JlZW4uYm9sZChvcmlnaW5hbFZlcnNpb24pfVxuICAgIEluc3RhbGxlZCB2ZXJzaW9uOiAke2NoYWxrLnJlZC5ib2xkKGFjdHVhbFZlcnNpb24pfVxuYFxufVxuXG5mdW5jdGlvbiBjcmVhdGVVbmV4cGVjdGVkRXJyb3Ioe1xuICBmaWxlbmFtZSxcbiAgZXJyb3IsXG59OiB7XG4gIGZpbGVuYW1lOiBzdHJpbmdcbiAgZXJyb3I6IEVycm9yXG59KSB7XG4gIHJldHVybiBgXG4ke2NoYWxrLnJlZC5ib2xkKFwiKipFUlJPUioqXCIpfSAke2NoYWxrLnJlZChcbiAgICBgRmFpbGVkIHRvIGFwcGx5IHBhdGNoIGZpbGUgJHtjaGFsay5ib2xkKGZpbGVuYW1lKX1gLFxuICApfVxuICBcbiR7ZXJyb3Iuc3RhY2t9XG5cbiAgYFxufVxuIl19