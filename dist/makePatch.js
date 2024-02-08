import chalk from "chalk";
import console from "console";
import { renameSync } from "fs";
import fs from "fs-extra";
const { copySync, existsSync, mkdirpSync, mkdirSync, realpathSync, writeFileSync, } = fs;
import rimraf from "rimraf";
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
        rimraf.sync(join(tmpRepoPackagePath, "node_modules"));
        // remove .git just to be safe
        rimraf.sync(join(tmpRepoPackagePath, ".git"));
        // remove patch-package state file
        rimraf.sync(join(tmpRepoPackagePath, STATE_FILE_NAME));
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
        rimraf.sync(tmpRepoPackagePath);
        // pnpm installs packages as symlinks, copySync would copy only the symlink
        copySync(realpathSync(packagePath), tmpRepoPackagePath);
        // remove nested node_modules just to be safe
        rimraf.sync(join(tmpRepoPackagePath, "node_modules"));
        // remove .git just to be safe
        rimraf.sync(join(tmpRepoPackagePath, ".git"));
        // remove patch-package state file
        rimraf.sync(join(tmpRepoPackagePath, STATE_FILE_NAME));
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFrZVBhdGNoLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL21ha2VQYXRjaC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEtBQUssTUFBTSxPQUFPLENBQUE7QUFDekIsT0FBTyxPQUFPLE1BQU0sU0FBUyxDQUFBO0FBQzdCLE9BQU8sRUFBRSxVQUFVLEVBQUUsTUFBTSxJQUFJLENBQUE7QUFDL0IsT0FBTyxFQUFFLE1BQU0sVUFBVSxDQUFBO0FBQ3pCLE1BQU0sRUFDSixRQUFRLEVBQ1IsVUFBVSxFQUNWLFVBQVUsRUFDVixTQUFTLEVBQ1QsWUFBWSxFQUNaLGFBQWEsR0FDZCxHQUFHLEVBQUUsQ0FBQTtBQUNOLE9BQU8sTUFBTSxNQUFNLFFBQVEsQ0FBQTtBQUMzQixPQUFPLEVBQUUsT0FBTyxFQUFFLE1BQU0sS0FBSyxDQUFBO0FBQzdCLE9BQU8sRUFBRSxRQUFRLEVBQUUsTUFBTSxNQUFNLENBQUE7QUFDL0IsT0FBTyxFQUFFLFVBQVUsRUFBRSxNQUFNLG1CQUFtQixDQUFBO0FBQzlDLE9BQU8sRUFDTCxvQkFBb0IsRUFDcEIsNkJBQTZCLEVBQzdCLHFCQUFxQixFQUNyQixvQkFBb0IsR0FDckIsTUFBTSxrQkFBa0IsQ0FBQTtBQUV6QixPQUFPLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQTtBQUNyRCxPQUFPLEVBQUUsb0JBQW9CLEVBQUUsTUFBTSwyQkFBMkIsQ0FBQTtBQUNoRSxPQUFPLEVBQUUsaUJBQWlCLEVBQUUsTUFBTSx3QkFBd0IsQ0FBQTtBQUMxRCxPQUFPLEVBQUUsUUFBUSxFQUFFLE1BQU0sV0FBVyxDQUFBO0FBQ3BDLE9BQU8sRUFDTCw0QkFBNEIsR0FHN0IsTUFBTSxxQkFBcUIsQ0FBQTtBQUM1QixPQUFPLEVBQUUsY0FBYyxFQUFFLE1BQU0sa0JBQWtCLENBQUE7QUFDakQsT0FBTyxFQUFFLGlCQUFpQixFQUFFLE1BQU0sY0FBYyxDQUFBO0FBQ2hELE9BQU8sRUFBRSxPQUFP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RXBELE9BQU8sR0FBRyxjQUFjLEdBQUcsR0FBRyxHQUFHLElBQUksUUFBUSxDQUFBO0FBQy9DLENBQUM7QUFFRCxNQUFNLFVBQVUscUJBQXFCLENBQUMsRUFDcEMsWUFBWSxHQUdiO0lBQ0MsT0FBTyxDQUFDLEdBQUcsQ0FBQztFQUNaLEtBQUssQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQzs7NkJBRUUsS0FBSyxDQUFDLElBQUksQ0FBQyxZQUFZLENBQUMsYUFBYSxDQUFDOzs7O0lBSS9ELEtBQUssQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDOzs7O0lBSTNCLEtBQUssQ0FBQyxJQUFJLENBQUMseUJBQXlCLENBQUM7OzBEQUdyQyxZQUFZLENBQUMsSUFDZjs7SUFFRSxLQUFLLENBQUMsSUFBSSxDQUFDLGlCQUFpQixZQUFZLENBQUMsYUFBYSxFQUFFLENBQUM7OztDQUc1RCxDQUFDLENBQUE7QUFDRixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IGNoYWxrIGZyb20gXCJjaGFsa1wiXG5pbXBvcnQgY29uc29sZSBmcm9tIFwiY29uc29sZVwiXG5pbXBvcnQgeyByZW5hbWVTeW5jIH0gZnJvbSBcImZzXCJcbmltcG9ydCBmcyBmcm9tIFwiZnMtZXh0cmFcIlxuY29uc3Qge1xuICBjb3B5U3luYyxcbiAgZXhpc3RzU3luYyxcbiAgbWtkaXJwU3luYyxcbiAgbWtkaXJTeW5jLFxuICByZWFscGF0aFN5bmMsXG4gIHdyaXRlRmlsZVN5bmMsXG59ID0gZnNcbmltcG9ydCByaW1yYWYgZnJvbSBcInJpbXJhZlwiXG5pbXBvcnQgeyBkaXJTeW5jIH0gZnJvbSBcInRtcFwiXG5pbXBvcnQgeyBnemlwU3luYyB9IGZyb20gXCJ6bGliXCJcbmltcG9ydCB7IGFwcGx5UGF0Y2ggfSBmcm9tIFwiLi9hcHBseVBhdGNoZXMuanNcIlxuaW1wb3J0IHtcbiAgZ2V0UGFja2FnZVZDU0RldGFpbHMsXG4gIG1heWJlUHJpbnRJc3N1ZUNyZWF0aW9uUHJvbXB0LFxuICBvcGVuSXNzdWVDcmVhdGlvbkxpbmssXG4gIHNob3VsZFJlY29tbWVuZElzc3VlLFxufSBmcm9tIFwiLi9jcmVhdGVJc3N1ZS5qc1wiXG5pbXBvcnQgeyBQYWNrYWdlTWFuYWdlciB9IGZyb20gXCIuL2RldGVjdFBhY2thZ2VNYW5hZ2VyLmpzXCJcbmltcG9ydCB7IHJlbW92ZUlnbm9yZWRGaWxlcyB9IGZyb20gXCIuL2ZpbHRlckZpbGVzLmpzXCJcbmltcG9ydCB7IGdldFBhY2thZ2VSZXNvbHV0aW9uIH0gZnJvbSBcIi4vZ2V0UGFja2FnZVJlc29sdXRpb24uanNcIlxuaW1wb3J0IHsgZ2V0UGFja2FnZVZlcnNpb24gfSBmcm9tIFwiLi9nZXRQYWNrYWdlVmVyc2lvbi5qc1wiXG5pbXBvcnQgeyBoYXNoRmlsZSB9IGZyb20gXCIuL2hhc2guanNcIlxuaW1wb3J0IHtcbiAgZ2V0UGF0Y2hEZXRhaWxzRnJvbUNsaVN0cmluZyxcbiAgUGFja2FnZURldGFpbHMsXG4gIFBhdGNoZWRQYWNrYWdlRGV0YWlscyxcbn0gZnJvbSBcIi4vUGFja2FnZURldGFpbHMuanNcIlxuaW1wb3J0IHsgcGFyc2VQYXRjaEZpbGUgfSBmcm9tIFwiLi9wYXRjaC9wYXJzZS5qc1wiXG5pbXBvcnQgeyBnZXRHcm91cGVkUGF0Y2hlcyB9IGZyb20gXCIuL3BhdGNoRnMuanNcIlxuaW1wb3J0IHsgZGlybmFtZSwgam9pbiwgcmVzb2x2ZSB9IGZyb20gXCIuL3BhdGguanNcIlxuaW1wb3J0IHsgcmVzb2x2ZVJlbGF0aXZlRmlsZURlcGVuZGVuY2llcyB9IGZyb20gXCIuL3Jlc29sdmVSZWxhdGl2ZUZpbGVEZXBlbmRlbmNpZXMuanNcIlxuaW1wb3J0IHsgc3Bhd25TYWZlU3luYyB9IGZyb20gXCIuL3NwYXduU2FmZS5qc1wiXG5pbXBvcnQge1xuICBjbGVhclBhdGNoQXBwbGljYXRpb25TdGF0ZSxcbiAgZ2V0UGF0Y2hBcHBsaWNhdGlvblN0YXRlLFxuICBQYXRjaFN0YXRlLFxuICBzYXZlUGF0Y2hBcHBsaWNhdGlvblN0YXRlLFxuICBTVEFURV9GSUxFX05BTUUsXG4gIHZlcmlmeUFwcGxpZWRQYXRjaGVzLFxufSBmcm9tIFwiLi9zdGF0ZUZpbGUuanNcIlxuXG5mdW5jdGlvbiBwcmludE5vUGFja2FnZUZvdW5kRXJyb3IoXG4gIHBhY2thZ2VOYW1lOiBzdHJpbmcsXG4gIHBhY2thZ2VKc29uUGF0aDogc3RyaW5nLFxuKSB7XG4gIGNvbnNvbGUubG9nKFxuICAgIGBObyBzdWNoIHBhY2thZ2UgJHtwYWNrYWdlTmFtZX1cblxuICBGaWxlIG5vdCBmb3VuZDogJHtwYWNrYWdlSnNvblBhdGh9YCxcbiAgKVxufVxuXG5leHBvcnQgZnVuY3Rpb24gbWFrZVBhdGNoKHtcbiAgcGFja2FnZVBhdGhTcGVjaWZpZXIsXG4gIGFwcFBhdGgsXG4gIHBhY2thZ2VNYW5hZ2VyLFxuICBpbmNsdWRlUGF0aHMsXG4gIGV4Y2x1ZGVQYXRocyxcbiAgcGF0Y2hEaXIsXG4gIGNyZWF0ZUlzc3VlLFxuICBtb2RlLFxufToge1xuICBwYWNrYWdlUGF0aFNwZWNpZmllcjogc3RyaW5nXG4gIGFwcFBhdGg6IHN0cmluZ1xuICBwYWNrYWdlTWFuYWdlcjogUGFja2FnZU1hbmFnZXJcbiAgaW5jbHVkZVBhdGhzOiBSZWdFeHBcbiAgZXhjbHVkZVBhdGhzOiBSZWdFeHBcbiAgcGF0Y2hEaXI6IHN0cmluZ1xuICBjcmVhdGVJc3N1ZTogYm9vbGVhblxuICBtb2RlOiB7IHR5cGU6IFwib3ZlcndyaXRlX2xhc3RcIiB9IHwgeyB0eXBlOiBcImFwcGVuZFwiOyBuYW1lPzogc3RyaW5nIH1cbn0pIHtcbiAgY29uc3QgcGFja2FnZURldGFpbHMgPSBnZXRQYXRjaERldGFpbHNGcm9tQ2xpU3RyaW5nKHBhY2thZ2VQYXRoU3BlY2lmaWVyKVxuXG4gIGlmICghcGFja2FnZURldGFpbHMpIHtcbiAgICBjb25zb2xlLmxvZyhcIk5vIHN1Y2ggcGFja2FnZVwiLCBwYWNrYWdlUGF0aFNwZWNpZmllcilcbiAgICByZXR1cm5cbiAgfVxuXG4gIGNvbnN0IHN0YXRlID0gZ2V0UGF0Y2hBcHBsaWNhdGlvblN0YXRlKHBhY2thZ2VEZXRhaWxzKVxuICBjb25zdCBpc1JlYmFzaW5nID0gc3RhdGU/LmlzUmViYXNpbmcgPz8gZmFsc2VcblxuICAvLyBJZiB3ZSBhcmUgcmViYXNpbmcgYW5kIG5vIHBhdGNoZXMgaGF2ZSBiZWVuIGFwcGxpZWQsIC0tYXBwZW5kIGlzIHRoZSBvbmx5IHZhbGlkIG9wdGlvbiBiZWNhdXNlXG4gIC8vIHRoZXJlIGFyZSBubyBwcmV2aW91cyBwYXRjaGVzIHRvIG92ZXJ3cml0ZS91cGRhdGVcbiAgaWYgKFxuICAgIGlzUmViYXNpbmcgJiZcbiAgICBzdGF0ZT8ucGF0Y2hlcy5maWx0ZXIoKHApID0+IHAuZGlkQXBwbHkpLmxlbmd0aCA9PT0gMCAmJlxuICAgIG1vZGUudHlwZSA9PT0gXCJvdmVyd3JpdGVfbGFzdFwiXG4gICkge1xuICAgIG1vZGUgPSB7IHR5cGU6IFwiYXBwZW5kXCIsIG5hbWU6IFwiaW5pdGlhbFwiIH1cbiAgfVxuXG4gIGlmIChpc1JlYmFzaW5nICYmIHN0YXRlKSB7XG4gICAgdmVyaWZ5QXBwbGllZFBhdGNoZXMoeyBhcHBQYXRoLCBwYXRjaERpciwgc3RhdGUgfSlcbiAgfVxuXG4gIGlmIChcbiAgICBtb2RlLnR5cGUgPT09IFwib3ZlcndyaXRlX2xhc3RcIiAmJlxuICAgIGlzUmViYXNpbmcgJiZcbiAgICBzdGF0ZT8ucGF0Y2hlcy5sZW5ndGggPT09IDBcbiAgKSB7XG4gICAgbW9kZSA9IHsgdHlwZTogXCJhcHBlbmRcIiwgbmFtZTogXCJpbml0aWFsXCIgfVxuICB9XG5cbiAgY29uc3QgZXhpc3RpbmdQYXRjaGVzID1cbiAgICBnZXRHcm91cGVkUGF0Y2hlcyhwYXRjaERpcikucGF0aFNwZWNpZmllclRvUGF0Y2hGaWxlc1tcbiAgICAgIHBhY2thZ2VEZXRhaWxzLnBhdGhTcGVjaWZpZXJcbiAgICBdIHx8IFtdXG5cbiAgLy8gYXBwbHkgYWxsIGV4aXN0aW5nIHBhdGNoZXMgaWYgYXBwZW5kaW5nXG4gIC8vIG90aGVyd2lzZSBhcHBseSBhbGwgYnV0IHRoZSBsYXN0XG4gIGNvbnN0IHByZXZpb3VzbHlBcHBsaWVkUGF0Y2hlcyA9IHN0YXRlPy5wYXRjaGVzLmZpbHRlcigocCkgPT4gcC5kaWRBcHBseSlcbiAgY29uc3QgcGF0Y2hlc1RvQXBwbHlCZWZvcmVEaWZmaW5nOiBQYXRjaGVkUGFja2FnZURldGFpbHNbXSA9IGlzUmViYXNpbmdcbiAgICA/IG1vZGUudHlwZSA9PT0gXCJhcHBlbmRcIlxuICAgICAgPyBleGlzdGluZ1BhdGNoZXMuc2xpY2UoMCwgcHJldmlvdXNseUFwcGxpZWRQYXRjaGVzIS5sZW5ndGgpXG4gICAgICA6IHN0YXRlIS5wYXRjaGVzW3N0YXRlIS5wYXRjaGVzLmxlbmd0aCAtIDFdLmRpZEFwcGx5XG4gICAgICA/IGV4aXN0aW5nUGF0Y2hlcy5zbGljZSgwLCBwcmV2aW91c2x5QXBwbGllZFBhdGNoZXMhLmxlbmd0aCAtIDEpXG4gICAgICA6IGV4aXN0aW5nUGF0Y2hlcy5zbGljZSgwLCBwcmV2aW91c2x5QXBwbGllZFBhdGNoZXMhLmxlbmd0aClcbiAgICA6IG1vZGUudHlwZSA9PT0gXCJhcHBlbmRcIlxuICAgID8gZXhpc3RpbmdQYXRjaGVzXG4gICAgOiBleGlzdGluZ1BhdGNoZXMuc2xpY2UoMCwgLTEpXG5cbiAgaWYgKGNyZWF0ZUlzc3VlICYmIG1vZGUudHlwZSA9PT0gXCJhcHBlbmRcIikge1xuICAgIGNvbnNvbGUubG9nKFwiLS1jcmVhdGUtaXNzdWUgaXMgbm90IGNvbXBhdGlibGUgd2l0aCAtLWFwcGVuZC5cIilcbiAgICBwcm9jZXNzLmV4aXQoMSlcbiAgfVxuXG4gIGlmIChjcmVhdGVJc3N1ZSAmJiBpc1JlYmFzaW5nKSB7XG4gICAgY29uc29sZS5sb2coXCItLWNyZWF0ZS1pc3N1ZSBpcyBub3QgY29tcGF0aWJsZSB3aXRoIHJlYmFzaW5nLlwiKVxuICAgIHByb2Nlc3MuZXhpdCgxKVxuICB9XG5cbiAgY29uc3QgbnVtUGF0Y2hlc0FmdGVyQ3JlYXRlID1cbiAgICBtb2RlLnR5cGUgPT09IFwiYXBwZW5kXCIgfHwgZXhpc3RpbmdQYXRjaGVzLmxlbmd0aCA9PT0gMFxuICAgICAgPyBleGlzdGluZ1BhdGNoZXMubGVuZ3RoICsgMVxuICAgICAgOiBleGlzdGluZ1BhdGNoZXMubGVuZ3RoXG4gIGNvbnN0IHZjcyA9IGdldFBhY2thZ2VWQ1NEZXRhaWxzKHBhY2thZ2VEZXRhaWxzKVxuICBjb25zdCBjYW5DcmVhdGVJc3N1ZSA9XG4gICAgIWlzUmViYXNpbmcgJiZcbiAgICBzaG91bGRSZWNvbW1lbmRJc3N1ZSh2Y3MpICYmXG4gICAgbnVtUGF0Y2hlc0FmdGVyQ3JlYXRlID09PSAxICYmXG4gICAgbW9kZS50eXBlICE9PSBcImFwcGVuZFwiXG5cbiAgY29uc3QgYXBwUGFja2FnZUpzb24gPSByZXF1aXJlKGpvaW4oYXBwUGF0aCwgXCJwYWNrYWdlLmpzb25cIikpXG4gIGNvbnN0IHBhY2thZ2VQYXRoID0gam9pbihhcHBQYXRoLCBwYWNrYWdlRGV0YWlscy5wYXRoKVxuICBjb25zdCBwYWNrYWdlSnNvblBhdGggPSBqb2luKHBhY2thZ2VQYXRoLCBcInBhY2thZ2UuanNvblwiKVxuXG4gIGlmICghZXhpc3RzU3luYyhwYWNrYWdlSnNvblBhdGgpKSB7XG4gICAgcHJpbnROb1BhY2thZ2VGb3VuZEVycm9yKHBhY2thZ2VQYXRoU3BlY2lmaWVyLCBwYWNrYWdlSnNvblBhdGgpXG4gICAgcHJvY2Vzcy5leGl0KDEpXG4gIH1cblxuICBjb25zdCB0bXBSZXBvID0gZGlyU3luYyh7IHVuc2FmZUNsZWFudXA6IHRydWUgfSlcbiAgY29uc3QgdG1wUmVwb1BhY2thZ2VQYXRoID0gam9pbih0bXBSZXBvLm5hbWUsIHBhY2thZ2VEZXRhaWxzLnBhdGgpXG4gIGNvbnN0IHRtcFJlcG9OcG1Sb290ID0gdG1wUmVwb1BhY2thZ2VQYXRoLnNsaWNlKFxuICAgIDAsXG4gICAgLWAvbm9kZV9tb2R1bGVzLyR7cGFja2FnZURldGFpbHMubmFtZX1gLmxlbmd0aCxcbiAgKVxuXG4gIGNvbnN0IHRtcFJlcG9QYWNrYWdlSnNvblBhdGggPSBqb2luKHRtcFJlcG9OcG1Sb290LCBcInBhY2thZ2UuanNvblwiKVxuXG4gIHRyeSB7XG4gICAgY29uc3QgcGF0Y2hlc0RpciA9IHJlc29sdmUoam9pbihhcHBQYXRoLCBwYXRjaERpcikpXG5cbiAgICBjb25zb2xlLmluZm8oY2hhbGsuZ3JleShcIuKAolwiKSwgXCJDcmVhdGluZyB0ZW1wb3JhcnkgZm9sZGVyXCIpXG5cbiAgICAvLyBtYWtlIGEgYmxhbmsgcGFja2FnZS5qc29uXG4gICAgbWtkaXJwU3luYyh0bXBSZXBvTnBtUm9vdClcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgdG1wUmVwb1BhY2thZ2VKc29uUGF0aCxcbiAgICAgIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgZGVwZW5kZW5jaWVzOiB7XG4gICAgICAgICAgW3BhY2thZ2VEZXRhaWxzLm5hbWVdOiBnZXRQYWNrYWdlUmVzb2x1dGlvbih7XG4gICAgICAgICAgICBwYWNrYWdlRGV0YWlscyxcbiAgICAgICAgICAgIHBhY2thZ2VNYW5hZ2VyLFxuICAgICAgICAgICAgYXBwUGF0aCxcbiAgICAgICAgICB9KSxcbiAgICAgICAgfSxcbiAgICAgICAgcmVzb2x1dGlvbnM6IHJlc29sdmVSZWxhdGl2ZUZpbGVEZXBlbmRlbmNpZXMoXG4gICAgICAgICAgYXBwUGF0aCxcbiAgICAgICAgICBhcHBQYWNrYWdlSnNvbi5yZXNvbHV0aW9ucyB8fCB7fSxcbiAgICAgICAgKSxcbiAgICAgIH0pLFxuICAgIClcblxuICAgIGNvbnN0IHBhY2thZ2VWZXJzaW9uID0gZ2V0UGFja2FnZVZlcnNpb24oXG4gICAgICBqb2luKHJlc29sdmUocGFja2FnZURldGFpbHMucGF0aCksIFwicGFja2FnZS5qc29uXCIpLFxuICAgIClcblxuICAgIC8vIGNvcHkgLm5wbXJjLy55YXJucmMgaW4gY2FzZSBwYWNrYWdlcyBhcmUgaG9zdGVkIGluIHByaXZhdGUgcmVnaXN0cnlcbiAgICAvLyBjb3B5IC55YXJuIGRpcmVjdG9yeSBhcyB3ZWxsIHRvIGVuc3VyZSBpbnN0YWxsYXRpb25zIHdvcmsgaW4geWFybiAyXG4gICAgLy8gdHNsaW50OmRpc2FibGUtbmV4dC1saW5lOmFsaWduXG4gICAgO1tcIi5ucG1yY1wiLCBcIi55YXJucmNcIiwgXCIueWFyblwiXS5mb3JFYWNoKChyY0ZpbGUpID0+IHtcbiAgICAgIGNvbnN0IHJjUGF0aCA9IGpvaW4oYXBwUGF0aCwgcmNGaWxlKVxuICAgICAgaWYgKGV4aXN0c1N5bmMocmNQYXRoKSkge1xuICAgICAgICBjb3B5U3luYyhyY1BhdGgsIGpvaW4odG1wUmVwby5uYW1lLCByY0ZpbGUpLCB7IGRlcmVmZXJlbmNlOiB0cnVlIH0pXG4gICAgICB9XG4gICAgfSlcblxuICAgIGlmIChwYWNrYWdlTWFuYWdlciA9PT0gXCJ5YXJuXCIpIHtcbiAgICAgIGNvbnNvbGUuaW5mbyhcbiAgICAgICAgY2hhbGsuZ3JleShcIuKAolwiKSxcbiAgICAgICAgYEluc3RhbGxpbmcgJHtwYWNrYWdlRGV0YWlscy5uYW1lfUAke3BhY2thZ2VWZXJzaW9ufSB3aXRoIHlhcm5gLFxuICAgICAgKVxuICAgICAgdHJ5IHtcbiAgICAgICAgLy8gdHJ5IGZpcnN0IHdpdGhvdXQgaWdub3Jpbmcgc2NyaXB0cyBpbiBjYXNlIHRoZXkgYXJlIHJlcXVpcmVkXG4gICAgICAgIC8vIHRoaXMgd29ya3MgaW4gOTkuOTklIG9mIGNhc2VzXG4gICAgICAgIHNwYXduU2FmZVN5bmMoYHlhcm5gLCBbXCJpbnN0YWxsXCIsIFwiLS1pZ25vcmUtZW5naW5lc1wiXSwge1xuICAgICAgICAgIGN3ZDogdG1wUmVwb05wbVJvb3QsXG4gICAgICAgICAgbG9nU3RkRXJyT25FcnJvcjogZmFsc2UsXG4gICAgICAgIH0pXG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIC8vIHRyeSBhZ2FpbiB3aGlsZSBpZ25vcmluZyBzY3JpcHRzIGluIGNhc2UgdGhlIHNjcmlwdCBkZXBlbmRzIG9uXG4gICAgICAgIC8vIGFuIGltcGxpY2l0IGNvbnRleHQgd2hpY2ggd2UgaGF2ZW4ndCByZXByb2R1Y2VkXG4gICAgICAgIHNwYXduU2FmZVN5bmMoXG4gICAgICAgICAgYHlhcm5gLFxuICAgICAgICAgIFtcImluc3RhbGxcIiwgXCItLWlnbm9yZS1lbmdpbmVzXCIsIFwiLS1pZ25vcmUtc2NyaXB0c1wiXSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBjd2Q6IHRtcFJlcG9OcG1Sb290LFxuICAgICAgICAgIH0sXG4gICAgICAgIClcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgY29uc29sZS5pbmZvKFxuICAgICAgICBjaGFsay5ncmV5KFwi4oCiXCIpLFxuICAgICAgICBgSW5zdGFsbGluZyAke3BhY2thZ2VEZXRhaWxzLm5hbWV9QCR7cGFja2FnZVZlcnNpb259IHdpdGggbnBtYCxcbiAgICAgIClcbiAgICAgIHRyeSB7XG4gICAgICAgIC8vIHRyeSBmaXJzdCB3aXRob3V0IGlnbm9yaW5nIHNjcmlwdHMgaW4gY2FzZSB0aGV5IGFyZSByZXF1aXJlZFxuICAgICAgICAvLyB0aGlzIHdvcmtzIGluIDk5Ljk5JSBvZiBjYXNlc1xuICAgICAgICBzcGF3blNhZmVTeW5jKGBucG1gLCBbXCJpXCIsIFwiLS1mb3JjZVwiXSwge1xuICAgICAgICAgIGN3ZDogdG1wUmVwb05wbVJvb3QsXG4gICAgICAgICAgbG9nU3RkRXJyT25FcnJvcjogZmFsc2UsXG4gICAgICAgICAgc3RkaW86IFwiaWdub3JlXCIsXG4gICAgICAgIH0pXG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIC8vIHRyeSBhZ2FpbiB3aGlsZSBpZ25vcmluZyBzY3JpcHRzIGluIGNhc2UgdGhlIHNjcmlwdCBkZXBlbmRzIG9uXG4gICAgICAgIC8vIGFuIGltcGxpY2l0IGNvbnRleHQgd2hpY2ggd2UgaGF2ZW4ndCByZXByb2R1Y2VkXG4gICAgICAgIHNwYXduU2FmZVN5bmMoYG5wbWAsIFtcImlcIiwgXCItLWlnbm9yZS1zY3JpcHRzXCIsIFwiLS1mb3JjZVwiXSwge1xuICAgICAgICAgIGN3ZDogdG1wUmVwb05wbVJvb3QsXG4gICAgICAgICAgc3RkaW86IFwiaWdub3JlXCIsXG4gICAgICAgIH0pXG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgZ2l0ID0gKC4uLmFyZ3M6IHN0cmluZ1tdKSA9PlxuICAgICAgc3Bhd25TYWZlU3luYyhcImdpdFwiLCBhcmdzLCB7XG4gICAgICAgIGN3ZDogdG1wUmVwby5uYW1lLFxuICAgICAgICBlbnY6IHsgLi4ucHJvY2Vzcy5lbnYsIEhPTUU6IHRtcFJlcG8ubmFtZSB9LFxuICAgICAgICBtYXhCdWZmZXI6IDEwMjQgKiAxMDI0ICogMTAwLFxuICAgICAgfSlcblxuICAgIC8vIHJlbW92ZSBuZXN0ZWQgbm9kZV9tb2R1bGVzIGp1c3QgdG8gYmUgc2FmZVxuICAgIHJpbXJhZi5zeW5jKGpvaW4odG1wUmVwb1BhY2thZ2VQYXRoLCBcIm5vZGVfbW9kdWxlc1wiKSlcbiAgICAvLyByZW1vdmUgLmdpdCBqdXN0IHRvIGJlIHNhZmVcbiAgICByaW1yYWYuc3luYyhqb2luKHRtcFJlcG9QYWNrYWdlUGF0aCwgXCIuZ2l0XCIpKVxuICAgIC8vIHJlbW92ZSBwYXRjaC1wYWNrYWdlIHN0YXRlIGZpbGVcbiAgICByaW1yYWYuc3luYyhqb2luKHRtcFJlcG9QYWNrYWdlUGF0aCwgU1RBVEVfRklMRV9OQU1FKSlcblxuICAgIC8vIGNvbW1pdCB0aGUgcGFja2FnZVxuICAgIGNvbnNvbGUuaW5mbyhjaGFsay5ncmV5KFwi4oCiXCIpLCBcIkRpZmZpbmcgeW91ciBmaWxlcyB3aXRoIGNsZWFuIGZpbGVzXCIpXG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRtcFJlcG8ubmFtZSwgXCIuZ2l0aWdub3JlXCIpLCBcIiEvbm9kZV9tb2R1bGVzXFxuXFxuXCIpXG4gICAgZ2l0KFwiaW5pdFwiKVxuICAgIGdpdChcImNvbmZpZ1wiLCBcIi0tbG9jYWxcIiwgXCJ1c2VyLm5hbWVcIiwgXCJwYXRjaC1wYWNrYWdlXCIpXG4gICAgZ2l0KFwiY29uZmlnXCIsIFwiLS1sb2NhbFwiLCBcInVzZXIuZW1haWxcIiwgXCJwYXRjaEBwYWNrLmFnZVwiKVxuXG4gICAgLy8gcmVtb3ZlIGlnbm9yZWQgZmlsZXMgZmlyc3RcbiAgICByZW1vdmVJZ25vcmVkRmlsZXModG1wUmVwb1BhY2thZ2VQYXRoLCBpbmNsdWRlUGF0aHMsIGV4Y2x1ZGVQYXRocylcblxuICAgIGZvciAoY29uc3QgcGF0Y2hEZXRhaWxzIG9mIHBhdGNoZXNUb0FwcGx5QmVmb3JlRGlmZmluZykge1xuICAgICAgaWYgKFxuICAgICAgICAhYXBwbHlQYXRjaCh7XG4gICAgICAgICAgcGF0Y2hEZXRhaWxzLFxuICAgICAgICAgIHBhdGNoRGlyLFxuICAgICAgICAgIHBhdGNoRmlsZVBhdGg6IGpvaW4oYXBwUGF0aCwgcGF0Y2hEaXIsIHBhdGNoRGV0YWlscy5wYXRjaEZpbGVuYW1lKSxcbiAgICAgICAgICByZXZlcnNlOiBmYWxzZSxcbiAgICAgICAgICBjd2Q6IHRtcFJlcG8ubmFtZSxcbiAgICAgICAgICBiZXN0RWZmb3J0OiBmYWxzZSxcbiAgICAgICAgfSlcbiAgICAgICkge1xuICAgICAgICAvLyBUT0RPOiBhZGQgYmV0dGVyIGVycm9yIG1lc3NhZ2Ugb25jZSAtLXJlYmFzZSBpcyBpbXBsZW1lbnRlZFxuICAgICAgICBjb25zb2xlLmxvZyhcbiAgICAgICAgICBgRmFpbGVkIHRvIGFwcGx5IHBhdGNoICR7cGF0Y2hEZXRhaWxzLnBhdGNoRmlsZW5hbWV9IHRvICR7cGFja2FnZURldGFpbHMucGF0aFNwZWNpZmllcn1gLFxuICAgICAgICApXG4gICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgfVxuICAgIH1cbiAgICBnaXQoXCJhZGRcIiwgXCItZlwiLCBwYWNrYWdlRGV0YWlscy5wYXRoKVxuICAgIGdpdChcImNvbW1pdFwiLCBcIi0tYWxsb3ctZW1wdHlcIiwgXCItbVwiLCBcImluaXRcIilcblxuICAgIC8vIHJlcGxhY2UgcGFja2FnZSB3aXRoIHVzZXIncyB2ZXJzaW9uXG4gICAgcmltcmFmLnN5bmModG1wUmVwb1BhY2thZ2VQYXRoKVxuXG4gICAgLy8gcG5wbSBpbnN0YWxscyBwYWNrYWdlcyBhcyBzeW1saW5rcywgY29weVN5bmMgd291bGQgY29weSBvbmx5IHRoZSBzeW1saW5rXG4gICAgY29weVN5bmMocmVhbHBhdGhTeW5jKHBhY2thZ2VQYXRoKSwgdG1wUmVwb1BhY2thZ2VQYXRoKVxuXG4gICAgLy8gcmVtb3ZlIG5lc3RlZCBub2RlX21vZHVsZXMganVzdCB0byBiZSBzYWZlXG4gICAgcmltcmFmLnN5bmMoam9pbih0bXBSZXBvUGFja2FnZVBhdGgsIFwibm9kZV9tb2R1bGVzXCIpKVxuICAgIC8vIHJlbW92ZSAuZ2l0IGp1c3QgdG8gYmUgc2FmZVxuICAgIHJpbXJhZi5zeW5jKGpvaW4odG1wUmVwb1BhY2thZ2VQYXRoLCBcIi5naXRcIikpXG4gICAgLy8gcmVtb3ZlIHBhdGNoLXBhY2thZ2Ugc3RhdGUgZmlsZVxuICAgIHJpbXJhZi5zeW5jKGpvaW4odG1wUmVwb1BhY2thZ2VQYXRoLCBTVEFURV9GSUxFX05BTUUpKVxuXG4gICAgLy8gYWxzbyByZW1vdmUgaWdub3JlZCBmaWxlcyBsaWtlIGJlZm9yZVxuICAgIHJlbW92ZUlnbm9yZWRGaWxlcyh0bXBSZXBvUGFja2FnZVBhdGgsIGluY2x1ZGVQYXRocywgZXhjbHVkZVBhdGhzKVxuXG4gICAgLy8gc3RhZ2UgYWxsIGZpbGVzXG4gICAgZ2l0KFwiYWRkXCIsIFwiLWZcIiwgcGFja2FnZURldGFpbHMucGF0aClcblxuICAgIC8vIGdldCBkaWZmIG9mIGNoYW5nZXNcbiAgICBjb25zdCBkaWZmUmVzdWx0ID0gZ2l0KFxuICAgICAgXCJkaWZmXCIsXG4gICAgICBcIi0tY2FjaGVkXCIsXG4gICAgICBcIi0tbm8tY29sb3JcIixcbiAgICAgIFwiLS1pZ25vcmUtc3BhY2UtYXQtZW9sXCIsXG4gICAgICBcIi0tbm8tZXh0LWRpZmZcIixcbiAgICAgIFwiLS1zcmMtcHJlZml4PWEvXCIsXG4gICAgICBcIi0tZHN0LXByZWZpeD1iL1wiLFxuICAgIClcblxuICAgIGlmIChkaWZmUmVzdWx0LnN0ZG91dC5sZW5ndGggPT09IDApIHtcbiAgICAgIGNvbnNvbGUubG9nKFxuICAgICAgICBg4oGJ77iPICBOb3QgY3JlYXRpbmcgcGF0Y2ggZmlsZSBmb3IgcGFja2FnZSAnJHtwYWNrYWdlUGF0aFNwZWNpZmllcn0nYCxcbiAgICAgIClcbiAgICAgIGNvbnNvbGUubG9nKGDigYnvuI8gIFRoZXJlIGRvbid0IGFwcGVhciB0byBiZSBhbnkgY2hhbmdlcy5gKVxuICAgICAgaWYgKGlzUmViYXNpbmcgJiYgbW9kZS50eXBlID09PSBcIm92ZXJ3cml0ZV9sYXN0XCIpIHtcbiAgICAgICAgY29uc29sZS5sb2coXG4gICAgICAgICAgXCJcXG7wn5KhIFRvIHJlbW92ZSBhIHBhdGNoIGZpbGUsIGRlbGV0ZSBpdCBhbmQgdGhlbiByZWluc3RhbGwgbm9kZV9tb2R1bGVzIGZyb20gc2NyYXRjaC5cIixcbiAgICAgICAgKVxuICAgICAgfVxuICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICB0cnkge1xuICAgICAgcGFyc2VQYXRjaEZpbGUoZGlmZlJlc3VsdC5zdGRvdXQudG9TdHJpbmcoKSlcbiAgICB9IGNhdGNoIChlOiBhbnkpIHtcbiAgICAgIGlmIChcbiAgICAgICAgKGUgYXMgRXJyb3IpLm1lc3NhZ2UuaW5jbHVkZXMoXCJVbmV4cGVjdGVkIGZpbGUgbW9kZSBzdHJpbmc6IDEyMDAwMFwiKVxuICAgICAgKSB7XG4gICAgICAgIGNvbnNvbGUubG9nKGBcbuKblO+4jyAke2NoYWxrLnJlZC5ib2xkKFwiRVJST1JcIil9XG5cbiAgWW91ciBjaGFuZ2VzIGludm9sdmUgY3JlYXRpbmcgc3ltbGlua3MuIHBhdGNoLXBhY2thZ2UgZG9lcyBub3QgeWV0IHN1cHBvcnRcbiAgc3ltbGlua3MuXG4gIFxuICDvuI9QbGVhc2UgdXNlICR7Y2hhbGsuYm9sZChcIi0taW5jbHVkZVwiKX0gYW5kL29yICR7Y2hhbGsuYm9sZChcbiAgICAgICAgICBcIi0tZXhjbHVkZVwiLFxuICAgICAgICApfSB0byBuYXJyb3cgdGhlIHNjb3BlIG9mIHlvdXIgcGF0Y2ggaWZcbiAgdGhpcyB3YXMgdW5pbnRlbnRpb25hbC5cbmApXG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCBvdXRQYXRoID0gXCIuL3BhdGNoLXBhY2thZ2UtZXJyb3IuanNvbi5nelwiXG4gICAgICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICAgICAgb3V0UGF0aCxcbiAgICAgICAgICBnemlwU3luYyhcbiAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICAgICAgZXJyb3I6IHsgbWVzc2FnZTogZS5tZXNzYWdlLCBzdGFjazogZS5zdGFjayB9LFxuICAgICAgICAgICAgICBwYXRjaDogZGlmZlJlc3VsdC5zdGRvdXQudG9TdHJpbmcoKSxcbiAgICAgICAgICAgIH0pLFxuICAgICAgICAgICksXG4gICAgICAgIClcbiAgICAgICAgY29uc29sZS5sb2coYFxu4puU77iPICR7Y2hhbGsucmVkLmJvbGQoXCJFUlJPUlwiKX1cbiAgICAgICAgXG4gIHBhdGNoLXBhY2thZ2Ugd2FzIHVuYWJsZSB0byByZWFkIHRoZSBwYXRjaC1maWxlIG1hZGUgYnkgZ2l0LiBUaGlzIHNob3VsZCBub3RcbiAgaGFwcGVuLlxuICBcbiAgQSBkaWFnbm9zdGljIGZpbGUgd2FzIHdyaXR0ZW4gdG9cbiAgXG4gICAgJHtvdXRQYXRofVxuICBcbiAgUGxlYXNlIGF0dGFjaCBpdCB0byBhIGdpdGh1YiBpc3N1ZVxuICBcbiAgICBodHRwczovL2dpdGh1Yi5jb20vZHMzMDAvcGF0Y2gtcGFja2FnZS9pc3N1ZXMvbmV3P3RpdGxlPU5ldytwYXRjaCtwYXJzZStmYWlsZWQmYm9keT1QbGVhc2UrYXR0YWNoK3RoZStkaWFnbm9zdGljK2ZpbGUrYnkrZHJhZ2dpbmcraXQraW50bytoZXJlK/CfmY9cbiAgXG4gIE5vdGUgdGhhdCB0aGlzIGRpYWdub3N0aWMgZmlsZSB3aWxsIGNvbnRhaW4gY29kZSBmcm9tIHRoZSBwYWNrYWdlIHlvdSB3ZXJlXG4gIGF0dGVtcHRpbmcgdG8gcGF0Y2guXG5cbmApXG4gICAgICB9XG4gICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIC8vIG1heWJlIGRlbGV0ZSBleGlzdGluZ1xuICAgIGlmIChtb2RlLnR5cGUgPT09IFwiYXBwZW5kXCIgJiYgIWlzUmViYXNpbmcgJiYgZXhpc3RpbmdQYXRjaGVzLmxlbmd0aCA9PT0gMSkge1xuICAgICAgLy8gaWYgd2UgYXJlIGFwcGVuZGluZyB0byBhbiBleGlzdGluZyBwYXRjaCB0aGF0IGRvZXNuJ3QgaGF2ZSBhIHNlcXVlbmNlIG51bWJlciBsZXQncyByZW5hbWUgaXRcbiAgICAgIGNvbnN0IHByZXZQYXRjaCA9IGV4aXN0aW5nUGF0Y2hlc1swXVxuICAgICAgaWYgKHByZXZQYXRjaC5zZXF1ZW5jZU51bWJlciA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGNvbnN0IG5ld0ZpbGVOYW1lID0gY3JlYXRlUGF0Y2hGaWxlTmFtZSh7XG4gICAgICAgICAgcGFja2FnZURldGFpbHMsXG4gICAgICAgICAgcGFja2FnZVZlcnNpb24sXG4gICAgICAgICAgc2VxdWVuY2VOdW1iZXI6IDEsXG4gICAgICAgICAgc2VxdWVuY2VOYW1lOiBwcmV2UGF0Y2guc2VxdWVuY2VOYW1lID8/IFwiaW5pdGlhbFwiLFxuICAgICAgICB9KVxuICAgICAgICBjb25zdCBvbGRQYXRoID0gam9pbihhcHBQYXRoLCBwYXRjaERpciwgcHJldlBhdGNoLnBhdGNoRmlsZW5hbWUpXG4gICAgICAgIGNvbnN0IG5ld1BhdGggPSBqb2luKGFwcFBhdGgsIHBhdGNoRGlyLCBuZXdGaWxlTmFtZSlcbiAgICAgICAgcmVuYW1lU3luYyhvbGRQYXRoLCBuZXdQYXRoKVxuICAgICAgICBwcmV2UGF0Y2guc2VxdWVuY2VOdW1iZXIgPSAxXG4gICAgICAgIHByZXZQYXRjaC5wYXRjaEZpbGVuYW1lID0gbmV3RmlsZU5hbWVcbiAgICAgICAgcHJldlBhdGNoLnNlcXVlbmNlTmFtZSA9IHByZXZQYXRjaC5zZXF1ZW5jZU5hbWUgPz8gXCJpbml0aWFsXCJcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBsYXN0UGF0Y2ggPSBleGlzdGluZ1BhdGNoZXNbXG4gICAgICBzdGF0ZSA/IHN0YXRlLnBhdGNoZXMubGVuZ3RoIC0gMSA6IGV4aXN0aW5nUGF0Y2hlcy5sZW5ndGggLSAxXG4gICAgXSBhcyBQYXRjaGVkUGFja2FnZURldGFpbHMgfCB1bmRlZmluZWRcbiAgICBjb25zdCBzZXF1ZW5jZU5hbWUgPVxuICAgICAgbW9kZS50eXBlID09PSBcImFwcGVuZFwiID8gbW9kZS5uYW1lIDogbGFzdFBhdGNoPy5zZXF1ZW5jZU5hbWVcbiAgICBjb25zdCBzZXF1ZW5jZU51bWJlciA9XG4gICAgICBtb2RlLnR5cGUgPT09IFwiYXBwZW5kXCJcbiAgICAgICAgPyAobGFzdFBhdGNoPy5zZXF1ZW5jZU51bWJlciA/PyAwKSArIDFcbiAgICAgICAgOiBsYXN0UGF0Y2g/LnNlcXVlbmNlTnVtYmVyXG5cbiAgICBjb25zdCBwYXRjaEZpbGVOYW1lID0gY3JlYXRlUGF0Y2hGaWxlTmFtZSh7XG4gICAgICBwYWNrYWdlRGV0YWlscyxcbiAgICAgIHBhY2thZ2VWZXJzaW9uLFxuICAgICAgc2VxdWVuY2VOYW1lLFxuICAgICAgc2VxdWVuY2VOdW1iZXIsXG4gICAgfSlcblxuICAgIGNvbnN0IHBhdGNoUGF0aCA9IGpvaW4ocGF0Y2hlc0RpciwgcGF0Y2hGaWxlTmFtZSlcbiAgICBpZiAoIWV4aXN0c1N5bmMoZGlybmFtZShwYXRjaFBhdGgpKSkge1xuICAgICAgLy8gc2NvcGVkIHBhY2thZ2VcbiAgICAgIG1rZGlyU3luYyhkaXJuYW1lKHBhdGNoUGF0aCkpXG4gICAgfVxuXG4gICAgLy8gaWYgd2UgYXJlIGluc2VydGluZyBhIG5ldyBwYXRjaCBpbnRvIGEgc2VxdWVuY2Ugd2UgbW9zdCBsaWtlbHkgbmVlZCB0byB1cGRhdGUgdGhlIHNlcXVlbmNlIG51bWJlcnNcbiAgICBpZiAoaXNSZWJhc2luZyAmJiBtb2RlLnR5cGUgPT09IFwiYXBwZW5kXCIpIHtcbiAgICAgIGNvbnN0IHBhdGNoZXNUb051ZGdlID0gZXhpc3RpbmdQYXRjaGVzLnNsaWNlKHN0YXRlIS5wYXRjaGVzLmxlbmd0aClcbiAgICAgIGlmIChzZXF1ZW5jZU51bWJlciA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcInNlcXVlbmNlTnVtYmVyIGlzIHVuZGVmaW5lZCB3aGlsZSByZWJhc2luZ1wiKVxuICAgICAgfVxuICAgICAgaWYgKFxuICAgICAgICBwYXRjaGVzVG9OdWRnZVswXT8uc2VxdWVuY2VOdW1iZXIgIT09IHVuZGVmaW5lZCAmJlxuICAgICAgICBwYXRjaGVzVG9OdWRnZVswXS5zZXF1ZW5jZU51bWJlciA8PSBzZXF1ZW5jZU51bWJlclxuICAgICAgKSB7XG4gICAgICAgIGxldCBuZXh0ID0gc2VxdWVuY2VOdW1iZXIgKyAxXG4gICAgICAgIGZvciAoY29uc3QgcCBvZiBwYXRjaGVzVG9OdWRnZSkge1xuICAgICAgICAgIGNvbnN0IG5ld05hbWUgPSBjcmVhdGVQYXRjaEZpbGVOYW1lKHtcbiAgICAgICAgICAgIHBhY2thZ2VEZXRhaWxzLFxuICAgICAgICAgICAgcGFja2FnZVZlcnNpb24sXG4gICAgICAgICAgICBzZXF1ZW5jZU5hbWU6IHAuc2VxdWVuY2VOYW1lLFxuICAgICAgICAgICAgc2VxdWVuY2VOdW1iZXI6IG5leHQrKyxcbiAgICAgICAgICB9KVxuICAgICAgICAgIGNvbnNvbGUubG9nKFxuICAgICAgICAgICAgXCJSZW5hbWluZ1wiLFxuICAgICAgICAgICAgY2hhbGsuYm9sZChwLnBhdGNoRmlsZW5hbWUpLFxuICAgICAgICAgICAgXCJ0b1wiLFxuICAgICAgICAgICAgY2hhbGsuYm9sZChuZXdOYW1lKSxcbiAgICAgICAgICApXG4gICAgICAgICAgY29uc3Qgb2xkUGF0aCA9IGpvaW4oYXBwUGF0aCwgcGF0Y2hEaXIsIHAucGF0Y2hGaWxlbmFtZSlcbiAgICAgICAgICBjb25zdCBuZXdQYXRoID0gam9pbihhcHBQYXRoLCBwYXRjaERpciwgbmV3TmFtZSlcbiAgICAgICAgICByZW5hbWVTeW5jKG9sZFBhdGgsIG5ld1BhdGgpXG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICB3cml0ZUZpbGVTeW5jKHBhdGNoUGF0aCwgZGlmZlJlc3VsdC5zdGRvdXQpXG4gICAgY29uc29sZS5sb2coXG4gICAgICBgJHtjaGFsay5ncmVlbihcIuKclFwiKX0gQ3JlYXRlZCBmaWxlICR7am9pbihwYXRjaERpciwgcGF0Y2hGaWxlTmFtZSl9XFxuYCxcbiAgICApXG5cbiAgICBjb25zdCBwcmV2U3RhdGU6IFBhdGNoU3RhdGVbXSA9IHBhdGNoZXNUb0FwcGx5QmVmb3JlRGlmZmluZy5tYXAoXG4gICAgICAocCk6IFBhdGNoU3RhdGUgPT4gKHtcbiAgICAgICAgcGF0Y2hGaWxlbmFtZTogcC5wYXRjaEZpbGVuYW1lLFxuICAgICAgICBkaWRBcHBseTogdHJ1ZSxcbiAgICAgICAgcGF0Y2hDb250ZW50SGFzaDogaGFzaEZpbGUoam9pbihhcHBQYXRoLCBwYXRjaERpciwgcC5wYXRjaEZpbGVuYW1lKSksXG4gICAgICB9KSxcbiAgICApXG4gICAgY29uc3QgbmV4dFN0YXRlOiBQYXRjaFN0YXRlW10gPSBbXG4gICAgICAuLi5wcmV2U3RhdGUsXG4gICAgICB7XG4gICAgICAgIHBhdGNoRmlsZW5hbWU6IHBhdGNoRmlsZU5hbWUsXG4gICAgICAgIGRpZEFwcGx5OiB0cnVlLFxuICAgICAgICBwYXRjaENvbnRlbnRIYXNoOiBoYXNoRmlsZShwYXRjaFBhdGgpLFxuICAgICAgfSxcbiAgICBdXG5cbiAgICAvLyBpZiBhbnkgcGF0Y2hlcyBjb21lIGFmdGVyIHRoaXMgb25lIHdlIGp1c3QgbWFkZSwgd2Ugc2hvdWxkIHJlYXBwbHkgdGhlbVxuICAgIGxldCBkaWRGYWlsV2hpbGVGaW5pc2hpbmdSZWJhc2UgPSBmYWxzZVxuICAgIGlmIChpc1JlYmFzaW5nKSB7XG4gICAgICBjb25zdCBjdXJyZW50UGF0Y2hlcyA9IGdldEdyb3VwZWRQYXRjaGVzKGpvaW4oYXBwUGF0aCwgcGF0Y2hEaXIpKVxuICAgICAgICAucGF0aFNwZWNpZmllclRvUGF0Y2hGaWxlc1twYWNrYWdlRGV0YWlscy5wYXRoU3BlY2lmaWVyXVxuXG4gICAgICBjb25zdCBwcmV2aW91c2x5VW5hcHBsaWVkUGF0Y2hlcyA9IGN1cnJlbnRQYXRjaGVzLnNsaWNlKG5leHRTdGF0ZS5sZW5ndGgpXG4gICAgICBpZiAocHJldmlvdXNseVVuYXBwbGllZFBhdGNoZXMubGVuZ3RoKSB7XG4gICAgICAgIGNvbnNvbGUubG9nKGBGYXN0IGZvcndhcmRpbmcuLi5gKVxuICAgICAgICBmb3IgKGNvbnN0IHBhdGNoIG9mIHByZXZpb3VzbHlVbmFwcGxpZWRQYXRjaGVzKSB7XG4gICAgICAgICAgY29uc3QgcGF0Y2hGaWxlUGF0aCA9IGpvaW4oYXBwUGF0aCwgcGF0Y2hEaXIsIHBhdGNoLnBhdGNoRmlsZW5hbWUpXG4gICAgICAgICAgaWYgKFxuICAgICAgICAgICAgIWFwcGx5UGF0Y2goe1xuICAgICAgICAgICAgICBwYXRjaERldGFpbHM6IHBhdGNoLFxuICAgICAgICAgICAgICBwYXRjaERpcixcbiAgICAgICAgICAgICAgcGF0Y2hGaWxlUGF0aCxcbiAgICAgICAgICAgICAgcmV2ZXJzZTogZmFsc2UsXG4gICAgICAgICAgICAgIGN3ZDogcHJvY2Vzcy5jd2QoKSxcbiAgICAgICAgICAgICAgYmVzdEVmZm9ydDogZmFsc2UsXG4gICAgICAgICAgICB9KVxuICAgICAgICAgICkge1xuICAgICAgICAgICAgZGlkRmFpbFdoaWxlRmluaXNoaW5nUmViYXNlID0gdHJ1ZVxuICAgICAgICAgICAgbG9nUGF0Y2hTZXF1ZW5jZUVycm9yKHsgcGF0Y2hEZXRhaWxzOiBwYXRjaCB9KVxuICAgICAgICAgICAgbmV4dFN0YXRlLnB1c2goe1xuICAgICAgICAgICAgICBwYXRjaEZpbGVuYW1lOiBwYXRjaC5wYXRjaEZpbGVuYW1lLFxuICAgICAgICAgICAgICBkaWRBcHBseTogZmFsc2UsXG4gICAgICAgICAgICAgIHBhdGNoQ29udGVudEhhc2g6IGhhc2hGaWxlKHBhdGNoRmlsZVBhdGgpLFxuICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIGJyZWFrXG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKGAgICR7Y2hhbGsuZ3JlZW4oXCLinJRcIil9ICR7cGF0Y2gucGF0Y2hGaWxlbmFtZX1gKVxuICAgICAgICAgICAgbmV4dFN0YXRlLnB1c2goe1xuICAgICAgICAgICAgICBwYXRjaEZpbGVuYW1lOiBwYXRjaC5wYXRjaEZpbGVuYW1lLFxuICAgICAgICAgICAgICBkaWRBcHBseTogdHJ1ZSxcbiAgICAgICAgICAgICAgcGF0Y2hDb250ZW50SGFzaDogaGFzaEZpbGUocGF0Y2hGaWxlUGF0aCksXG4gICAgICAgICAgICB9KVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChpc1JlYmFzaW5nIHx8IG51bVBhdGNoZXNBZnRlckNyZWF0ZSA+IDEpIHtcbiAgICAgIHNhdmVQYXRjaEFwcGxpY2F0aW9uU3RhdGUoe1xuICAgICAgICBwYWNrYWdlRGV0YWlscyxcbiAgICAgICAgcGF0Y2hlczogbmV4dFN0YXRlLFxuICAgICAgICBpc1JlYmFzaW5nOiBkaWRGYWlsV2hpbGVGaW5pc2hpbmdSZWJhc2UsXG4gICAgICB9KVxuICAgIH0gZWxzZSB7XG4gICAgICBjbGVhclBhdGNoQXBwbGljYXRpb25TdGF0ZShwYWNrYWdlRGV0YWlscylcbiAgICB9XG5cbiAgICBpZiAoY2FuQ3JlYXRlSXNzdWUpIHtcbiAgICAgIGlmIChjcmVhdGVJc3N1ZSkge1xuICAgICAgICBvcGVuSXNzdWVDcmVhdGlvbkxpbmsoe1xuICAgICAgICAgIHBhY2thZ2VEZXRhaWxzLFxuICAgICAgICAgIHBhdGNoRmlsZUNvbnRlbnRzOiBkaWZmUmVzdWx0LnN0ZG91dC50b1N0cmluZygpLFxuICAgICAgICAgIHBhY2thZ2VWZXJzaW9uLFxuICAgICAgICB9KVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgbWF5YmVQcmludElzc3VlQ3JlYXRpb25Qcm9tcHQodmNzLCBwYWNrYWdlRGV0YWlscywgcGFja2FnZU1hbmFnZXIpXG4gICAgICB9XG4gICAgfVxuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5sb2coZSlcbiAgICB0aHJvdyBlXG4gIH0gZmluYWxseSB7XG4gICAgdG1wUmVwby5yZW1vdmVDYWxsYmFjaygpXG4gIH1cbn1cblxuZnVuY3Rpb24gY3JlYXRlUGF0Y2hGaWxlTmFtZSh7XG4gIHBhY2thZ2VEZXRhaWxzLFxuICBwYWNrYWdlVmVyc2lvbixcbiAgc2VxdWVuY2VOdW1iZXIsXG4gIHNlcXVlbmNlTmFtZSxcbn06IHtcbiAgcGFja2FnZURldGFpbHM6IFBhY2thZ2VEZXRhaWxzXG4gIHBhY2thZ2VWZXJzaW9uOiBzdHJpbmdcbiAgc2VxdWVuY2VOdW1iZXI/OiBudW1iZXJcbiAgc2VxdWVuY2VOYW1lPzogc3RyaW5nXG59KSB7XG4gIGNvbnN0IHBhY2thZ2VOYW1lcyA9IHBhY2thZ2VEZXRhaWxzLnBhY2thZ2VOYW1lc1xuICAgIC5tYXAoKG5hbWUpID0+IG5hbWUucmVwbGFjZSgvXFwvL2csIFwiK1wiKSlcbiAgICAuam9pbihcIisrXCIpXG5cbiAgY29uc3QgbmFtZUFuZFZlcnNpb24gPSBgJHtwYWNrYWdlTmFtZXN9KyR7cGFja2FnZVZlcnNpb259YFxuICBjb25zdCBudW0gPVxuICAgIHNlcXVlbmNlTnVtYmVyID09PSB1bmRlZmluZWRcbiAgICAgID8gXCJcIlxuICAgICAgOiBgKyR7c2VxdWVuY2VOdW1iZXIudG9TdHJpbmcoKS5wYWRTdGFydCgzLCBcIjBcIil9YFxuICBjb25zdCBuYW1lID0gIXNlcXVlbmNlTmFtZSA/IFwiXCIgOiBgKyR7c2VxdWVuY2VOYW1lfWBcblxuICByZXR1cm4gYCR7bmFtZUFuZFZlcnNpb259JHtudW19JHtuYW1lfS5wYXRjaGBcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGxvZ1BhdGNoU2VxdWVuY2VFcnJvcih7XG4gIHBhdGNoRGV0YWlscyxcbn06IHtcbiAgcGF0Y2hEZXRhaWxzOiBQYXRjaGVkUGFja2FnZURldGFpbHNcbn0pIHtcbiAgY29uc29sZS5sb2coYFxuJHtjaGFsay5yZWQuYm9sZChcIuKblCBFUlJPUlwiKX1cblxuRmFpbGVkIHRvIGFwcGx5IHBhdGNoIGZpbGUgJHtjaGFsay5ib2xkKHBhdGNoRGV0YWlscy5wYXRjaEZpbGVuYW1lKX0uXG5cbklmIHRoaXMgcGF0Y2ggZmlsZSBpcyBubyBsb25nZXIgdXNlZnVsLCBkZWxldGUgaXQgYW5kIHJ1blxuXG4gICR7Y2hhbGsuYm9sZChgcGF0Y2gtcGFja2FnZWApfVxuXG5UbyBwYXJ0aWFsbHkgYXBwbHkgdGhlIHBhdGNoIChpZiBwb3NzaWJsZSkgYW5kIG91dHB1dCBhIGxvZyBvZiBlcnJvcnMgdG8gZml4LCBydW5cblxuICAke2NoYWxrLmJvbGQoYHBhdGNoLXBhY2thZ2UgLS1wYXJ0aWFsYCl9XG5cbkFmdGVyIHdoaWNoIHlvdSBzaG91bGQgbWFrZSBhbnkgcmVxdWlyZWQgY2hhbmdlcyBpbnNpZGUgJHtcbiAgICBwYXRjaERldGFpbHMucGF0aFxuICB9LCBhbmQgZmluYWxseSBydW5cblxuICAke2NoYWxrLmJvbGQoYHBhdGNoLXBhY2thZ2UgJHtwYXRjaERldGFpbHMucGF0aFNwZWNpZmllcn1gKX1cblxudG8gdXBkYXRlIHRoZSBwYXRjaCBmaWxlLlxuYClcbn1cbiJdfQ==