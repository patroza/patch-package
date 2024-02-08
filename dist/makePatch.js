import chalk from "chalk";
import console from "console";
import { renameSync } from "fs";
import fs from "fs-extra";
const { copySync, existsSync, mkdirpSync, mkdirSync, realpathSync, writeFileSync, } = fs;
import { sync as rimraf } from "rimraf";
import { dirSync } from "tmp";
import { gzipSync } from "zlib";
import { applyPatch } from "./applyPatches.js";
import { getPackageVCSDetails, maybePrintIssueCreationPrompt, openIssueCreationLink, shouldRecommendIssue, } from "./createIssue.js";
import { removeIgnoredFiles } from "./filterFiles.js";
import { getPackageResolution } from "./getPackageResolution.js";
import { getPackageVersion } from "./getPackageVersion.js";
import { hashFile } from "./hash.js";
import { getPatchDetailsFromCliString, } from "./PackageDetails.js";
import { parsePatchFile } from "./patch/parse.js";
import { getGroupedPatches } from "./patchFs.js";
import { dirname, join, resolve } from "./path.js";
import { resolveRelativeFileDependencies } from "./resolveRelativeFileDependencies.js";
import { spawnSafeSync } from "./spawnSafe.js";
import { clearPatchApplicationState, getPatchApplicationState, savePatchApplicationState, STATE_FILE_NAME, verifyAppliedPatches, } from "./stateFile.js";
function printNoPackageFoundError(packageName, packageJsonPath) {
    console.log(`No such package ${packageName}

  File not found: ${packageJsonPath}`);
}
export function makePatch({ packagePathSpecifier, appPath, packageManager, includePaths, excludePaths, patchDir, createIssue, mode, }) {
    var _a, _b, _c, _d, _e;
    const packageDetails = getPatchDetailsFromCliString(packagePathSpecifier);
    if (!packageDetails) {
        console.log("No such package", packagePathSpecifier);
        return;
    }
    const state = getPatchApplicationState(packageDetails);
    const isRebasing = (_a = state === null || state === void 0 ? void 0 : state.isRebasing) !== null && _a !== void 0 ? _a : false;
    // If we are rebasing and no patches have been applied, --append is the only valid option because
    // there are no previous patches to overwrite/update
    if (isRebasing &&
        (state === null || state === void 0 ? void 0 : state.patches.filter((p) => p.didApply).length) === 0 &&
        mode.type === "overwrite_last") {
        mode = { type: "append", name: "initial" };
    }
    if (isRebasing && state) {
        verifyAppliedPatches({ appPath, patchDir, state });
    }
    if (mode.type === "overwrite_last" &&
        isRebasing &&
        (state === null || state === void 0 ? void 0 : state.patches.length) === 0) {
        mode = { type: "append", name: "initial" };
    }
    const existingPatches = getGroupedPatches(patchDir).pathSpecifierToPatchFiles[packageDetails.pathSpecifier] || [];
    // apply all existing patches if appending
    // otherwise apply all but the last
    const previouslyAppliedPatches = state === null || state === void 0 ? void 0 : state.patches.filter((p) => p.didApply);
    const patchesToApplyBeforeDiffing = isRebasing
        ? mode.type === "append"
            ? existingPatches.slice(0, previouslyAppliedPatches.length)
            : state.patches[state.patches.length - 1].didApply
                ? existingPatches.slice(0, previouslyAppliedPatches.length - 1)
                : existingPatches.slice(0, previouslyAppliedPatches.length)
        : mode.type === "append"
            ? existingPatches
            : existingPatches.slice(0, -1);
    if (createIssue && mode.type === "append") {
        console.log("--create-issue is not compatible with --append.");
        process.exit(1);
    }
    if (createIssue && isRebasing) {
        console.log("--create-issue is not compatible with rebasing.");
        process.exit(1);
    }
    const numPatchesAfterCreate = mode.type === "append" || existingPatches.length === 0
        ? existingPatches.length + 1
        : existingPatches.length;
    const vcs = getPackageVCSDetails(packageDetails);
    const canCreateIssue = !isRebasing &&
        shouldRecommendIssue(vcs) &&
        numPatchesAfterCreate === 1 &&
        mode.type !== "append";
    const appPackageJson = require(join(appPath, "package.json"));
    const packagePath = join(appPath, packageDetails.path);
    const packageJsonPath = join(packagePath, "package.json");
    if (!existsSync(packageJsonPath)) {
        printNoPackageFoundError(packagePathSpecifier, packageJsonPath);
        process.exit(1);
    }
    const tmpRepo = dirSync({ unsafeCleanup: true });
    const tmpRepoPackagePath = join(tmpRepo.name, packageDetails.path);
    const tmpRepoNpmRoot = tmpRepoPackagePath.slice(0, -`/node_modules/${packageDetails.name}`.length);
    const tmpRepoPackageJsonPath = join(tmpRepoNpmRoot, "package.json");
    try {
        const patchesDir = resolve(join(appPath, patchDir));
        console.info(chalk.grey("•"), "Creating temporary folder");
        // make a blank package.json
        mkdirpSync(tmpRepoNpmRoot);
        writeFileSync(tmpRepoPackageJsonPath, JSON.stringify({
            dependencies: {
                [packageDetails.name]: getPackageResolution({
                    packageDetails,
                    packageManager,
                    appPath,
                }),
            },
            resolutions: resolveRelativeFileDependencies(appPath, appPackageJson.resolutions || {}),
        }));
        const packageVersion = getPackageVersion(join(resolve(packageDetails.path), "package.json"));
        [".npmrc", ".yarnrc", ".yarn"].forEach((rcFile) => {
            const rcPath = join(appPath, rcFile);
            if (existsSync(rcPath)) {
                copySync(rcPath, join(tmpRepo.name, rcFile), { dereference: true });
            }
        });
        if (packageManager === "yarn") {
            console.info(chalk.grey("•"), `Installing ${packageDetails.name}@${packageVersion} with yarn`);
            try {
                // try first without ignoring scripts in case they are required
                // this works in 99.99% of cases
                spawnSafeSync(`yarn`, ["install", "--ignore-engines"], {
                    cwd: tmpRepoNpmRoot,
                    logStdErrOnError: false,
                });
            }
            catch (e) {
                // try again while ignoring scripts in case the script depends on
                // an implicit context which we haven't reproduced
                spawnSafeSync(`yarn`, ["install", "--ignore-engines", "--ignore-scripts"], {
                    cwd: tmpRepoNpmRoot,
                });
            }
        }
        else {
            console.info(chalk.grey("•"), `Installing ${packageDetails.name}@${packageVersion} with npm`);
            try {
                // try first without ignoring scripts in case they are required
                // this works in 99.99% of cases
                spawnSafeSync(`npm`, ["i", "--force"], {
                    cwd: tmpRepoNpmRoot,
                    logStdErrOnError: false,
                    stdio: "ignore",
                });
            }
            catch (e) {
                // try again while ignoring scripts in case the script depends on
                // an implicit context which we haven't reproduced
                spawnSafeSync(`npm`, ["i", "--ignore-scripts", "--force"], {
                    cwd: tmpRepoNpmRoot,
                    stdio: "ignore",
                });
            }
        }
        const git = (...args) => spawnSafeSync("git", args, {
            cwd: tmpRepo.name,
            env: Object.assign(Object.assign({}, process.env), { HOME: tmpRepo.name }),
            maxBuffer: 1024 * 1024 * 100,
        });
        // remove nested node_modules just to be safe
        rimraf(join(tmpRepoPackagePath, "node_modules"));
        // remove .git just to be safe
        rimraf(join(tmpRepoPackagePath, ".git"));
        // remove patch-package state file
        rimraf(join(tmpRepoPackagePath, STATE_FILE_NAME));
        // commit the package
        console.info(chalk.grey("•"), "Diffing your files with clean files");
        writeFileSync(join(tmpRepo.name, ".gitignore"), "!/node_modules\n\n");
        git("init");
        git("config", "--local", "user.name", "patch-package");
        git("config", "--local", "user.email", "patch@pack.age");
        // remove ignored files first
        removeIgnoredFiles(tmpRepoPackagePath, includePaths, excludePaths);
        for (const patchDetails of patchesToApplyBeforeDiffing) {
            if (!applyPatch({
                patchDetails,
                patchDir,
                patchFilePath: join(appPath, patchDir, patchDetails.patchFilename),
                reverse: false,
                cwd: tmpRepo.name,
                bestEffort: false,
            })) {
                // TODO: add better error message once --rebase is implemented
                console.log(`Failed to apply patch ${patchDetails.patchFilename} to ${packageDetails.pathSpecifier}`);
                process.exit(1);
            }
        }
        git("add", "-f", packageDetails.path);
        git("commit", "--allow-empty", "-m", "init");
        // replace package with user's version
        rimraf(tmpRepoPackagePath);
        // pnpm installs packages as symlinks, copySync would copy only the symlink
        copySync(realpathSync(packagePath), tmpRepoPackagePath);
        // remove nested node_modules just to be safe
        rimraf(join(tmpRepoPackagePath, "node_modules"));
        // remove .git just to be safe
        rimraf(join(tmpRepoPackagePath, ".git"));
        // remove patch-package state file
        rimraf(join(tmpRepoPackagePath, STATE_FILE_NAME));
        // also remove ignored files like before
        removeIgnoredFiles(tmpRepoPackagePath, includePaths, excludePaths);
        // stage all files
        git("add", "-f", packageDetails.path);
        // get diff of changes
        const diffResult = git("diff", "--cached", "--no-color", "--ignore-space-at-eol", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/");
        if (diffResult.stdout.length === 0) {
            console.log(`⁉️  Not creating patch file for package '${packagePathSpecifier}'`);
            console.log(`⁉️  There don't appear to be any changes.`);
            if (isRebasing && mode.type === "overwrite_last") {
                console.log("\n💡 To remove a patch file, delete it and then reinstall node_modules from scratch.");
            }
            process.exit(1);
            return;
        }
        try {
            parsePatchFile(diffResult.stdout.toString());
        }
        catch (e) {
            if (e.message.includes("Unexpected file mode string: 120000")) {
                console.log(`
⛔️ ${chalk.red.bold("ERROR")}

  Your changes involve creating symlinks. patch-package does not yet support
  symlinks.
  
  ️Please use ${chalk.bold("--include")} and/or ${chalk.bold("--exclude")} to narrow the scope of your patch if
  this was unintentional.
`);
            }
            else {
                const outPath = "./patch-package-error.json.gz";
                writeFileSync(outPath, gzipSync(JSON.stringify({
                    error: { message: e.message, stack: e.stack },
                    patch: diffResult.stdout.toString(),
                })));
                console.log(`
⛔️ ${chalk.red.bold("ERROR")}
        
  patch-package was unable to read the patch-file made by git. This should not
  happen.
  
  A diagnostic file was written to
  
    ${outPath}
  
  Please attach it to a github issue
  
    https://github.com/ds300/patch-package/issues/new?title=New+patch+parse+failed&body=Please+attach+the+diagnostic+file+by+dragging+it+into+here+🙏
  
  Note that this diagnostic file will contain code from the package you were
  attempting to patch.

`);
            }
            process.exit(1);
            return;
        }
        // maybe delete existing
        if (mode.type === "append" && !isRebasing && existingPatches.length === 1) {
            // if we are appending to an existing patch that doesn't have a sequence number let's rename it
            const prevPatch = existingPatches[0];
            if (prevPatch.sequenceNumber === undefined) {
                const newFileName = createPatchFileName({
                    packageDetails,
                    packageVersion,
                    sequenceNumber: 1,
                    sequenceName: (_b = prevPatch.sequenceName) !== null && _b !== void 0 ? _b : "initial",
                });
                const oldPath = join(appPath, patchDir, prevPatch.patchFilename);
                const newPath = join(appPath, patchDir, newFileName);
                renameSync(oldPath, newPath);
                prevPatch.sequenceNumber = 1;
                prevPatch.patchFilename = newFileName;
                prevPatch.sequenceName = (_c = prevPatch.sequenceName) !== null && _c !== void 0 ? _c : "initial";
            }
        }
        const lastPatch = existingPatches[state ? state.patches.length - 1 : existingPatches.length - 1];
        const sequenceName = mode.type === "append" ? mode.name : lastPatch === null || lastPatch === void 0 ? void 0 : lastPatch.sequenceName;
        const sequenceNumber = mode.type === "append"
            ? ((_d = lastPatch === null || lastPatch === void 0 ? void 0 : lastPatch.sequenceNumber) !== null && _d !== void 0 ? _d : 0) + 1
            : lastPatch === null || lastPatch === void 0 ? void 0 : lastPatch.sequenceNumber;
        const patchFileName = createPatchFileName({
            packageDetails,
            packageVersion,
            sequenceName,
            sequenceNumber,
        });
        const patchPath = join(patchesDir, patchFileName);
        if (!existsSync(dirname(patchPath))) {
            // scoped package
            mkdirSync(dirname(patchPath));
        }
        // if we are inserting a new patch into a sequence we most likely need to update the sequence numbers
        if (isRebasing && mode.type === "append") {
            const patchesToNudge = existingPatches.slice(state.patches.length);
            if (sequenceNumber === undefined) {
                throw new Error("sequenceNumber is undefined while rebasing");
            }
            if (((_e = patchesToNudge[0]) === null || _e === void 0 ? void 0 : _e.sequenceNumber) !== undefined &&
                patchesToNudge[0].sequenceNumber <= sequenceNumber) {
                let next = sequenceNumber + 1;
                for (const p of patchesToNudge) {
                    const newName = createPatchFileName({
                        packageDetails,
                        packageVersion,
                        sequenceName: p.sequenceName,
                        sequenceNumber: next++,
                    });
                    console.log("Renaming", chalk.bold(p.patchFilename), "to", chalk.bold(newName));
                    const oldPath = join(appPath, patchDir, p.patchFilename);
                    const newPath = join(appPath, patchDir, newName);
                    renameSync(oldPath, newPath);
                }
            }
        }
        writeFileSync(patchPath, diffResult.stdout);
        console.log(`${chalk.green("✔")} Created file ${join(patchDir, patchFileName)}\n`);
        const prevState = patchesToApplyBeforeDiffing.map((p) => ({
            patchFilename: p.patchFilename,
            didApply: true,
            patchContentHash: hashFile(join(appPath, patchDir, p.patchFilename)),
        }));
        const nextState = [
            ...prevState,
            {
                patchFilename: patchFileName,
                didApply: true,
                patchContentHash: hashFile(patchPath),
            },
        ];
        // if any patches come after this one we just made, we should reapply them
        let didFailWhileFinishingRebase = false;
        if (isRebasing) {
            const currentPatches = getGroupedPatches(join(appPath, patchDir))
                .pathSpecifierToPatchFiles[packageDetails.pathSpecifier];
            const previouslyUnappliedPatches = currentPatches.slice(nextState.length);
            if (previouslyUnappliedPatches.length) {
                console.log(`Fast forwarding...`);
                for (const patch of previouslyUnappliedPatches) {
                    const patchFilePath = join(appPath, patchDir, patch.patchFilename);
                    if (!applyPatch({
                        patchDetails: patch,
                        patchDir,
                        patchFilePath,
                        reverse: false,
                        cwd: process.cwd(),
                        bestEffort: false,
                    })) {
                        didFailWhileFinishingRebase = true;
                        logPatchSequenceError({ patchDetails: patch });
                        nextState.push({
                            patchFilename: patch.patchFilename,
                            didApply: false,
                            patchContentHash: hashFile(patchFilePath),
                        });
                        break;
                    }
                    else {
                        console.log(`  ${chalk.green("✔")} ${patch.patchFilename}`);
                        nextState.push({
                            patchFilename: patch.patchFilename,
                            didApply: true,
                            patchContentHash: hashFile(patchFilePath),
                        });
                    }
                }
            }
        }
        if (isRebasing || numPatchesAfterCreate > 1) {
            savePatchApplicationState({
                packageDetails,
                patches: nextState,
                isRebasing: didFailWhileFinishingRebase,
            });
        }
        else {
            clearPatchApplicationState(packageDetails);
        }
        if (canCreateIssue) {
            if (createIssue) {
                openIssueCreationLink({
                    packageDetails,
                    patchFileContents: diffResult.stdout.toString(),
                    packageVersion,
                });
            }
            else {
                maybePrintIssueCreationPrompt(vcs, packageDetails, packageManager);
            }
        }
    }
    catch (e) {
        console.log(e);
        throw e;
    }
    finally {
        tmpRepo.removeCallback();
    }
}
function createPatchFileName({ packageDetails, packageVersion, sequenceNumber, sequenceName, }) {
    const packageNames = packageDetails.packageNames
        .map((name) => name.replace(/\//g, "+"))
        .join("++");
    const nameAndVersion = `${packageNames}+${packageVersion}`;
    const num = sequenceNumber === undefined
        ? ""
        : `+${sequenceNumber.toString().padStart(3, "0")}`;
    const name = !sequenceName ? "" : `+${sequenceName}`;
    return `${nameAndVersion}${num}${name}.patch`;
}
export function logPatchSequenceError({ patchDetails, }) {
    console.log(`
${chalk.red.bold("⛔ ERROR")}

Failed to apply patch file ${chalk.bold(patchDetails.patchFilename)}.

If this patch file is no longer useful, delete it and run

  ${chalk.bold(`patch-package`)}

To partially apply the patch (if possible) and output a log of errors to fix, run

  ${chalk.bold(`patch-package --partial`)}

After which you should make any required changes inside ${patchDetails.path}, and finally run

  ${chalk.bold(`patch-package ${patchDetails.pathSpecifier}`)}

to update the patch file.
`);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFrZVBhdGNoLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL21ha2VQYXRjaC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEtBQUssTUFBTSxPQUFPLENBQUE7QUFDekIsT0FBTyxPQUFPLE1BQU0sU0FBUyxDQUFBO0FBQzdCLE9BQU8sRUFBRSxVQUFVLEVBQUUsTUFBTSxJQUFJLENBQUE7QUFDL0IsT0FBTyxFQUFFLE1BQU0sVUFBVSxDQUFBO0FBQ3pCLE1BQU0sRUFDSixRQUFRLEVBQ1IsVUFBVSxFQUNWLFVBQVUsRUFDVixTQUFTLEVBQ1QsWUFBWSxFQUNaLGFBQWEsR0FDZCxHQUFHLEVBQUUsQ0FBQTtBQUNOLE9BQU8sRUFBRSxJQUFJLElBQUksTUFBTSxFQUFFLE1BQU0sUUFBUSxDQUFBO0FBQ3ZDLE9BQU8sRUFBRSxPQUFPLEVBQUUsTUFBTSxLQUFLLENBQUE7QUFDN0IsT0FBTyxFQUFFLFFBQVEsRUFBRSxNQUFNLE1BQU0sQ0FBQTtBQUMvQixPQUFPLEVBQUUsVUFBVSxFQUFFLE1BQU0sbUJBQW1CLENBQUE7QUFDOUMsT0FBTyxFQUNMLG9CQUFvQixFQUNwQiw2QkFBNkIsRUFDN0IscUJBQXFCLEVBQ3JCLG9CQUFvQixHQUNyQixNQUFNLGtCQUFrQixDQUFBO0FBRXpCLE9BQU8sRUFBRSxrQkFBa0IsRUFBRSxNQUFNLGtCQUFrQixDQUFBO0FBQ3JELE9BQU8sRUFBRSxvQkFBb0IsRUFBRSxNQUFNLDJCQUEyQixDQUFBO0FBQ2hFLE9BQU8sRUFBRSxpQkFBaUIsRUFBRSxNQUFNLHdCQUF3QixDQUFBO0FBQzFELE9BQU8sRUFBRSxRQUFRLEVBQUUsTUFBTSxXQUFXLENBQUE7QUFDcEMsT0FBTyxFQUNMLDRCQUE0QixHQUc3QixNQUFNLHFCQUFxQixDQUFBO0FBQzVCLE9BQU8sRUFBRSxjQUFjLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQTtBQUNqRCxPQUFPLEVBQUUsaUJBQWlCLEVBQUUsTUFBTSxjQUFjLENBQUE7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QUMvQyxDQUFDO0FBRUQsTUFBTSxVQUFVLHFCQUFxQixDQUFDLEVBQ3BDLFlBQVksR0FHYjtJQUNDLE9BQU8sQ0FBQyxHQUFHLENBQUM7RUFDWixLQUFLLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUM7OzZCQUVFLEtBQUssQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLGFBQWEsQ0FBQzs7OztJQUkvRCxLQUFLLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQzs7OztJQUkzQixLQUFLLENBQUMsSUFBSSxDQUFDLHlCQUF5QixDQUFDOzswREFHckMsWUFBWSxDQUFDLElBQ2Y7O0lBRUUsS0FBSyxDQUFDLElBQUksQ0FBQyxpQkFBaUIsWUFBWSxDQUFDLGFBQWEsRUFBRSxDQUFDOzs7Q0FHNUQsQ0FBQyxDQUFBO0FBQ0YsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBjaGFsayBmcm9tIFwiY2hhbGtcIlxuaW1wb3J0IGNvbnNvbGUgZnJvbSBcImNvbnNvbGVcIlxuaW1wb3J0IHsgcmVuYW1lU3luYyB9IGZyb20gXCJmc1wiXG5pbXBvcnQgZnMgZnJvbSBcImZzLWV4dHJhXCJcbmNvbnN0IHtcbiAgY29weVN5bmMsXG4gIGV4aXN0c1N5bmMsXG4gIG1rZGlycFN5bmMsXG4gIG1rZGlyU3luYyxcbiAgcmVhbHBhdGhTeW5jLFxuICB3cml0ZUZpbGVTeW5jLFxufSA9IGZzXG5pbXBvcnQgeyBzeW5jIGFzIHJpbXJhZiB9IGZyb20gXCJyaW1yYWZcIlxuaW1wb3J0IHsgZGlyU3luYyB9IGZyb20gXCJ0bXBcIlxuaW1wb3J0IHsgZ3ppcFN5bmMgfSBmcm9tIFwiemxpYlwiXG5pbXBvcnQgeyBhcHBseVBhdGNoIH0gZnJvbSBcIi4vYXBwbHlQYXRjaGVzLmpzXCJcbmltcG9ydCB7XG4gIGdldFBhY2thZ2VWQ1NEZXRhaWxzLFxuICBtYXliZVByaW50SXNzdWVDcmVhdGlvblByb21wdCxcbiAgb3Blbklzc3VlQ3JlYXRpb25MaW5rLFxuICBzaG91bGRSZWNvbW1lbmRJc3N1ZSxcbn0gZnJvbSBcIi4vY3JlYXRlSXNzdWUuanNcIlxuaW1wb3J0IHsgUGFja2FnZU1hbmFnZXIgfSBmcm9tIFwiLi9kZXRlY3RQYWNrYWdlTWFuYWdlci5qc1wiXG5pbXBvcnQgeyByZW1vdmVJZ25vcmVkRmlsZXMgfSBmcm9tIFwiLi9maWx0ZXJGaWxlcy5qc1wiXG5pbXBvcnQgeyBnZXRQYWNrYWdlUmVzb2x1dGlvbiB9IGZyb20gXCIuL2dldFBhY2thZ2VSZXNvbHV0aW9uLmpzXCJcbmltcG9ydCB7IGdldFBhY2thZ2VWZXJzaW9uIH0gZnJvbSBcIi4vZ2V0UGFja2FnZVZlcnNpb24uanNcIlxuaW1wb3J0IHsgaGFzaEZpbGUgfSBmcm9tIFwiLi9oYXNoLmpzXCJcbmltcG9ydCB7XG4gIGdldFBhdGNoRGV0YWlsc0Zyb21DbGlTdHJpbmcsXG4gIFBhY2thZ2VEZXRhaWxzLFxuICBQYXRjaGVkUGFja2FnZURldGFpbHMsXG59IGZyb20gXCIuL1BhY2thZ2VEZXRhaWxzLmpzXCJcbmltcG9ydCB7IHBhcnNlUGF0Y2hGaWxlIH0gZnJvbSBcIi4vcGF0Y2gvcGFyc2UuanNcIlxuaW1wb3J0IHsgZ2V0R3JvdXBlZFBhdGNoZXMgfSBmcm9tIFwiLi9wYXRjaEZzLmpzXCJcbmltcG9ydCB7IGRpcm5hbWUsIGpvaW4sIHJlc29sdmUgfSBmcm9tIFwiLi9wYXRoLmpzXCJcbmltcG9ydCB7IHJlc29sdmVSZWxhdGl2ZUZpbGVEZXBlbmRlbmNpZXMgfSBmcm9tIFwiLi9yZXNvbHZlUmVsYXRpdmVGaWxlRGVwZW5kZW5jaWVzLmpzXCJcbmltcG9ydCB7IHNwYXduU2FmZVN5bmMgfSBmcm9tIFwiLi9zcGF3blNhZmUuanNcIlxuaW1wb3J0IHtcbiAgY2xlYXJQYXRjaEFwcGxpY2F0aW9uU3RhdGUsXG4gIGdldFBhdGNoQXBwbGljYXRpb25TdGF0ZSxcbiAgUGF0Y2hTdGF0ZSxcbiAgc2F2ZVBhdGNoQXBwbGljYXRpb25TdGF0ZSxcbiAgU1RBVEVfRklMRV9OQU1FLFxuICB2ZXJpZnlBcHBsaWVkUGF0Y2hlcyxcbn0gZnJvbSBcIi4vc3RhdGVGaWxlLmpzXCJcblxuZnVuY3Rpb24gcHJpbnROb1BhY2thZ2VGb3VuZEVycm9yKFxuICBwYWNrYWdlTmFtZTogc3RyaW5nLFxuICBwYWNrYWdlSnNvblBhdGg6IHN0cmluZyxcbikge1xuICBjb25zb2xlLmxvZyhcbiAgICBgTm8gc3VjaCBwYWNrYWdlICR7cGFja2FnZU5hbWV9XG5cbiAgRmlsZSBub3QgZm91bmQ6ICR7cGFja2FnZUpzb25QYXRofWAsXG4gIClcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1ha2VQYXRjaCh7XG4gIHBhY2thZ2VQYXRoU3BlY2lmaWVyLFxuICBhcHBQYXRoLFxuICBwYWNrYWdlTWFuYWdlcixcbiAgaW5jbHVkZVBhdGhzLFxuICBleGNsdWRlUGF0aHMsXG4gIHBhdGNoRGlyLFxuICBjcmVhdGVJc3N1ZSxcbiAgbW9kZSxcbn06IHtcbiAgcGFja2FnZVBhdGhTcGVjaWZpZXI6IHN0cmluZ1xuICBhcHBQYXRoOiBzdHJpbmdcbiAgcGFja2FnZU1hbmFnZXI6IFBhY2thZ2VNYW5hZ2VyXG4gIGluY2x1ZGVQYXRoczogUmVnRXhwXG4gIGV4Y2x1ZGVQYXRoczogUmVnRXhwXG4gIHBhdGNoRGlyOiBzdHJpbmdcbiAgY3JlYXRlSXNzdWU6IGJvb2xlYW5cbiAgbW9kZTogeyB0eXBlOiBcIm92ZXJ3cml0ZV9sYXN0XCIgfSB8IHsgdHlwZTogXCJhcHBlbmRcIjsgbmFtZT86IHN0cmluZyB9XG59KSB7XG4gIGNvbnN0IHBhY2thZ2VEZXRhaWxzID0gZ2V0UGF0Y2hEZXRhaWxzRnJvbUNsaVN0cmluZyhwYWNrYWdlUGF0aFNwZWNpZmllcilcblxuICBpZiAoIXBhY2thZ2VEZXRhaWxzKSB7XG4gICAgY29uc29sZS5sb2coXCJObyBzdWNoIHBhY2thZ2VcIiwgcGFja2FnZVBhdGhTcGVjaWZpZXIpXG4gICAgcmV0dXJuXG4gIH1cblxuICBjb25zdCBzdGF0ZSA9IGdldFBhdGNoQXBwbGljYXRpb25TdGF0ZShwYWNrYWdlRGV0YWlscylcbiAgY29uc3QgaXNSZWJhc2luZyA9IHN0YXRlPy5pc1JlYmFzaW5nID8/IGZhbHNlXG5cbiAgLy8gSWYgd2UgYXJlIHJlYmFzaW5nIGFuZCBubyBwYXRjaGVzIGhhdmUgYmVlbiBhcHBsaWVkLCAtLWFwcGVuZCBpcyB0aGUgb25seSB2YWxpZCBvcHRpb24gYmVjYXVzZVxuICAvLyB0aGVyZSBhcmUgbm8gcHJldmlvdXMgcGF0Y2hlcyB0byBvdmVyd3JpdGUvdXBkYXRlXG4gIGlmIChcbiAgICBpc1JlYmFzaW5nICYmXG4gICAgc3RhdGU/LnBhdGNoZXMuZmlsdGVyKChwKSA9PiBwLmRpZEFwcGx5KS5sZW5ndGggPT09IDAgJiZcbiAgICBtb2RlLnR5cGUgPT09IFwib3ZlcndyaXRlX2xhc3RcIlxuICApIHtcbiAgICBtb2RlID0geyB0eXBlOiBcImFwcGVuZFwiLCBuYW1lOiBcImluaXRpYWxcIiB9XG4gIH1cblxuICBpZiAoaXNSZWJhc2luZyAmJiBzdGF0ZSkge1xuICAgIHZlcmlmeUFwcGxpZWRQYXRjaGVzKHsgYXBwUGF0aCwgcGF0Y2hEaXIsIHN0YXRlIH0pXG4gIH1cblxuICBpZiAoXG4gICAgbW9kZS50eXBlID09PSBcIm92ZXJ3cml0ZV9sYXN0XCIgJiZcbiAgICBpc1JlYmFzaW5nICYmXG4gICAgc3RhdGU/LnBhdGNoZXMubGVuZ3RoID09PSAwXG4gICkge1xuICAgIG1vZGUgPSB7IHR5cGU6IFwiYXBwZW5kXCIsIG5hbWU6IFwiaW5pdGlhbFwiIH1cbiAgfVxuXG4gIGNvbnN0IGV4aXN0aW5nUGF0Y2hlcyA9XG4gICAgZ2V0R3JvdXBlZFBhdGNoZXMocGF0Y2hEaXIpLnBhdGhTcGVjaWZpZXJUb1BhdGNoRmlsZXNbXG4gICAgICBwYWNrYWdlRGV0YWlscy5wYXRoU3BlY2lmaWVyXG4gICAgXSB8fCBbXVxuXG4gIC8vIGFwcGx5IGFsbCBleGlzdGluZyBwYXRjaGVzIGlmIGFwcGVuZGluZ1xuICAvLyBvdGhlcndpc2UgYXBwbHkgYWxsIGJ1dCB0aGUgbGFzdFxuICBjb25zdCBwcmV2aW91c2x5QXBwbGllZFBhdGNoZXMgPSBzdGF0ZT8ucGF0Y2hlcy5maWx0ZXIoKHApID0+IHAuZGlkQXBwbHkpXG4gIGNvbnN0IHBhdGNoZXNUb0FwcGx5QmVmb3JlRGlmZmluZzogUGF0Y2hlZFBhY2thZ2VEZXRhaWxzW10gPSBpc1JlYmFzaW5nXG4gICAgPyBtb2RlLnR5cGUgPT09IFwiYXBwZW5kXCJcbiAgICAgID8gZXhpc3RpbmdQYXRjaGVzLnNsaWNlKDAsIHByZXZpb3VzbHlBcHBsaWVkUGF0Y2hlcyEubGVuZ3RoKVxuICAgICAgOiBzdGF0ZSEucGF0Y2hlc1tzdGF0ZSEucGF0Y2hlcy5sZW5ndGggLSAxXS5kaWRBcHBseVxuICAgICAgPyBleGlzdGluZ1BhdGNoZXMuc2xpY2UoMCwgcHJldmlvdXNseUFwcGxpZWRQYXRjaGVzIS5sZW5ndGggLSAxKVxuICAgICAgOiBleGlzdGluZ1BhdGNoZXMuc2xpY2UoMCwgcHJldmlvdXNseUFwcGxpZWRQYXRjaGVzIS5sZW5ndGgpXG4gICAgOiBtb2RlLnR5cGUgPT09IFwiYXBwZW5kXCJcbiAgICA/IGV4aXN0aW5nUGF0Y2hlc1xuICAgIDogZXhpc3RpbmdQYXRjaGVzLnNsaWNlKDAsIC0xKVxuXG4gIGlmIChjcmVhdGVJc3N1ZSAmJiBtb2RlLnR5cGUgPT09IFwiYXBwZW5kXCIpIHtcbiAgICBjb25zb2xlLmxvZyhcIi0tY3JlYXRlLWlzc3VlIGlzIG5vdCBjb21wYXRpYmxlIHdpdGggLS1hcHBlbmQuXCIpXG4gICAgcHJvY2Vzcy5leGl0KDEpXG4gIH1cblxuICBpZiAoY3JlYXRlSXNzdWUgJiYgaXNSZWJhc2luZykge1xuICAgIGNvbnNvbGUubG9nKFwiLS1jcmVhdGUtaXNzdWUgaXMgbm90IGNvbXBhdGlibGUgd2l0aCByZWJhc2luZy5cIilcbiAgICBwcm9jZXNzLmV4aXQoMSlcbiAgfVxuXG4gIGNvbnN0IG51bVBhdGNoZXNBZnRlckNyZWF0ZSA9XG4gICAgbW9kZS50eXBlID09PSBcImFwcGVuZFwiIHx8IGV4aXN0aW5nUGF0Y2hlcy5sZW5ndGggPT09IDBcbiAgICAgID8gZXhpc3RpbmdQYXRjaGVzLmxlbmd0aCArIDFcbiAgICAgIDogZXhpc3RpbmdQYXRjaGVzLmxlbmd0aFxuICBjb25zdCB2Y3MgPSBnZXRQYWNrYWdlVkNTRGV0YWlscyhwYWNrYWdlRGV0YWlscylcbiAgY29uc3QgY2FuQ3JlYXRlSXNzdWUgPVxuICAgICFpc1JlYmFzaW5nICYmXG4gICAgc2hvdWxkUmVjb21tZW5kSXNzdWUodmNzKSAmJlxuICAgIG51bVBhdGNoZXNBZnRlckNyZWF0ZSA9PT0gMSAmJlxuICAgIG1vZGUudHlwZSAhPT0gXCJhcHBlbmRcIlxuXG4gIGNvbnN0IGFwcFBhY2thZ2VKc29uID0gcmVxdWlyZShqb2luKGFwcFBhdGgsIFwicGFja2FnZS5qc29uXCIpKVxuICBjb25zdCBwYWNrYWdlUGF0aCA9IGpvaW4oYXBwUGF0aCwgcGFja2FnZURldGFpbHMucGF0aClcbiAgY29uc3QgcGFja2FnZUpzb25QYXRoID0gam9pbihwYWNrYWdlUGF0aCwgXCJwYWNrYWdlLmpzb25cIilcblxuICBpZiAoIWV4aXN0c1N5bmMocGFja2FnZUpzb25QYXRoKSkge1xuICAgIHByaW50Tm9QYWNrYWdlRm91bmRFcnJvcihwYWNrYWdlUGF0aFNwZWNpZmllciwgcGFja2FnZUpzb25QYXRoKVxuICAgIHByb2Nlc3MuZXhpdCgxKVxuICB9XG5cbiAgY29uc3QgdG1wUmVwbyA9IGRpclN5bmMoeyB1bnNhZmVDbGVhbnVwOiB0cnVlIH0pXG4gIGNvbnN0IHRtcFJlcG9QYWNrYWdlUGF0aCA9IGpvaW4odG1wUmVwby5uYW1lLCBwYWNrYWdlRGV0YWlscy5wYXRoKVxuICBjb25zdCB0bXBSZXBvTnBtUm9vdCA9IHRtcFJlcG9QYWNrYWdlUGF0aC5zbGljZShcbiAgICAwLFxuICAgIC1gL25vZGVfbW9kdWxlcy8ke3BhY2thZ2VEZXRhaWxzLm5hbWV9YC5sZW5ndGgsXG4gIClcblxuICBjb25zdCB0bXBSZXBvUGFja2FnZUpzb25QYXRoID0gam9pbih0bXBSZXBvTnBtUm9vdCwgXCJwYWNrYWdlLmpzb25cIilcblxuICB0cnkge1xuICAgIGNvbnN0IHBhdGNoZXNEaXIgPSByZXNvbHZlKGpvaW4oYXBwUGF0aCwgcGF0Y2hEaXIpKVxuXG4gICAgY29uc29sZS5pbmZvKGNoYWxrLmdyZXkoXCLigKJcIiksIFwiQ3JlYXRpbmcgdGVtcG9yYXJ5IGZvbGRlclwiKVxuXG4gICAgLy8gbWFrZSBhIGJsYW5rIHBhY2thZ2UuanNvblxuICAgIG1rZGlycFN5bmModG1wUmVwb05wbVJvb3QpXG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIHRtcFJlcG9QYWNrYWdlSnNvblBhdGgsXG4gICAgICBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGRlcGVuZGVuY2llczoge1xuICAgICAgICAgIFtwYWNrYWdlRGV0YWlscy5uYW1lXTogZ2V0UGFja2FnZVJlc29sdXRpb24oe1xuICAgICAgICAgICAgcGFja2FnZURldGFpbHMsXG4gICAgICAgICAgICBwYWNrYWdlTWFuYWdlcixcbiAgICAgICAgICAgIGFwcFBhdGgsXG4gICAgICAgICAgfSksXG4gICAgICAgIH0sXG4gICAgICAgIHJlc29sdXRpb25zOiByZXNvbHZlUmVsYXRpdmVGaWxlRGVwZW5kZW5jaWVzKFxuICAgICAgICAgIGFwcFBhdGgsXG4gICAgICAgICAgYXBwUGFja2FnZUpzb24ucmVzb2x1dGlvbnMgfHwge30sXG4gICAgICAgICksXG4gICAgICB9KSxcbiAgICApXG5cbiAgICBjb25zdCBwYWNrYWdlVmVyc2lvbiA9IGdldFBhY2thZ2VWZXJzaW9uKFxuICAgICAgam9pbihyZXNvbHZlKHBhY2thZ2VEZXRhaWxzLnBhdGgpLCBcInBhY2thZ2UuanNvblwiKSxcbiAgICApXG5cbiAgICAvLyBjb3B5IC5ucG1yYy8ueWFybnJjIGluIGNhc2UgcGFja2FnZXMgYXJlIGhvc3RlZCBpbiBwcml2YXRlIHJlZ2lzdHJ5XG4gICAgLy8gY29weSAueWFybiBkaXJlY3RvcnkgYXMgd2VsbCB0byBlbnN1cmUgaW5zdGFsbGF0aW9ucyB3b3JrIGluIHlhcm4gMlxuICAgIC8vIHRzbGludDpkaXNhYmxlLW5leHQtbGluZTphbGlnblxuICAgIDtbXCIubnBtcmNcIiwgXCIueWFybnJjXCIsIFwiLnlhcm5cIl0uZm9yRWFjaCgocmNGaWxlKSA9PiB7XG4gICAgICBjb25zdCByY1BhdGggPSBqb2luKGFwcFBhdGgsIHJjRmlsZSlcbiAgICAgIGlmIChleGlzdHNTeW5jKHJjUGF0aCkpIHtcbiAgICAgICAgY29weVN5bmMocmNQYXRoLCBqb2luKHRtcFJlcG8ubmFtZSwgcmNGaWxlKSwgeyBkZXJlZmVyZW5jZTogdHJ1ZSB9KVxuICAgICAgfVxuICAgIH0pXG5cbiAgICBpZiAocGFja2FnZU1hbmFnZXIgPT09IFwieWFyblwiKSB7XG4gICAgICBjb25zb2xlLmluZm8oXG4gICAgICAgIGNoYWxrLmdyZXkoXCLigKJcIiksXG4gICAgICAgIGBJbnN0YWxsaW5nICR7cGFja2FnZURldGFpbHMubmFtZX1AJHtwYWNrYWdlVmVyc2lvbn0gd2l0aCB5YXJuYCxcbiAgICAgIClcbiAgICAgIHRyeSB7XG4gICAgICAgIC8vIHRyeSBmaXJzdCB3aXRob3V0IGlnbm9yaW5nIHNjcmlwdHMgaW4gY2FzZSB0aGV5IGFyZSByZXF1aXJlZFxuICAgICAgICAvLyB0aGlzIHdvcmtzIGluIDk5Ljk5JSBvZiBjYXNlc1xuICAgICAgICBzcGF3blNhZmVTeW5jKGB5YXJuYCwgW1wiaW5zdGFsbFwiLCBcIi0taWdub3JlLWVuZ2luZXNcIl0sIHtcbiAgICAgICAgICBjd2Q6IHRtcFJlcG9OcG1Sb290LFxuICAgICAgICAgIGxvZ1N0ZEVyck9uRXJyb3I6IGZhbHNlLFxuICAgICAgICB9KVxuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAvLyB0cnkgYWdhaW4gd2hpbGUgaWdub3Jpbmcgc2NyaXB0cyBpbiBjYXNlIHRoZSBzY3JpcHQgZGVwZW5kcyBvblxuICAgICAgICAvLyBhbiBpbXBsaWNpdCBjb250ZXh0IHdoaWNoIHdlIGhhdmVuJ3QgcmVwcm9kdWNlZFxuICAgICAgICBzcGF3blNhZmVTeW5jKFxuICAgICAgICAgIGB5YXJuYCxcbiAgICAgICAgICBbXCJpbnN0YWxsXCIsIFwiLS1pZ25vcmUtZW5naW5lc1wiLCBcIi0taWdub3JlLXNjcmlwdHNcIl0sXG4gICAgICAgICAge1xuICAgICAgICAgICAgY3dkOiB0bXBSZXBvTnBtUm9vdCxcbiAgICAgICAgICB9LFxuICAgICAgICApXG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnNvbGUuaW5mbyhcbiAgICAgICAgY2hhbGsuZ3JleShcIuKAolwiKSxcbiAgICAgICAgYEluc3RhbGxpbmcgJHtwYWNrYWdlRGV0YWlscy5uYW1lfUAke3BhY2thZ2VWZXJzaW9ufSB3aXRoIG5wbWAsXG4gICAgICApXG4gICAgICB0cnkge1xuICAgICAgICAvLyB0cnkgZmlyc3Qgd2l0aG91dCBpZ25vcmluZyBzY3JpcHRzIGluIGNhc2UgdGhleSBhcmUgcmVxdWlyZWRcbiAgICAgICAgLy8gdGhpcyB3b3JrcyBpbiA5OS45OSUgb2YgY2FzZXNcbiAgICAgICAgc3Bhd25TYWZlU3luYyhgbnBtYCwgW1wiaVwiLCBcIi0tZm9yY2VcIl0sIHtcbiAgICAgICAgICBjd2Q6IHRtcFJlcG9OcG1Sb290LFxuICAgICAgICAgIGxvZ1N0ZEVyck9uRXJyb3I6IGZhbHNlLFxuICAgICAgICAgIHN0ZGlvOiBcImlnbm9yZVwiLFxuICAgICAgICB9KVxuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAvLyB0cnkgYWdhaW4gd2hpbGUgaWdub3Jpbmcgc2NyaXB0cyBpbiBjYXNlIHRoZSBzY3JpcHQgZGVwZW5kcyBvblxuICAgICAgICAvLyBhbiBpbXBsaWNpdCBjb250ZXh0IHdoaWNoIHdlIGhhdmVuJ3QgcmVwcm9kdWNlZFxuICAgICAgICBzcGF3blNhZmVTeW5jKGBucG1gLCBbXCJpXCIsIFwiLS1pZ25vcmUtc2NyaXB0c1wiLCBcIi0tZm9yY2VcIl0sIHtcbiAgICAgICAgICBjd2Q6IHRtcFJlcG9OcG1Sb290LFxuICAgICAgICAgIHN0ZGlvOiBcImlnbm9yZVwiLFxuICAgICAgICB9KVxuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IGdpdCA9ICguLi5hcmdzOiBzdHJpbmdbXSkgPT5cbiAgICAgIHNwYXduU2FmZVN5bmMoXCJnaXRcIiwgYXJncywge1xuICAgICAgICBjd2Q6IHRtcFJlcG8ubmFtZSxcbiAgICAgICAgZW52OiB7IC4uLnByb2Nlc3MuZW52LCBIT01FOiB0bXBSZXBvLm5hbWUgfSxcbiAgICAgICAgbWF4QnVmZmVyOiAxMDI0ICogMTAyNCAqIDEwMCxcbiAgICAgIH0pXG5cbiAgICAvLyByZW1vdmUgbmVzdGVkIG5vZGVfbW9kdWxlcyBqdXN0IHRvIGJlIHNhZmVcbiAgICByaW1yYWYoam9pbih0bXBSZXBvUGFja2FnZVBhdGgsIFwibm9kZV9tb2R1bGVzXCIpKVxuICAgIC8vIHJlbW92ZSAuZ2l0IGp1c3QgdG8gYmUgc2FmZVxuICAgIHJpbXJhZihqb2luKHRtcFJlcG9QYWNrYWdlUGF0aCwgXCIuZ2l0XCIpKVxuICAgIC8vIHJlbW92ZSBwYXRjaC1wYWNrYWdlIHN0YXRlIGZpbGVcbiAgICByaW1yYWYoam9pbih0bXBSZXBvUGFja2FnZVBhdGgsIFNUQVRFX0ZJTEVfTkFNRSkpXG5cbiAgICAvLyBjb21taXQgdGhlIHBhY2thZ2VcbiAgICBjb25zb2xlLmluZm8oY2hhbGsuZ3JleShcIuKAolwiKSwgXCJEaWZmaW5nIHlvdXIgZmlsZXMgd2l0aCBjbGVhbiBmaWxlc1wiKVxuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0bXBSZXBvLm5hbWUsIFwiLmdpdGlnbm9yZVwiKSwgXCIhL25vZGVfbW9kdWxlc1xcblxcblwiKVxuICAgIGdpdChcImluaXRcIilcbiAgICBnaXQoXCJjb25maWdcIiwgXCItLWxvY2FsXCIsIFwidXNlci5uYW1lXCIsIFwicGF0Y2gtcGFja2FnZVwiKVxuICAgIGdpdChcImNvbmZpZ1wiLCBcIi0tbG9jYWxcIiwgXCJ1c2VyLmVtYWlsXCIsIFwicGF0Y2hAcGFjay5hZ2VcIilcblxuICAgIC8vIHJlbW92ZSBpZ25vcmVkIGZpbGVzIGZpcnN0XG4gICAgcmVtb3ZlSWdub3JlZEZpbGVzKHRtcFJlcG9QYWNrYWdlUGF0aCwgaW5jbHVkZVBhdGhzLCBleGNsdWRlUGF0aHMpXG5cbiAgICBmb3IgKGNvbnN0IHBhdGNoRGV0YWlscyBvZiBwYXRjaGVzVG9BcHBseUJlZm9yZURpZmZpbmcpIHtcbiAgICAgIGlmIChcbiAgICAgICAgIWFwcGx5UGF0Y2goe1xuICAgICAgICAgIHBhdGNoRGV0YWlscyxcbiAgICAgICAgICBwYXRjaERpcixcbiAgICAgICAgICBwYXRjaEZpbGVQYXRoOiBqb2luKGFwcFBhdGgsIHBhdGNoRGlyLCBwYXRjaERldGFpbHMucGF0Y2hGaWxlbmFtZSksXG4gICAgICAgICAgcmV2ZXJzZTogZmFsc2UsXG4gICAgICAgICAgY3dkOiB0bXBSZXBvLm5hbWUsXG4gICAgICAgICAgYmVzdEVmZm9ydDogZmFsc2UsXG4gICAgICAgIH0pXG4gICAgICApIHtcbiAgICAgICAgLy8gVE9ETzogYWRkIGJldHRlciBlcnJvciBtZXNzYWdlIG9uY2UgLS1yZWJhc2UgaXMgaW1wbGVtZW50ZWRcbiAgICAgICAgY29uc29sZS5sb2coXG4gICAgICAgICAgYEZhaWxlZCB0byBhcHBseSBwYXRjaCAke3BhdGNoRGV0YWlscy5wYXRjaEZpbGVuYW1lfSB0byAke3BhY2thZ2VEZXRhaWxzLnBhdGhTcGVjaWZpZXJ9YCxcbiAgICAgICAgKVxuICAgICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICAgIH1cbiAgICB9XG4gICAgZ2l0KFwiYWRkXCIsIFwiLWZcIiwgcGFja2FnZURldGFpbHMucGF0aClcbiAgICBnaXQoXCJjb21taXRcIiwgXCItLWFsbG93LWVtcHR5XCIsIFwiLW1cIiwgXCJpbml0XCIpXG5cbiAgICAvLyByZXBsYWNlIHBhY2thZ2Ugd2l0aCB1c2VyJ3MgdmVyc2lvblxuICAgIHJpbXJhZih0bXBSZXBvUGFja2FnZVBhdGgpXG5cbiAgICAvLyBwbnBtIGluc3RhbGxzIHBhY2thZ2VzIGFzIHN5bWxpbmtzLCBjb3B5U3luYyB3b3VsZCBjb3B5IG9ubHkgdGhlIHN5bWxpbmtcbiAgICBjb3B5U3luYyhyZWFscGF0aFN5bmMocGFja2FnZVBhdGgpLCB0bXBSZXBvUGFja2FnZVBhdGgpXG5cbiAgICAvLyByZW1vdmUgbmVzdGVkIG5vZGVfbW9kdWxlcyBqdXN0IHRvIGJlIHNhZmVcbiAgICByaW1yYWYoam9pbih0bXBSZXBvUGFja2FnZVBhdGgsIFwibm9kZV9tb2R1bGVzXCIpKVxuICAgIC8vIHJlbW92ZSAuZ2l0IGp1c3QgdG8gYmUgc2FmZVxuICAgIHJpbXJhZihqb2luKHRtcFJlcG9QYWNrYWdlUGF0aCwgXCIuZ2l0XCIpKVxuICAgIC8vIHJlbW92ZSBwYXRjaC1wYWNrYWdlIHN0YXRlIGZpbGVcbiAgICByaW1yYWYoam9pbih0bXBSZXBvUGFja2FnZVBhdGgsIFNUQVRFX0ZJTEVfTkFNRSkpXG5cbiAgICAvLyBhbHNvIHJlbW92ZSBpZ25vcmVkIGZpbGVzIGxpa2UgYmVmb3JlXG4gICAgcmVtb3ZlSWdub3JlZEZpbGVzKHRtcFJlcG9QYWNrYWdlUGF0aCwgaW5jbHVkZVBhdGhzLCBleGNsdWRlUGF0aHMpXG5cbiAgICAvLyBzdGFnZSBhbGwgZmlsZXNcbiAgICBnaXQoXCJhZGRcIiwgXCItZlwiLCBwYWNrYWdlRGV0YWlscy5wYXRoKVxuXG4gICAgLy8gZ2V0IGRpZmYgb2YgY2hhbmdlc1xuICAgIGNvbnN0IGRpZmZSZXN1bHQgPSBnaXQoXG4gICAgICBcImRpZmZcIixcbiAgICAgIFwiLS1jYWNoZWRcIixcbiAgICAgIFwiLS1uby1jb2xvclwiLFxuICAgICAgXCItLWlnbm9yZS1zcGFjZS1hdC1lb2xcIixcbiAgICAgIFwiLS1uby1leHQtZGlmZlwiLFxuICAgICAgXCItLXNyYy1wcmVmaXg9YS9cIixcbiAgICAgIFwiLS1kc3QtcHJlZml4PWIvXCIsXG4gICAgKVxuXG4gICAgaWYgKGRpZmZSZXN1bHQuc3Rkb3V0Lmxlbmd0aCA9PT0gMCkge1xuICAgICAgY29uc29sZS5sb2coXG4gICAgICAgIGDigYnvuI8gIE5vdCBjcmVhdGluZyBwYXRjaCBmaWxlIGZvciBwYWNrYWdlICcke3BhY2thZ2VQYXRoU3BlY2lmaWVyfSdgLFxuICAgICAgKVxuICAgICAgY29uc29sZS5sb2coYOKBie+4jyAgVGhlcmUgZG9uJ3QgYXBwZWFyIHRvIGJlIGFueSBjaGFuZ2VzLmApXG4gICAgICBpZiAoaXNSZWJhc2luZyAmJiBtb2RlLnR5cGUgPT09IFwib3ZlcndyaXRlX2xhc3RcIikge1xuICAgICAgICBjb25zb2xlLmxvZyhcbiAgICAgICAgICBcIlxcbvCfkqEgVG8gcmVtb3ZlIGEgcGF0Y2ggZmlsZSwgZGVsZXRlIGl0IGFuZCB0aGVuIHJlaW5zdGFsbCBub2RlX21vZHVsZXMgZnJvbSBzY3JhdGNoLlwiLFxuICAgICAgICApXG4gICAgICB9XG4gICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIHRyeSB7XG4gICAgICBwYXJzZVBhdGNoRmlsZShkaWZmUmVzdWx0LnN0ZG91dC50b1N0cmluZygpKVxuICAgIH0gY2F0Y2ggKGU6IGFueSkge1xuICAgICAgaWYgKFxuICAgICAgICAoZSBhcyBFcnJvcikubWVzc2FnZS5pbmNsdWRlcyhcIlVuZXhwZWN0ZWQgZmlsZSBtb2RlIHN0cmluZzogMTIwMDAwXCIpXG4gICAgICApIHtcbiAgICAgICAgY29uc29sZS5sb2coYFxu4puU77iPICR7Y2hhbGsucmVkLmJvbGQoXCJFUlJPUlwiKX1cblxuICBZb3VyIGNoYW5nZXMgaW52b2x2ZSBjcmVhdGluZyBzeW1saW5rcy4gcGF0Y2gtcGFja2FnZSBkb2VzIG5vdCB5ZXQgc3VwcG9ydFxuICBzeW1saW5rcy5cbiAgXG4gIO+4j1BsZWFzZSB1c2UgJHtjaGFsay5ib2xkKFwiLS1pbmNsdWRlXCIpfSBhbmQvb3IgJHtjaGFsay5ib2xkKFxuICAgICAgICAgIFwiLS1leGNsdWRlXCIsXG4gICAgICAgICl9IHRvIG5hcnJvdyB0aGUgc2NvcGUgb2YgeW91ciBwYXRjaCBpZlxuICB0aGlzIHdhcyB1bmludGVudGlvbmFsLlxuYClcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnN0IG91dFBhdGggPSBcIi4vcGF0Y2gtcGFja2FnZS1lcnJvci5qc29uLmd6XCJcbiAgICAgICAgd3JpdGVGaWxlU3luYyhcbiAgICAgICAgICBvdXRQYXRoLFxuICAgICAgICAgIGd6aXBTeW5jKFxuICAgICAgICAgICAgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgICAgICBlcnJvcjogeyBtZXNzYWdlOiBlLm1lc3NhZ2UsIHN0YWNrOiBlLnN0YWNrIH0sXG4gICAgICAgICAgICAgIHBhdGNoOiBkaWZmUmVzdWx0LnN0ZG91dC50b1N0cmluZygpLFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgKSxcbiAgICAgICAgKVxuICAgICAgICBjb25zb2xlLmxvZyhgXG7im5TvuI8gJHtjaGFsay5yZWQuYm9sZChcIkVSUk9SXCIpfVxuICAgICAgICBcbiAgcGF0Y2gtcGFja2FnZSB3YXMgdW5hYmxlIHRvIHJlYWQgdGhlIHBhdGNoLWZpbGUgbWFkZSBieSBnaXQuIFRoaXMgc2hvdWxkIG5vdFxuICBoYXBwZW4uXG4gIFxuICBBIGRpYWdub3N0aWMgZmlsZSB3YXMgd3JpdHRlbiB0b1xuICBcbiAgICAke291dFBhdGh9XG4gIFxuICBQbGVhc2UgYXR0YWNoIGl0IHRvIGEgZ2l0aHViIGlzc3VlXG4gIFxuICAgIGh0dHBzOi8vZ2l0aHViLmNvbS9kczMwMC9wYXRjaC1wYWNrYWdlL2lzc3Vlcy9uZXc/dGl0bGU9TmV3K3BhdGNoK3BhcnNlK2ZhaWxlZCZib2R5PVBsZWFzZSthdHRhY2grdGhlK2RpYWdub3N0aWMrZmlsZStieStkcmFnZ2luZytpdCtpbnRvK2hlcmUr8J+Zj1xuICBcbiAgTm90ZSB0aGF0IHRoaXMgZGlhZ25vc3RpYyBmaWxlIHdpbGwgY29udGFpbiBjb2RlIGZyb20gdGhlIHBhY2thZ2UgeW91IHdlcmVcbiAgYXR0ZW1wdGluZyB0byBwYXRjaC5cblxuYClcbiAgICAgIH1cbiAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgLy8gbWF5YmUgZGVsZXRlIGV4aXN0aW5nXG4gICAgaWYgKG1vZGUudHlwZSA9PT0gXCJhcHBlbmRcIiAmJiAhaXNSZWJhc2luZyAmJiBleGlzdGluZ1BhdGNoZXMubGVuZ3RoID09PSAxKSB7XG4gICAgICAvLyBpZiB3ZSBhcmUgYXBwZW5kaW5nIHRvIGFuIGV4aXN0aW5nIHBhdGNoIHRoYXQgZG9lc24ndCBoYXZlIGEgc2VxdWVuY2UgbnVtYmVyIGxldCdzIHJlbmFtZSBpdFxuICAgICAgY29uc3QgcHJldlBhdGNoID0gZXhpc3RpbmdQYXRjaGVzWzBdXG4gICAgICBpZiAocHJldlBhdGNoLnNlcXVlbmNlTnVtYmVyID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgY29uc3QgbmV3RmlsZU5hbWUgPSBjcmVhdGVQYXRjaEZpbGVOYW1lKHtcbiAgICAgICAgICBwYWNrYWdlRGV0YWlscyxcbiAgICAgICAgICBwYWNrYWdlVmVyc2lvbixcbiAgICAgICAgICBzZXF1ZW5jZU51bWJlcjogMSxcbiAgICAgICAgICBzZXF1ZW5jZU5hbWU6IHByZXZQYXRjaC5zZXF1ZW5jZU5hbWUgPz8gXCJpbml0aWFsXCIsXG4gICAgICAgIH0pXG4gICAgICAgIGNvbnN0IG9sZFBhdGggPSBqb2luKGFwcFBhdGgsIHBhdGNoRGlyLCBwcmV2UGF0Y2gucGF0Y2hGaWxlbmFtZSlcbiAgICAgICAgY29uc3QgbmV3UGF0aCA9IGpvaW4oYXBwUGF0aCwgcGF0Y2hEaXIsIG5ld0ZpbGVOYW1lKVxuICAgICAgICByZW5hbWVTeW5jKG9sZFBhdGgsIG5ld1BhdGgpXG4gICAgICAgIHByZXZQYXRjaC5zZXF1ZW5jZU51bWJlciA9IDFcbiAgICAgICAgcHJldlBhdGNoLnBhdGNoRmlsZW5hbWUgPSBuZXdGaWxlTmFtZVxuICAgICAgICBwcmV2UGF0Y2guc2VxdWVuY2VOYW1lID0gcHJldlBhdGNoLnNlcXVlbmNlTmFtZSA/PyBcImluaXRpYWxcIlxuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IGxhc3RQYXRjaCA9IGV4aXN0aW5nUGF0Y2hlc1tcbiAgICAgIHN0YXRlID8gc3RhdGUucGF0Y2hlcy5sZW5ndGggLSAxIDogZXhpc3RpbmdQYXRjaGVzLmxlbmd0aCAtIDFcbiAgICBdIGFzIFBhdGNoZWRQYWNrYWdlRGV0YWlscyB8IHVuZGVmaW5lZFxuICAgIGNvbnN0IHNlcXVlbmNlTmFtZSA9XG4gICAgICBtb2RlLnR5cGUgPT09IFwiYXBwZW5kXCIgPyBtb2RlLm5hbWUgOiBsYXN0UGF0Y2g/LnNlcXVlbmNlTmFtZVxuICAgIGNvbnN0IHNlcXVlbmNlTnVtYmVyID1cbiAgICAgIG1vZGUudHlwZSA9PT0gXCJhcHBlbmRcIlxuICAgICAgICA/IChsYXN0UGF0Y2g/LnNlcXVlbmNlTnVtYmVyID8/IDApICsgMVxuICAgICAgICA6IGxhc3RQYXRjaD8uc2VxdWVuY2VOdW1iZXJcblxuICAgIGNvbnN0IHBhdGNoRmlsZU5hbWUgPSBjcmVhdGVQYXRjaEZpbGVOYW1lKHtcbiAgICAgIHBhY2thZ2VEZXRhaWxzLFxuICAgICAgcGFja2FnZVZlcnNpb24sXG4gICAgICBzZXF1ZW5jZU5hbWUsXG4gICAgICBzZXF1ZW5jZU51bWJlcixcbiAgICB9KVxuXG4gICAgY29uc3QgcGF0Y2hQYXRoID0gam9pbihwYXRjaGVzRGlyLCBwYXRjaEZpbGVOYW1lKVxuICAgIGlmICghZXhpc3RzU3luYyhkaXJuYW1lKHBhdGNoUGF0aCkpKSB7XG4gICAgICAvLyBzY29wZWQgcGFja2FnZVxuICAgICAgbWtkaXJTeW5jKGRpcm5hbWUocGF0Y2hQYXRoKSlcbiAgICB9XG5cbiAgICAvLyBpZiB3ZSBhcmUgaW5zZXJ0aW5nIGEgbmV3IHBhdGNoIGludG8gYSBzZXF1ZW5jZSB3ZSBtb3N0IGxpa2VseSBuZWVkIHRvIHVwZGF0ZSB0aGUgc2VxdWVuY2UgbnVtYmVyc1xuICAgIGlmIChpc1JlYmFzaW5nICYmIG1vZGUudHlwZSA9PT0gXCJhcHBlbmRcIikge1xuICAgICAgY29uc3QgcGF0Y2hlc1RvTnVkZ2UgPSBleGlzdGluZ1BhdGNoZXMuc2xpY2Uoc3RhdGUhLnBhdGNoZXMubGVuZ3RoKVxuICAgICAgaWYgKHNlcXVlbmNlTnVtYmVyID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwic2VxdWVuY2VOdW1iZXIgaXMgdW5kZWZpbmVkIHdoaWxlIHJlYmFzaW5nXCIpXG4gICAgICB9XG4gICAgICBpZiAoXG4gICAgICAgIHBhdGNoZXNUb051ZGdlWzBdPy5zZXF1ZW5jZU51bWJlciAhPT0gdW5kZWZpbmVkICYmXG4gICAgICAgIHBhdGNoZXNUb051ZGdlWzBdLnNlcXVlbmNlTnVtYmVyIDw9IHNlcXVlbmNlTnVtYmVyXG4gICAgICApIHtcbiAgICAgICAgbGV0IG5leHQgPSBzZXF1ZW5jZU51bWJlciArIDFcbiAgICAgICAgZm9yIChjb25zdCBwIG9mIHBhdGNoZXNUb051ZGdlKSB7XG4gICAgICAgICAgY29uc3QgbmV3TmFtZSA9IGNyZWF0ZVBhdGNoRmlsZU5hbWUoe1xuICAgICAgICAgICAgcGFja2FnZURldGFpbHMsXG4gICAgICAgICAgICBwYWNrYWdlVmVyc2lvbixcbiAgICAgICAgICAgIHNlcXVlbmNlTmFtZTogcC5zZXF1ZW5jZU5hbWUsXG4gICAgICAgICAgICBzZXF1ZW5jZU51bWJlcjogbmV4dCsrLFxuICAgICAgICAgIH0pXG4gICAgICAgICAgY29uc29sZS5sb2coXG4gICAgICAgICAgICBcIlJlbmFtaW5nXCIsXG4gICAgICAgICAgICBjaGFsay5ib2xkKHAucGF0Y2hGaWxlbmFtZSksXG4gICAgICAgICAgICBcInRvXCIsXG4gICAgICAgICAgICBjaGFsay5ib2xkKG5ld05hbWUpLFxuICAgICAgICAgIClcbiAgICAgICAgICBjb25zdCBvbGRQYXRoID0gam9pbihhcHBQYXRoLCBwYXRjaERpciwgcC5wYXRjaEZpbGVuYW1lKVxuICAgICAgICAgIGNvbnN0IG5ld1BhdGggPSBqb2luKGFwcFBhdGgsIHBhdGNoRGlyLCBuZXdOYW1lKVxuICAgICAgICAgIHJlbmFtZVN5bmMob2xkUGF0aCwgbmV3UGF0aClcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIHdyaXRlRmlsZVN5bmMocGF0Y2hQYXRoLCBkaWZmUmVzdWx0LnN0ZG91dClcbiAgICBjb25zb2xlLmxvZyhcbiAgICAgIGAke2NoYWxrLmdyZWVuKFwi4pyUXCIpfSBDcmVhdGVkIGZpbGUgJHtqb2luKHBhdGNoRGlyLCBwYXRjaEZpbGVOYW1lKX1cXG5gLFxuICAgIClcblxuICAgIGNvbnN0IHByZXZTdGF0ZTogUGF0Y2hTdGF0ZVtdID0gcGF0Y2hlc1RvQXBwbHlCZWZvcmVEaWZmaW5nLm1hcChcbiAgICAgIChwKTogUGF0Y2hTdGF0ZSA9PiAoe1xuICAgICAgICBwYXRjaEZpbGVuYW1lOiBwLnBhdGNoRmlsZW5hbWUsXG4gICAgICAgIGRpZEFwcGx5OiB0cnVlLFxuICAgICAgICBwYXRjaENvbnRlbnRIYXNoOiBoYXNoRmlsZShqb2luKGFwcFBhdGgsIHBhdGNoRGlyLCBwLnBhdGNoRmlsZW5hbWUpKSxcbiAgICAgIH0pLFxuICAgIClcbiAgICBjb25zdCBuZXh0U3RhdGU6IFBhdGNoU3RhdGVbXSA9IFtcbiAgICAgIC4uLnByZXZTdGF0ZSxcbiAgICAgIHtcbiAgICAgICAgcGF0Y2hGaWxlbmFtZTogcGF0Y2hGaWxlTmFtZSxcbiAgICAgICAgZGlkQXBwbHk6IHRydWUsXG4gICAgICAgIHBhdGNoQ29udGVudEhhc2g6IGhhc2hGaWxlKHBhdGNoUGF0aCksXG4gICAgICB9LFxuICAgIF1cblxuICAgIC8vIGlmIGFueSBwYXRjaGVzIGNvbWUgYWZ0ZXIgdGhpcyBvbmUgd2UganVzdCBtYWRlLCB3ZSBzaG91bGQgcmVhcHBseSB0aGVtXG4gICAgbGV0IGRpZEZhaWxXaGlsZUZpbmlzaGluZ1JlYmFzZSA9IGZhbHNlXG4gICAgaWYgKGlzUmViYXNpbmcpIHtcbiAgICAgIGNvbnN0IGN1cnJlbnRQYXRjaGVzID0gZ2V0R3JvdXBlZFBhdGNoZXMoam9pbihhcHBQYXRoLCBwYXRjaERpcikpXG4gICAgICAgIC5wYXRoU3BlY2lmaWVyVG9QYXRjaEZpbGVzW3BhY2thZ2VEZXRhaWxzLnBhdGhTcGVjaWZpZXJdXG5cbiAgICAgIGNvbnN0IHByZXZpb3VzbHlVbmFwcGxpZWRQYXRjaGVzID0gY3VycmVudFBhdGNoZXMuc2xpY2UobmV4dFN0YXRlLmxlbmd0aClcbiAgICAgIGlmIChwcmV2aW91c2x5VW5hcHBsaWVkUGF0Y2hlcy5sZW5ndGgpIHtcbiAgICAgICAgY29uc29sZS5sb2coYEZhc3QgZm9yd2FyZGluZy4uLmApXG4gICAgICAgIGZvciAoY29uc3QgcGF0Y2ggb2YgcHJldmlvdXNseVVuYXBwbGllZFBhdGNoZXMpIHtcbiAgICAgICAgICBjb25zdCBwYXRjaEZpbGVQYXRoID0gam9pbihhcHBQYXRoLCBwYXRjaERpciwgcGF0Y2gucGF0Y2hGaWxlbmFtZSlcbiAgICAgICAgICBpZiAoXG4gICAgICAgICAgICAhYXBwbHlQYXRjaCh7XG4gICAgICAgICAgICAgIHBhdGNoRGV0YWlsczogcGF0Y2gsXG4gICAgICAgICAgICAgIHBhdGNoRGlyLFxuICAgICAgICAgICAgICBwYXRjaEZpbGVQYXRoLFxuICAgICAgICAgICAgICByZXZlcnNlOiBmYWxzZSxcbiAgICAgICAgICAgICAgY3dkOiBwcm9jZXNzLmN3ZCgpLFxuICAgICAgICAgICAgICBiZXN0RWZmb3J0OiBmYWxzZSxcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgKSB7XG4gICAgICAgICAgICBkaWRGYWlsV2hpbGVGaW5pc2hpbmdSZWJhc2UgPSB0cnVlXG4gICAgICAgICAgICBsb2dQYXRjaFNlcXVlbmNlRXJyb3IoeyBwYXRjaERldGFpbHM6IHBhdGNoIH0pXG4gICAgICAgICAgICBuZXh0U3RhdGUucHVzaCh7XG4gICAgICAgICAgICAgIHBhdGNoRmlsZW5hbWU6IHBhdGNoLnBhdGNoRmlsZW5hbWUsXG4gICAgICAgICAgICAgIGRpZEFwcGx5OiBmYWxzZSxcbiAgICAgICAgICAgICAgcGF0Y2hDb250ZW50SGFzaDogaGFzaEZpbGUocGF0Y2hGaWxlUGF0aCksXG4gICAgICAgICAgICB9KVxuICAgICAgICAgICAgYnJlYWtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY29uc29sZS5sb2coYCAgJHtjaGFsay5ncmVlbihcIuKclFwiKX0gJHtwYXRjaC5wYXRjaEZpbGVuYW1lfWApXG4gICAgICAgICAgICBuZXh0U3RhdGUucHVzaCh7XG4gICAgICAgICAgICAgIHBhdGNoRmlsZW5hbWU6IHBhdGNoLnBhdGNoRmlsZW5hbWUsXG4gICAgICAgICAgICAgIGRpZEFwcGx5OiB0cnVlLFxuICAgICAgICAgICAgICBwYXRjaENvbnRlbnRIYXNoOiBoYXNoRmlsZShwYXRjaEZpbGVQYXRoKSxcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGlzUmViYXNpbmcgfHwgbnVtUGF0Y2hlc0FmdGVyQ3JlYXRlID4gMSkge1xuICAgICAgc2F2ZVBhdGNoQXBwbGljYXRpb25TdGF0ZSh7XG4gICAgICAgIHBhY2thZ2VEZXRhaWxzLFxuICAgICAgICBwYXRjaGVzOiBuZXh0U3RhdGUsXG4gICAgICAgIGlzUmViYXNpbmc6IGRpZEZhaWxXaGlsZUZpbmlzaGluZ1JlYmFzZSxcbiAgICAgIH0pXG4gICAgfSBlbHNlIHtcbiAgICAgIGNsZWFyUGF0Y2hBcHBsaWNhdGlvblN0YXRlKHBhY2thZ2VEZXRhaWxzKVxuICAgIH1cblxuICAgIGlmIChjYW5DcmVhdGVJc3N1ZSkge1xuICAgICAgaWYgKGNyZWF0ZUlzc3VlKSB7XG4gICAgICAgIG9wZW5Jc3N1ZUNyZWF0aW9uTGluayh7XG4gICAgICAgICAgcGFja2FnZURldGFpbHMsXG4gICAgICAgICAgcGF0Y2hGaWxlQ29udGVudHM6IGRpZmZSZXN1bHQuc3Rkb3V0LnRvU3RyaW5nKCksXG4gICAgICAgICAgcGFja2FnZVZlcnNpb24sXG4gICAgICAgIH0pXG4gICAgICB9IGVsc2Uge1xuICAgICAgICBtYXliZVByaW50SXNzdWVDcmVhdGlvblByb21wdCh2Y3MsIHBhY2thZ2VEZXRhaWxzLCBwYWNrYWdlTWFuYWdlcilcbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLmxvZyhlKVxuICAgIHRocm93IGVcbiAgfSBmaW5hbGx5IHtcbiAgICB0bXBSZXBvLnJlbW92ZUNhbGxiYWNrKClcbiAgfVxufVxuXG5mdW5jdGlvbiBjcmVhdGVQYXRjaEZpbGVOYW1lKHtcbiAgcGFja2FnZURldGFpbHMsXG4gIHBhY2thZ2VWZXJzaW9uLFxuICBzZXF1ZW5jZU51bWJlcixcbiAgc2VxdWVuY2VOYW1lLFxufToge1xuICBwYWNrYWdlRGV0YWlsczogUGFja2FnZURldGFpbHNcbiAgcGFja2FnZVZlcnNpb246IHN0cmluZ1xuICBzZXF1ZW5jZU51bWJlcj86IG51bWJlclxuICBzZXF1ZW5jZU5hbWU/OiBzdHJpbmdcbn0pIHtcbiAgY29uc3QgcGFja2FnZU5hbWVzID0gcGFja2FnZURldGFpbHMucGFja2FnZU5hbWVzXG4gICAgLm1hcCgobmFtZSkgPT4gbmFtZS5yZXBsYWNlKC9cXC8vZywgXCIrXCIpKVxuICAgIC5qb2luKFwiKytcIilcblxuICBjb25zdCBuYW1lQW5kVmVyc2lvbiA9IGAke3BhY2thZ2VOYW1lc30rJHtwYWNrYWdlVmVyc2lvbn1gXG4gIGNvbnN0IG51bSA9XG4gICAgc2VxdWVuY2VOdW1iZXIgPT09IHVuZGVmaW5lZFxuICAgICAgPyBcIlwiXG4gICAgICA6IGArJHtzZXF1ZW5jZU51bWJlci50b1N0cmluZygpLnBhZFN0YXJ0KDMsIFwiMFwiKX1gXG4gIGNvbnN0IG5hbWUgPSAhc2VxdWVuY2VOYW1lID8gXCJcIiA6IGArJHtzZXF1ZW5jZU5hbWV9YFxuXG4gIHJldHVybiBgJHtuYW1lQW5kVmVyc2lvbn0ke251bX0ke25hbWV9LnBhdGNoYFxufVxuXG5leHBvcnQgZnVuY3Rpb24gbG9nUGF0Y2hTZXF1ZW5jZUVycm9yKHtcbiAgcGF0Y2hEZXRhaWxzLFxufToge1xuICBwYXRjaERldGFpbHM6IFBhdGNoZWRQYWNrYWdlRGV0YWlsc1xufSkge1xuICBjb25zb2xlLmxvZyhgXG4ke2NoYWxrLnJlZC5ib2xkKFwi4puUIEVSUk9SXCIpfVxuXG5GYWlsZWQgdG8gYXBwbHkgcGF0Y2ggZmlsZSAke2NoYWxrLmJvbGQocGF0Y2hEZXRhaWxzLnBhdGNoRmlsZW5hbWUpfS5cblxuSWYgdGhpcyBwYXRjaCBmaWxlIGlzIG5vIGxvbmdlciB1c2VmdWwsIGRlbGV0ZSBpdCBhbmQgcnVuXG5cbiAgJHtjaGFsay5ib2xkKGBwYXRjaC1wYWNrYWdlYCl9XG5cblRvIHBhcnRpYWxseSBhcHBseSB0aGUgcGF0Y2ggKGlmIHBvc3NpYmxlKSBhbmQgb3V0cHV0IGEgbG9nIG9mIGVycm9ycyB0byBmaXgsIHJ1blxuXG4gICR7Y2hhbGsuYm9sZChgcGF0Y2gtcGFja2FnZSAtLXBhcnRpYWxgKX1cblxuQWZ0ZXIgd2hpY2ggeW91IHNob3VsZCBtYWtlIGFueSByZXF1aXJlZCBjaGFuZ2VzIGluc2lkZSAke1xuICAgIHBhdGNoRGV0YWlscy5wYXRoXG4gIH0sIGFuZCBmaW5hbGx5IHJ1blxuXG4gICR7Y2hhbGsuYm9sZChgcGF0Y2gtcGFja2FnZSAke3BhdGNoRGV0YWlscy5wYXRoU3BlY2lmaWVyfWApfVxuXG50byB1cGRhdGUgdGhlIHBhdGNoIGZpbGUuXG5gKVxufVxuIl19