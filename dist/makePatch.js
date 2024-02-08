import chalk from "chalk";
import console from "console";
import { renameSync } from "fs";
import { copySync, existsSync, mkdirpSync, mkdirSync, realpathSync, writeFileSync, } from "fs-extra";
import { sync as rimraf } from "rimraf";
import { dirSync } from "tmp";
import { gzipSync } from "zlib";
import { applyPatch } from "./applyPatches";
import { getPackageVCSDetails, maybePrintIssueCreationPrompt, openIssueCreationLink, shouldRecommendIssue, } from "./createIssue";
import { removeIgnoredFiles } from "./filterFiles";
import { getPackageResolution } from "./getPackageResolution";
import { getPackageVersion } from "./getPackageVersion";
import { hashFile } from "./hash";
import { getPatchDetailsFromCliString, } from "./PackageDetails";
import { parsePatchFile } from "./patch/parse";
import { getGroupedPatches } from "./patchFs";
import { dirname, join, resolve } from "./path";
import { resolveRelativeFileDependencies } from "./resolveRelativeFileDependencies";
import { spawnSafeSync } from "./spawnSafe";
import { clearPatchApplicationState, getPatchApplicationState, savePatchApplicationState, STATE_FILE_NAME, verifyAppliedPatches, } from "./stateFile";
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFrZVBhdGNoLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL21ha2VQYXRjaC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEtBQUssTUFBTSxPQUFPLENBQUE7QUFDekIsT0FBTyxPQUFPLE1BQU0sU0FBUyxDQUFBO0FBQzdCLE9BQU8sRUFBRSxVQUFVLEVBQUUsTUFBTSxJQUFJLENBQUE7QUFDL0IsT0FBTyxFQUNMLFFBQVEsRUFDUixVQUFVLEVBQ1YsVUFBVSxFQUNWLFNBQVMsRUFDVCxZQUFZLEVBQ1osYUFBYSxHQUNkLE1BQU0sVUFBVSxDQUFBO0FBQ2pCLE9BQU8sRUFBRSxJQUFJLElBQUksTUFBTSxFQUFFLE1BQU0sUUFBUSxDQUFBO0FBQ3ZDLE9BQU8sRUFBRSxPQUFPLEVBQUUsTUFBTSxLQUFLLENBQUE7QUFDN0IsT0FBTyxFQUFFLFFBQVEsRUFBRSxNQUFNLE1BQU0sQ0FBQTtBQUMvQixPQUFPLEVBQUUsVUFBVSxFQUFFLE1BQU0sZ0JBQWdCLENBQUE7QUFDM0MsT0FBTyxFQUNMLG9CQUFvQixFQUNwQiw2QkFBNkIsRUFDN0IscUJBQXFCLEVBQ3JCLG9CQUFvQixHQUNyQixNQUFNLGVBQWUsQ0FBQTtBQUV0QixPQUFPLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSxlQUFlLENBQUE7QUFDbEQsT0FBTyxFQUFFLG9CQUFvQixFQUFFLE1BQU0sd0JBQXdCLENBQUE7QUFDN0QsT0FBTyxFQUFFLGlCQUFpQixFQUFFLE1BQU0scUJBQXFCLENBQUE7QUFDdkQsT0FBTyxFQUFFLFFBQVEsRUFBRSxNQUFNLFFBQVEsQ0FBQTtBQUNqQyxPQUFPLEVBQ0wsNEJBQTRCLEdBRzdCLE1BQU0sa0JBQWtCLENBQUE7QUFDekIsT0FBTyxFQUFFLGNBQWMsRUFBRSxNQUFNLGVBQWUsQ0FBQTtBQUM5QyxPQUFPLEVBQUUsaUJBQWlCLEVBQUUsTUFBTSxXQUFXLENBQUE7QUFDN0MsT0FBTyxFQUFFLE9BQU8sRUFBRSxJQUFJLEVBQUUs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RyxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxHQUFHLENBQUMsQ0FBQztTQUN2QyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUE7SUFFYixNQUFNLGNBQWMsR0FBRyxHQUFHLFlBQVksSUFBSSxjQUFjLEVBQUUsQ0FBQTtJQUMxRCxNQUFNLEdBQUcsR0FDUCxjQUFjLEtBQUssU0FBUztRQUMxQixDQUFDLENBQUMsRUFBRTtRQUNKLENBQUMsQ0FBQyxJQUFJLGNBQWMsQ0FBQyxRQUFRLEVBQUUsQ0FBQyxRQUFRLENBQUMsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxFQUFFLENBQUE7SUFDdEQsTUFBTSxJQUFJLEdBQUcsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxZQUFZLEVBQUUsQ0FBQTtJQUVwRCxPQUFPLEdBQUcsY0FBYyxHQUFHLEdBQUcsR0FBRyxJQUFJLFFBQVEsQ0FBQTtBQUMvQyxDQUFDO0FBRUQsTUFBTSxVQUFVLHFCQUFxQixDQUFDLEVBQ3BDLFlBQVksR0FHYjtJQUNDLE9BQU8sQ0FBQyxHQUFHLENBQUM7RUFDWixLQUFLLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUM7OzZCQUVFLEtBQUssQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLGFBQWEsQ0FBQzs7OztJQUkvRCxLQUFLLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQzs7OztJQUkzQixLQUFLLENBQUMsSUFBSSxDQUFDLHlCQUF5QixDQUFDOzswREFHckMsWUFBWSxDQUFDLElBQ2Y7O0lBRUUsS0FBSyxDQUFDLElBQUksQ0FBQyxpQkFBaUIsWUFBWSxDQUFDLGFBQWEsRUFBRSxDQUFDOzs7Q0FHNUQsQ0FBQyxDQUFBO0FBQ0YsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBjaGFsayBmcm9tIFwiY2hhbGtcIlxuaW1wb3J0IGNvbnNvbGUgZnJvbSBcImNvbnNvbGVcIlxuaW1wb3J0IHsgcmVuYW1lU3luYyB9IGZyb20gXCJmc1wiXG5pbXBvcnQge1xuICBjb3B5U3luYyxcbiAgZXhpc3RzU3luYyxcbiAgbWtkaXJwU3luYyxcbiAgbWtkaXJTeW5jLFxuICByZWFscGF0aFN5bmMsXG4gIHdyaXRlRmlsZVN5bmMsXG59IGZyb20gXCJmcy1leHRyYVwiXG5pbXBvcnQgeyBzeW5jIGFzIHJpbXJhZiB9IGZyb20gXCJyaW1yYWZcIlxuaW1wb3J0IHsgZGlyU3luYyB9IGZyb20gXCJ0bXBcIlxuaW1wb3J0IHsgZ3ppcFN5bmMgfSBmcm9tIFwiemxpYlwiXG5pbXBvcnQgeyBhcHBseVBhdGNoIH0gZnJvbSBcIi4vYXBwbHlQYXRjaGVzXCJcbmltcG9ydCB7XG4gIGdldFBhY2thZ2VWQ1NEZXRhaWxzLFxuICBtYXliZVByaW50SXNzdWVDcmVhdGlvblByb21wdCxcbiAgb3Blbklzc3VlQ3JlYXRpb25MaW5rLFxuICBzaG91bGRSZWNvbW1lbmRJc3N1ZSxcbn0gZnJvbSBcIi4vY3JlYXRlSXNzdWVcIlxuaW1wb3J0IHsgUGFja2FnZU1hbmFnZXIgfSBmcm9tIFwiLi9kZXRlY3RQYWNrYWdlTWFuYWdlclwiXG5pbXBvcnQgeyByZW1vdmVJZ25vcmVkRmlsZXMgfSBmcm9tIFwiLi9maWx0ZXJGaWxlc1wiXG5pbXBvcnQgeyBnZXRQYWNrYWdlUmVzb2x1dGlvbiB9IGZyb20gXCIuL2dldFBhY2thZ2VSZXNvbHV0aW9uXCJcbmltcG9ydCB7IGdldFBhY2thZ2VWZXJzaW9uIH0gZnJvbSBcIi4vZ2V0UGFja2FnZVZlcnNpb25cIlxuaW1wb3J0IHsgaGFzaEZpbGUgfSBmcm9tIFwiLi9oYXNoXCJcbmltcG9ydCB7XG4gIGdldFBhdGNoRGV0YWlsc0Zyb21DbGlTdHJpbmcsXG4gIFBhY2thZ2VEZXRhaWxzLFxuICBQYXRjaGVkUGFja2FnZURldGFpbHMsXG59IGZyb20gXCIuL1BhY2thZ2VEZXRhaWxzXCJcbmltcG9ydCB7IHBhcnNlUGF0Y2hGaWxlIH0gZnJvbSBcIi4vcGF0Y2gvcGFyc2VcIlxuaW1wb3J0IHsgZ2V0R3JvdXBlZFBhdGNoZXMgfSBmcm9tIFwiLi9wYXRjaEZzXCJcbmltcG9ydCB7IGRpcm5hbWUsIGpvaW4sIHJlc29sdmUgfSBmcm9tIFwiLi9wYXRoXCJcbmltcG9ydCB7IHJlc29sdmVSZWxhdGl2ZUZpbGVEZXBlbmRlbmNpZXMgfSBmcm9tIFwiLi9yZXNvbHZlUmVsYXRpdmVGaWxlRGVwZW5kZW5jaWVzXCJcbmltcG9ydCB7IHNwYXduU2FmZVN5bmMgfSBmcm9tIFwiLi9zcGF3blNhZmVcIlxuaW1wb3J0IHtcbiAgY2xlYXJQYXRjaEFwcGxpY2F0aW9uU3RhdGUsXG4gIGdldFBhdGNoQXBwbGljYXRpb25TdGF0ZSxcbiAgUGF0Y2hTdGF0ZSxcbiAgc2F2ZVBhdGNoQXBwbGljYXRpb25TdGF0ZSxcbiAgU1RBVEVfRklMRV9OQU1FLFxuICB2ZXJpZnlBcHBsaWVkUGF0Y2hlcyxcbn0gZnJvbSBcIi4vc3RhdGVGaWxlXCJcblxuZnVuY3Rpb24gcHJpbnROb1BhY2thZ2VGb3VuZEVycm9yKFxuICBwYWNrYWdlTmFtZTogc3RyaW5nLFxuICBwYWNrYWdlSnNvblBhdGg6IHN0cmluZyxcbikge1xuICBjb25zb2xlLmxvZyhcbiAgICBgTm8gc3VjaCBwYWNrYWdlICR7cGFja2FnZU5hbWV9XG5cbiAgRmlsZSBub3QgZm91bmQ6ICR7cGFja2FnZUpzb25QYXRofWAsXG4gIClcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1ha2VQYXRjaCh7XG4gIHBhY2thZ2VQYXRoU3BlY2lmaWVyLFxuICBhcHBQYXRoLFxuICBwYWNrYWdlTWFuYWdlcixcbiAgaW5jbHVkZVBhdGhzLFxuICBleGNsdWRlUGF0aHMsXG4gIHBhdGNoRGlyLFxuICBjcmVhdGVJc3N1ZSxcbiAgbW9kZSxcbn06IHtcbiAgcGFja2FnZVBhdGhTcGVjaWZpZXI6IHN0cmluZ1xuICBhcHBQYXRoOiBzdHJpbmdcbiAgcGFja2FnZU1hbmFnZXI6IFBhY2thZ2VNYW5hZ2VyXG4gIGluY2x1ZGVQYXRoczogUmVnRXhwXG4gIGV4Y2x1ZGVQYXRoczogUmVnRXhwXG4gIHBhdGNoRGlyOiBzdHJpbmdcbiAgY3JlYXRlSXNzdWU6IGJvb2xlYW5cbiAgbW9kZTogeyB0eXBlOiBcIm92ZXJ3cml0ZV9sYXN0XCIgfSB8IHsgdHlwZTogXCJhcHBlbmRcIjsgbmFtZT86IHN0cmluZyB9XG59KSB7XG4gIGNvbnN0IHBhY2thZ2VEZXRhaWxzID0gZ2V0UGF0Y2hEZXRhaWxzRnJvbUNsaVN0cmluZyhwYWNrYWdlUGF0aFNwZWNpZmllcilcblxuICBpZiAoIXBhY2thZ2VEZXRhaWxzKSB7XG4gICAgY29uc29sZS5sb2coXCJObyBzdWNoIHBhY2thZ2VcIiwgcGFja2FnZVBhdGhTcGVjaWZpZXIpXG4gICAgcmV0dXJuXG4gIH1cblxuICBjb25zdCBzdGF0ZSA9IGdldFBhdGNoQXBwbGljYXRpb25TdGF0ZShwYWNrYWdlRGV0YWlscylcbiAgY29uc3QgaXNSZWJhc2luZyA9IHN0YXRlPy5pc1JlYmFzaW5nID8/IGZhbHNlXG5cbiAgLy8gSWYgd2UgYXJlIHJlYmFzaW5nIGFuZCBubyBwYXRjaGVzIGhhdmUgYmVlbiBhcHBsaWVkLCAtLWFwcGVuZCBpcyB0aGUgb25seSB2YWxpZCBvcHRpb24gYmVjYXVzZVxuICAvLyB0aGVyZSBhcmUgbm8gcHJldmlvdXMgcGF0Y2hlcyB0byBvdmVyd3JpdGUvdXBkYXRlXG4gIGlmIChcbiAgICBpc1JlYmFzaW5nICYmXG4gICAgc3RhdGU/LnBhdGNoZXMuZmlsdGVyKChwKSA9PiBwLmRpZEFwcGx5KS5sZW5ndGggPT09IDAgJiZcbiAgICBtb2RlLnR5cGUgPT09IFwib3ZlcndyaXRlX2xhc3RcIlxuICApIHtcbiAgICBtb2RlID0geyB0eXBlOiBcImFwcGVuZFwiLCBuYW1lOiBcImluaXRpYWxcIiB9XG4gIH1cblxuICBpZiAoaXNSZWJhc2luZyAmJiBzdGF0ZSkge1xuICAgIHZlcmlmeUFwcGxpZWRQYXRjaGVzKHsgYXBwUGF0aCwgcGF0Y2hEaXIsIHN0YXRlIH0pXG4gIH1cblxuICBpZiAoXG4gICAgbW9kZS50eXBlID09PSBcIm92ZXJ3cml0ZV9sYXN0XCIgJiZcbiAgICBpc1JlYmFzaW5nICYmXG4gICAgc3RhdGU/LnBhdGNoZXMubGVuZ3RoID09PSAwXG4gICkge1xuICAgIG1vZGUgPSB7IHR5cGU6IFwiYXBwZW5kXCIsIG5hbWU6IFwiaW5pdGlhbFwiIH1cbiAgfVxuXG4gIGNvbnN0IGV4aXN0aW5nUGF0Y2hlcyA9XG4gICAgZ2V0R3JvdXBlZFBhdGNoZXMocGF0Y2hEaXIpLnBhdGhTcGVjaWZpZXJUb1BhdGNoRmlsZXNbXG4gICAgICBwYWNrYWdlRGV0YWlscy5wYXRoU3BlY2lmaWVyXG4gICAgXSB8fCBbXVxuXG4gIC8vIGFwcGx5IGFsbCBleGlzdGluZyBwYXRjaGVzIGlmIGFwcGVuZGluZ1xuICAvLyBvdGhlcndpc2UgYXBwbHkgYWxsIGJ1dCB0aGUgbGFzdFxuICBjb25zdCBwcmV2aW91c2x5QXBwbGllZFBhdGNoZXMgPSBzdGF0ZT8ucGF0Y2hlcy5maWx0ZXIoKHApID0+IHAuZGlkQXBwbHkpXG4gIGNvbnN0IHBhdGNoZXNUb0FwcGx5QmVmb3JlRGlmZmluZzogUGF0Y2hlZFBhY2thZ2VEZXRhaWxzW10gPSBpc1JlYmFzaW5nXG4gICAgPyBtb2RlLnR5cGUgPT09IFwiYXBwZW5kXCJcbiAgICAgID8gZXhpc3RpbmdQYXRjaGVzLnNsaWNlKDAsIHByZXZpb3VzbHlBcHBsaWVkUGF0Y2hlcyEubGVuZ3RoKVxuICAgICAgOiBzdGF0ZSEucGF0Y2hlc1tzdGF0ZSEucGF0Y2hlcy5sZW5ndGggLSAxXS5kaWRBcHBseVxuICAgICAgPyBleGlzdGluZ1BhdGNoZXMuc2xpY2UoMCwgcHJldmlvdXNseUFwcGxpZWRQYXRjaGVzIS5sZW5ndGggLSAxKVxuICAgICAgOiBleGlzdGluZ1BhdGNoZXMuc2xpY2UoMCwgcHJldmlvdXNseUFwcGxpZWRQYXRjaGVzIS5sZW5ndGgpXG4gICAgOiBtb2RlLnR5cGUgPT09IFwiYXBwZW5kXCJcbiAgICA/IGV4aXN0aW5nUGF0Y2hlc1xuICAgIDogZXhpc3RpbmdQYXRjaGVzLnNsaWNlKDAsIC0xKVxuXG4gIGlmIChjcmVhdGVJc3N1ZSAmJiBtb2RlLnR5cGUgPT09IFwiYXBwZW5kXCIpIHtcbiAgICBjb25zb2xlLmxvZyhcIi0tY3JlYXRlLWlzc3VlIGlzIG5vdCBjb21wYXRpYmxlIHdpdGggLS1hcHBlbmQuXCIpXG4gICAgcHJvY2Vzcy5leGl0KDEpXG4gIH1cblxuICBpZiAoY3JlYXRlSXNzdWUgJiYgaXNSZWJhc2luZykge1xuICAgIGNvbnNvbGUubG9nKFwiLS1jcmVhdGUtaXNzdWUgaXMgbm90IGNvbXBhdGlibGUgd2l0aCByZWJhc2luZy5cIilcbiAgICBwcm9jZXNzLmV4aXQoMSlcbiAgfVxuXG4gIGNvbnN0IG51bVBhdGNoZXNBZnRlckNyZWF0ZSA9XG4gICAgbW9kZS50eXBlID09PSBcImFwcGVuZFwiIHx8IGV4aXN0aW5nUGF0Y2hlcy5sZW5ndGggPT09IDBcbiAgICAgID8gZXhpc3RpbmdQYXRjaGVzLmxlbmd0aCArIDFcbiAgICAgIDogZXhpc3RpbmdQYXRjaGVzLmxlbmd0aFxuICBjb25zdCB2Y3MgPSBnZXRQYWNrYWdlVkNTRGV0YWlscyhwYWNrYWdlRGV0YWlscylcbiAgY29uc3QgY2FuQ3JlYXRlSXNzdWUgPVxuICAgICFpc1JlYmFzaW5nICYmXG4gICAgc2hvdWxkUmVjb21tZW5kSXNzdWUodmNzKSAmJlxuICAgIG51bVBhdGNoZXNBZnRlckNyZWF0ZSA9PT0gMSAmJlxuICAgIG1vZGUudHlwZSAhPT0gXCJhcHBlbmRcIlxuXG4gIGNvbnN0IGFwcFBhY2thZ2VKc29uID0gcmVxdWlyZShqb2luKGFwcFBhdGgsIFwicGFja2FnZS5qc29uXCIpKVxuICBjb25zdCBwYWNrYWdlUGF0aCA9IGpvaW4oYXBwUGF0aCwgcGFja2FnZURldGFpbHMucGF0aClcbiAgY29uc3QgcGFja2FnZUpzb25QYXRoID0gam9pbihwYWNrYWdlUGF0aCwgXCJwYWNrYWdlLmpzb25cIilcblxuICBpZiAoIWV4aXN0c1N5bmMocGFja2FnZUpzb25QYXRoKSkge1xuICAgIHByaW50Tm9QYWNrYWdlRm91bmRFcnJvcihwYWNrYWdlUGF0aFNwZWNpZmllciwgcGFja2FnZUpzb25QYXRoKVxuICAgIHByb2Nlc3MuZXhpdCgxKVxuICB9XG5cbiAgY29uc3QgdG1wUmVwbyA9IGRpclN5bmMoeyB1bnNhZmVDbGVhbnVwOiB0cnVlIH0pXG4gIGNvbnN0IHRtcFJlcG9QYWNrYWdlUGF0aCA9IGpvaW4odG1wUmVwby5uYW1lLCBwYWNrYWdlRGV0YWlscy5wYXRoKVxuICBjb25zdCB0bXBSZXBvTnBtUm9vdCA9IHRtcFJlcG9QYWNrYWdlUGF0aC5zbGljZShcbiAgICAwLFxuICAgIC1gL25vZGVfbW9kdWxlcy8ke3BhY2thZ2VEZXRhaWxzLm5hbWV9YC5sZW5ndGgsXG4gIClcblxuICBjb25zdCB0bXBSZXBvUGFja2FnZUpzb25QYXRoID0gam9pbih0bXBSZXBvTnBtUm9vdCwgXCJwYWNrYWdlLmpzb25cIilcblxuICB0cnkge1xuICAgIGNvbnN0IHBhdGNoZXNEaXIgPSByZXNvbHZlKGpvaW4oYXBwUGF0aCwgcGF0Y2hEaXIpKVxuXG4gICAgY29uc29sZS5pbmZvKGNoYWxrLmdyZXkoXCLigKJcIiksIFwiQ3JlYXRpbmcgdGVtcG9yYXJ5IGZvbGRlclwiKVxuXG4gICAgLy8gbWFrZSBhIGJsYW5rIHBhY2thZ2UuanNvblxuICAgIG1rZGlycFN5bmModG1wUmVwb05wbVJvb3QpXG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIHRtcFJlcG9QYWNrYWdlSnNvblBhdGgsXG4gICAgICBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGRlcGVuZGVuY2llczoge1xuICAgICAgICAgIFtwYWNrYWdlRGV0YWlscy5uYW1lXTogZ2V0UGFja2FnZVJlc29sdXRpb24oe1xuICAgICAgICAgICAgcGFja2FnZURldGFpbHMsXG4gICAgICAgICAgICBwYWNrYWdlTWFuYWdlcixcbiAgICAgICAgICAgIGFwcFBhdGgsXG4gICAgICAgICAgfSksXG4gICAgICAgIH0sXG4gICAgICAgIHJlc29sdXRpb25zOiByZXNvbHZlUmVsYXRpdmVGaWxlRGVwZW5kZW5jaWVzKFxuICAgICAgICAgIGFwcFBhdGgsXG4gICAgICAgICAgYXBwUGFja2FnZUpzb24ucmVzb2x1dGlvbnMgfHwge30sXG4gICAgICAgICksXG4gICAgICB9KSxcbiAgICApXG5cbiAgICBjb25zdCBwYWNrYWdlVmVyc2lvbiA9IGdldFBhY2thZ2VWZXJzaW9uKFxuICAgICAgam9pbihyZXNvbHZlKHBhY2thZ2VEZXRhaWxzLnBhdGgpLCBcInBhY2thZ2UuanNvblwiKSxcbiAgICApXG5cbiAgICAvLyBjb3B5IC5ucG1yYy8ueWFybnJjIGluIGNhc2UgcGFja2FnZXMgYXJlIGhvc3RlZCBpbiBwcml2YXRlIHJlZ2lzdHJ5XG4gICAgLy8gY29weSAueWFybiBkaXJlY3RvcnkgYXMgd2VsbCB0byBlbnN1cmUgaW5zdGFsbGF0aW9ucyB3b3JrIGluIHlhcm4gMlxuICAgIC8vIHRzbGludDpkaXNhYmxlLW5leHQtbGluZTphbGlnblxuICAgIDtbXCIubnBtcmNcIiwgXCIueWFybnJjXCIsIFwiLnlhcm5cIl0uZm9yRWFjaCgocmNGaWxlKSA9PiB7XG4gICAgICBjb25zdCByY1BhdGggPSBqb2luKGFwcFBhdGgsIHJjRmlsZSlcbiAgICAgIGlmIChleGlzdHNTeW5jKHJjUGF0aCkpIHtcbiAgICAgICAgY29weVN5bmMocmNQYXRoLCBqb2luKHRtcFJlcG8ubmFtZSwgcmNGaWxlKSwgeyBkZXJlZmVyZW5jZTogdHJ1ZSB9KVxuICAgICAgfVxuICAgIH0pXG5cbiAgICBpZiAocGFja2FnZU1hbmFnZXIgPT09IFwieWFyblwiKSB7XG4gICAgICBjb25zb2xlLmluZm8oXG4gICAgICAgIGNoYWxrLmdyZXkoXCLigKJcIiksXG4gICAgICAgIGBJbnN0YWxsaW5nICR7cGFja2FnZURldGFpbHMubmFtZX1AJHtwYWNrYWdlVmVyc2lvbn0gd2l0aCB5YXJuYCxcbiAgICAgIClcbiAgICAgIHRyeSB7XG4gICAgICAgIC8vIHRyeSBmaXJzdCB3aXRob3V0IGlnbm9yaW5nIHNjcmlwdHMgaW4gY2FzZSB0aGV5IGFyZSByZXF1aXJlZFxuICAgICAgICAvLyB0aGlzIHdvcmtzIGluIDk5Ljk5JSBvZiBjYXNlc1xuICAgICAgICBzcGF3blNhZmVTeW5jKGB5YXJuYCwgW1wiaW5zdGFsbFwiLCBcIi0taWdub3JlLWVuZ2luZXNcIl0sIHtcbiAgICAgICAgICBjd2Q6IHRtcFJlcG9OcG1Sb290LFxuICAgICAgICAgIGxvZ1N0ZEVyck9uRXJyb3I6IGZhbHNlLFxuICAgICAgICB9KVxuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAvLyB0cnkgYWdhaW4gd2hpbGUgaWdub3Jpbmcgc2NyaXB0cyBpbiBjYXNlIHRoZSBzY3JpcHQgZGVwZW5kcyBvblxuICAgICAgICAvLyBhbiBpbXBsaWNpdCBjb250ZXh0IHdoaWNoIHdlIGhhdmVuJ3QgcmVwcm9kdWNlZFxuICAgICAgICBzcGF3blNhZmVTeW5jKFxuICAgICAgICAgIGB5YXJuYCxcbiAgICAgICAgICBbXCJpbnN0YWxsXCIsIFwiLS1pZ25vcmUtZW5naW5lc1wiLCBcIi0taWdub3JlLXNjcmlwdHNcIl0sXG4gICAgICAgICAge1xuICAgICAgICAgICAgY3dkOiB0bXBSZXBvTnBtUm9vdCxcbiAgICAgICAgICB9LFxuICAgICAgICApXG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnNvbGUuaW5mbyhcbiAgICAgICAgY2hhbGsuZ3JleShcIuKAolwiKSxcbiAgICAgICAgYEluc3RhbGxpbmcgJHtwYWNrYWdlRGV0YWlscy5uYW1lfUAke3BhY2thZ2VWZXJzaW9ufSB3aXRoIG5wbWAsXG4gICAgICApXG4gICAgICB0cnkge1xuICAgICAgICAvLyB0cnkgZmlyc3Qgd2l0aG91dCBpZ25vcmluZyBzY3JpcHRzIGluIGNhc2UgdGhleSBhcmUgcmVxdWlyZWRcbiAgICAgICAgLy8gdGhpcyB3b3JrcyBpbiA5OS45OSUgb2YgY2FzZXNcbiAgICAgICAgc3Bhd25TYWZlU3luYyhgbnBtYCwgW1wiaVwiLCBcIi0tZm9yY2VcIl0sIHtcbiAgICAgICAgICBjd2Q6IHRtcFJlcG9OcG1Sb290LFxuICAgICAgICAgIGxvZ1N0ZEVyck9uRXJyb3I6IGZhbHNlLFxuICAgICAgICAgIHN0ZGlvOiBcImlnbm9yZVwiLFxuICAgICAgICB9KVxuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAvLyB0cnkgYWdhaW4gd2hpbGUgaWdub3Jpbmcgc2NyaXB0cyBpbiBjYXNlIHRoZSBzY3JpcHQgZGVwZW5kcyBvblxuICAgICAgICAvLyBhbiBpbXBsaWNpdCBjb250ZXh0IHdoaWNoIHdlIGhhdmVuJ3QgcmVwcm9kdWNlZFxuICAgICAgICBzcGF3blNhZmVTeW5jKGBucG1gLCBbXCJpXCIsIFwiLS1pZ25vcmUtc2NyaXB0c1wiLCBcIi0tZm9yY2VcIl0sIHtcbiAgICAgICAgICBjd2Q6IHRtcFJlcG9OcG1Sb290LFxuICAgICAgICAgIHN0ZGlvOiBcImlnbm9yZVwiLFxuICAgICAgICB9KVxuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IGdpdCA9ICguLi5hcmdzOiBzdHJpbmdbXSkgPT5cbiAgICAgIHNwYXduU2FmZVN5bmMoXCJnaXRcIiwgYXJncywge1xuICAgICAgICBjd2Q6IHRtcFJlcG8ubmFtZSxcbiAgICAgICAgZW52OiB7IC4uLnByb2Nlc3MuZW52LCBIT01FOiB0bXBSZXBvLm5hbWUgfSxcbiAgICAgICAgbWF4QnVmZmVyOiAxMDI0ICogMTAyNCAqIDEwMCxcbiAgICAgIH0pXG5cbiAgICAvLyByZW1vdmUgbmVzdGVkIG5vZGVfbW9kdWxlcyBqdXN0IHRvIGJlIHNhZmVcbiAgICByaW1yYWYoam9pbih0bXBSZXBvUGFja2FnZVBhdGgsIFwibm9kZV9tb2R1bGVzXCIpKVxuICAgIC8vIHJlbW92ZSAuZ2l0IGp1c3QgdG8gYmUgc2FmZVxuICAgIHJpbXJhZihqb2luKHRtcFJlcG9QYWNrYWdlUGF0aCwgXCIuZ2l0XCIpKVxuICAgIC8vIHJlbW92ZSBwYXRjaC1wYWNrYWdlIHN0YXRlIGZpbGVcbiAgICByaW1yYWYoam9pbih0bXBSZXBvUGFja2FnZVBhdGgsIFNUQVRFX0ZJTEVfTkFNRSkpXG5cbiAgICAvLyBjb21taXQgdGhlIHBhY2thZ2VcbiAgICBjb25zb2xlLmluZm8oY2hhbGsuZ3JleShcIuKAolwiKSwgXCJEaWZmaW5nIHlvdXIgZmlsZXMgd2l0aCBjbGVhbiBmaWxlc1wiKVxuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0bXBSZXBvLm5hbWUsIFwiLmdpdGlnbm9yZVwiKSwgXCIhL25vZGVfbW9kdWxlc1xcblxcblwiKVxuICAgIGdpdChcImluaXRcIilcbiAgICBnaXQoXCJjb25maWdcIiwgXCItLWxvY2FsXCIsIFwidXNlci5uYW1lXCIsIFwicGF0Y2gtcGFja2FnZVwiKVxuICAgIGdpdChcImNvbmZpZ1wiLCBcIi0tbG9jYWxcIiwgXCJ1c2VyLmVtYWlsXCIsIFwicGF0Y2hAcGFjay5hZ2VcIilcblxuICAgIC8vIHJlbW92ZSBpZ25vcmVkIGZpbGVzIGZpcnN0XG4gICAgcmVtb3ZlSWdub3JlZEZpbGVzKHRtcFJlcG9QYWNrYWdlUGF0aCwgaW5jbHVkZVBhdGhzLCBleGNsdWRlUGF0aHMpXG5cbiAgICBmb3IgKGNvbnN0IHBhdGNoRGV0YWlscyBvZiBwYXRjaGVzVG9BcHBseUJlZm9yZURpZmZpbmcpIHtcbiAgICAgIGlmIChcbiAgICAgICAgIWFwcGx5UGF0Y2goe1xuICAgICAgICAgIHBhdGNoRGV0YWlscyxcbiAgICAgICAgICBwYXRjaERpcixcbiAgICAgICAgICBwYXRjaEZpbGVQYXRoOiBqb2luKGFwcFBhdGgsIHBhdGNoRGlyLCBwYXRjaERldGFpbHMucGF0Y2hGaWxlbmFtZSksXG4gICAgICAgICAgcmV2ZXJzZTogZmFsc2UsXG4gICAgICAgICAgY3dkOiB0bXBSZXBvLm5hbWUsXG4gICAgICAgICAgYmVzdEVmZm9ydDogZmFsc2UsXG4gICAgICAgIH0pXG4gICAgICApIHtcbiAgICAgICAgLy8gVE9ETzogYWRkIGJldHRlciBlcnJvciBtZXNzYWdlIG9uY2UgLS1yZWJhc2UgaXMgaW1wbGVtZW50ZWRcbiAgICAgICAgY29uc29sZS5sb2coXG4gICAgICAgICAgYEZhaWxlZCB0byBhcHBseSBwYXRjaCAke3BhdGNoRGV0YWlscy5wYXRjaEZpbGVuYW1lfSB0byAke3BhY2thZ2VEZXRhaWxzLnBhdGhTcGVjaWZpZXJ9YCxcbiAgICAgICAgKVxuICAgICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICAgIH1cbiAgICB9XG4gICAgZ2l0KFwiYWRkXCIsIFwiLWZcIiwgcGFja2FnZURldGFpbHMucGF0aClcbiAgICBnaXQoXCJjb21taXRcIiwgXCItLWFsbG93LWVtcHR5XCIsIFwiLW1cIiwgXCJpbml0XCIpXG5cbiAgICAvLyByZXBsYWNlIHBhY2thZ2Ugd2l0aCB1c2VyJ3MgdmVyc2lvblxuICAgIHJpbXJhZih0bXBSZXBvUGFja2FnZVBhdGgpXG5cbiAgICAvLyBwbnBtIGluc3RhbGxzIHBhY2thZ2VzIGFzIHN5bWxpbmtzLCBjb3B5U3luYyB3b3VsZCBjb3B5IG9ubHkgdGhlIHN5bWxpbmtcbiAgICBjb3B5U3luYyhyZWFscGF0aFN5bmMocGFja2FnZVBhdGgpLCB0bXBSZXBvUGFja2FnZVBhdGgpXG5cbiAgICAvLyByZW1vdmUgbmVzdGVkIG5vZGVfbW9kdWxlcyBqdXN0IHRvIGJlIHNhZmVcbiAgICByaW1yYWYoam9pbih0bXBSZXBvUGFja2FnZVBhdGgsIFwibm9kZV9tb2R1bGVzXCIpKVxuICAgIC8vIHJlbW92ZSAuZ2l0IGp1c3QgdG8gYmUgc2FmZVxuICAgIHJpbXJhZihqb2luKHRtcFJlcG9QYWNrYWdlUGF0aCwgXCIuZ2l0XCIpKVxuICAgIC8vIHJlbW92ZSBwYXRjaC1wYWNrYWdlIHN0YXRlIGZpbGVcbiAgICByaW1yYWYoam9pbih0bXBSZXBvUGFja2FnZVBhdGgsIFNUQVRFX0ZJTEVfTkFNRSkpXG5cbiAgICAvLyBhbHNvIHJlbW92ZSBpZ25vcmVkIGZpbGVzIGxpa2UgYmVmb3JlXG4gICAgcmVtb3ZlSWdub3JlZEZpbGVzKHRtcFJlcG9QYWNrYWdlUGF0aCwgaW5jbHVkZVBhdGhzLCBleGNsdWRlUGF0aHMpXG5cbiAgICAvLyBzdGFnZSBhbGwgZmlsZXNcbiAgICBnaXQoXCJhZGRcIiwgXCItZlwiLCBwYWNrYWdlRGV0YWlscy5wYXRoKVxuXG4gICAgLy8gZ2V0IGRpZmYgb2YgY2hhbmdlc1xuICAgIGNvbnN0IGRpZmZSZXN1bHQgPSBnaXQoXG4gICAgICBcImRpZmZcIixcbiAgICAgIFwiLS1jYWNoZWRcIixcbiAgICAgIFwiLS1uby1jb2xvclwiLFxuICAgICAgXCItLWlnbm9yZS1zcGFjZS1hdC1lb2xcIixcbiAgICAgIFwiLS1uby1leHQtZGlmZlwiLFxuICAgICAgXCItLXNyYy1wcmVmaXg9YS9cIixcbiAgICAgIFwiLS1kc3QtcHJlZml4PWIvXCIsXG4gICAgKVxuXG4gICAgaWYgKGRpZmZSZXN1bHQuc3Rkb3V0Lmxlbmd0aCA9PT0gMCkge1xuICAgICAgY29uc29sZS5sb2coXG4gICAgICAgIGDigYnvuI8gIE5vdCBjcmVhdGluZyBwYXRjaCBmaWxlIGZvciBwYWNrYWdlICcke3BhY2thZ2VQYXRoU3BlY2lmaWVyfSdgLFxuICAgICAgKVxuICAgICAgY29uc29sZS5sb2coYOKBie+4jyAgVGhlcmUgZG9uJ3QgYXBwZWFyIHRvIGJlIGFueSBjaGFuZ2VzLmApXG4gICAgICBpZiAoaXNSZWJhc2luZyAmJiBtb2RlLnR5cGUgPT09IFwib3ZlcndyaXRlX2xhc3RcIikge1xuICAgICAgICBjb25zb2xlLmxvZyhcbiAgICAgICAgICBcIlxcbvCfkqEgVG8gcmVtb3ZlIGEgcGF0Y2ggZmlsZSwgZGVsZXRlIGl0IGFuZCB0aGVuIHJlaW5zdGFsbCBub2RlX21vZHVsZXMgZnJvbSBzY3JhdGNoLlwiLFxuICAgICAgICApXG4gICAgICB9XG4gICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIHRyeSB7XG4gICAgICBwYXJzZVBhdGNoRmlsZShkaWZmUmVzdWx0LnN0ZG91dC50b1N0cmluZygpKVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGlmIChcbiAgICAgICAgKGUgYXMgRXJyb3IpLm1lc3NhZ2UuaW5jbHVkZXMoXCJVbmV4cGVjdGVkIGZpbGUgbW9kZSBzdHJpbmc6IDEyMDAwMFwiKVxuICAgICAgKSB7XG4gICAgICAgIGNvbnNvbGUubG9nKGBcbuKblO+4jyAke2NoYWxrLnJlZC5ib2xkKFwiRVJST1JcIil9XG5cbiAgWW91ciBjaGFuZ2VzIGludm9sdmUgY3JlYXRpbmcgc3ltbGlua3MuIHBhdGNoLXBhY2thZ2UgZG9lcyBub3QgeWV0IHN1cHBvcnRcbiAgc3ltbGlua3MuXG4gIFxuICDvuI9QbGVhc2UgdXNlICR7Y2hhbGsuYm9sZChcIi0taW5jbHVkZVwiKX0gYW5kL29yICR7Y2hhbGsuYm9sZChcbiAgICAgICAgICBcIi0tZXhjbHVkZVwiLFxuICAgICAgICApfSB0byBuYXJyb3cgdGhlIHNjb3BlIG9mIHlvdXIgcGF0Y2ggaWZcbiAgdGhpcyB3YXMgdW5pbnRlbnRpb25hbC5cbmApXG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCBvdXRQYXRoID0gXCIuL3BhdGNoLXBhY2thZ2UtZXJyb3IuanNvbi5nelwiXG4gICAgICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICAgICAgb3V0UGF0aCxcbiAgICAgICAgICBnemlwU3luYyhcbiAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICAgICAgZXJyb3I6IHsgbWVzc2FnZTogZS5tZXNzYWdlLCBzdGFjazogZS5zdGFjayB9LFxuICAgICAgICAgICAgICBwYXRjaDogZGlmZlJlc3VsdC5zdGRvdXQudG9TdHJpbmcoKSxcbiAgICAgICAgICAgIH0pLFxuICAgICAgICAgICksXG4gICAgICAgIClcbiAgICAgICAgY29uc29sZS5sb2coYFxu4puU77iPICR7Y2hhbGsucmVkLmJvbGQoXCJFUlJPUlwiKX1cbiAgICAgICAgXG4gIHBhdGNoLXBhY2thZ2Ugd2FzIHVuYWJsZSB0byByZWFkIHRoZSBwYXRjaC1maWxlIG1hZGUgYnkgZ2l0LiBUaGlzIHNob3VsZCBub3RcbiAgaGFwcGVuLlxuICBcbiAgQSBkaWFnbm9zdGljIGZpbGUgd2FzIHdyaXR0ZW4gdG9cbiAgXG4gICAgJHtvdXRQYXRofVxuICBcbiAgUGxlYXNlIGF0dGFjaCBpdCB0byBhIGdpdGh1YiBpc3N1ZVxuICBcbiAgICBodHRwczovL2dpdGh1Yi5jb20vZHMzMDAvcGF0Y2gtcGFja2FnZS9pc3N1ZXMvbmV3P3RpdGxlPU5ldytwYXRjaCtwYXJzZStmYWlsZWQmYm9keT1QbGVhc2UrYXR0YWNoK3RoZStkaWFnbm9zdGljK2ZpbGUrYnkrZHJhZ2dpbmcraXQraW50bytoZXJlK/CfmY9cbiAgXG4gIE5vdGUgdGhhdCB0aGlzIGRpYWdub3N0aWMgZmlsZSB3aWxsIGNvbnRhaW4gY29kZSBmcm9tIHRoZSBwYWNrYWdlIHlvdSB3ZXJlXG4gIGF0dGVtcHRpbmcgdG8gcGF0Y2guXG5cbmApXG4gICAgICB9XG4gICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIC8vIG1heWJlIGRlbGV0ZSBleGlzdGluZ1xuICAgIGlmIChtb2RlLnR5cGUgPT09IFwiYXBwZW5kXCIgJiYgIWlzUmViYXNpbmcgJiYgZXhpc3RpbmdQYXRjaGVzLmxlbmd0aCA9PT0gMSkge1xuICAgICAgLy8gaWYgd2UgYXJlIGFwcGVuZGluZyB0byBhbiBleGlzdGluZyBwYXRjaCB0aGF0IGRvZXNuJ3QgaGF2ZSBhIHNlcXVlbmNlIG51bWJlciBsZXQncyByZW5hbWUgaXRcbiAgICAgIGNvbnN0IHByZXZQYXRjaCA9IGV4aXN0aW5nUGF0Y2hlc1swXVxuICAgICAgaWYgKHByZXZQYXRjaC5zZXF1ZW5jZU51bWJlciA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGNvbnN0IG5ld0ZpbGVOYW1lID0gY3JlYXRlUGF0Y2hGaWxlTmFtZSh7XG4gICAgICAgICAgcGFja2FnZURldGFpbHMsXG4gICAgICAgICAgcGFja2FnZVZlcnNpb24sXG4gICAgICAgICAgc2VxdWVuY2VOdW1iZXI6IDEsXG4gICAgICAgICAgc2VxdWVuY2VOYW1lOiBwcmV2UGF0Y2guc2VxdWVuY2VOYW1lID8/IFwiaW5pdGlhbFwiLFxuICAgICAgICB9KVxuICAgICAgICBjb25zdCBvbGRQYXRoID0gam9pbihhcHBQYXRoLCBwYXRjaERpciwgcHJldlBhdGNoLnBhdGNoRmlsZW5hbWUpXG4gICAgICAgIGNvbnN0IG5ld1BhdGggPSBqb2luKGFwcFBhdGgsIHBhdGNoRGlyLCBuZXdGaWxlTmFtZSlcbiAgICAgICAgcmVuYW1lU3luYyhvbGRQYXRoLCBuZXdQYXRoKVxuICAgICAgICBwcmV2UGF0Y2guc2VxdWVuY2VOdW1iZXIgPSAxXG4gICAgICAgIHByZXZQYXRjaC5wYXRjaEZpbGVuYW1lID0gbmV3RmlsZU5hbWVcbiAgICAgICAgcHJldlBhdGNoLnNlcXVlbmNlTmFtZSA9IHByZXZQYXRjaC5zZXF1ZW5jZU5hbWUgPz8gXCJpbml0aWFsXCJcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBsYXN0UGF0Y2ggPSBleGlzdGluZ1BhdGNoZXNbXG4gICAgICBzdGF0ZSA/IHN0YXRlLnBhdGNoZXMubGVuZ3RoIC0gMSA6IGV4aXN0aW5nUGF0Y2hlcy5sZW5ndGggLSAxXG4gICAgXSBhcyBQYXRjaGVkUGFja2FnZURldGFpbHMgfCB1bmRlZmluZWRcbiAgICBjb25zdCBzZXF1ZW5jZU5hbWUgPVxuICAgICAgbW9kZS50eXBlID09PSBcImFwcGVuZFwiID8gbW9kZS5uYW1lIDogbGFzdFBhdGNoPy5zZXF1ZW5jZU5hbWVcbiAgICBjb25zdCBzZXF1ZW5jZU51bWJlciA9XG4gICAgICBtb2RlLnR5cGUgPT09IFwiYXBwZW5kXCJcbiAgICAgICAgPyAobGFzdFBhdGNoPy5zZXF1ZW5jZU51bWJlciA/PyAwKSArIDFcbiAgICAgICAgOiBsYXN0UGF0Y2g/LnNlcXVlbmNlTnVtYmVyXG5cbiAgICBjb25zdCBwYXRjaEZpbGVOYW1lID0gY3JlYXRlUGF0Y2hGaWxlTmFtZSh7XG4gICAgICBwYWNrYWdlRGV0YWlscyxcbiAgICAgIHBhY2thZ2VWZXJzaW9uLFxuICAgICAgc2VxdWVuY2VOYW1lLFxuICAgICAgc2VxdWVuY2VOdW1iZXIsXG4gICAgfSlcblxuICAgIGNvbnN0IHBhdGNoUGF0aCA9IGpvaW4ocGF0Y2hlc0RpciwgcGF0Y2hGaWxlTmFtZSlcbiAgICBpZiAoIWV4aXN0c1N5bmMoZGlybmFtZShwYXRjaFBhdGgpKSkge1xuICAgICAgLy8gc2NvcGVkIHBhY2thZ2VcbiAgICAgIG1rZGlyU3luYyhkaXJuYW1lKHBhdGNoUGF0aCkpXG4gICAgfVxuXG4gICAgLy8gaWYgd2UgYXJlIGluc2VydGluZyBhIG5ldyBwYXRjaCBpbnRvIGEgc2VxdWVuY2Ugd2UgbW9zdCBsaWtlbHkgbmVlZCB0byB1cGRhdGUgdGhlIHNlcXVlbmNlIG51bWJlcnNcbiAgICBpZiAoaXNSZWJhc2luZyAmJiBtb2RlLnR5cGUgPT09IFwiYXBwZW5kXCIpIHtcbiAgICAgIGNvbnN0IHBhdGNoZXNUb051ZGdlID0gZXhpc3RpbmdQYXRjaGVzLnNsaWNlKHN0YXRlIS5wYXRjaGVzLmxlbmd0aClcbiAgICAgIGlmIChzZXF1ZW5jZU51bWJlciA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcInNlcXVlbmNlTnVtYmVyIGlzIHVuZGVmaW5lZCB3aGlsZSByZWJhc2luZ1wiKVxuICAgICAgfVxuICAgICAgaWYgKFxuICAgICAgICBwYXRjaGVzVG9OdWRnZVswXT8uc2VxdWVuY2VOdW1iZXIgIT09IHVuZGVmaW5lZCAmJlxuICAgICAgICBwYXRjaGVzVG9OdWRnZVswXS5zZXF1ZW5jZU51bWJlciA8PSBzZXF1ZW5jZU51bWJlclxuICAgICAgKSB7XG4gICAgICAgIGxldCBuZXh0ID0gc2VxdWVuY2VOdW1iZXIgKyAxXG4gICAgICAgIGZvciAoY29uc3QgcCBvZiBwYXRjaGVzVG9OdWRnZSkge1xuICAgICAgICAgIGNvbnN0IG5ld05hbWUgPSBjcmVhdGVQYXRjaEZpbGVOYW1lKHtcbiAgICAgICAgICAgIHBhY2thZ2VEZXRhaWxzLFxuICAgICAgICAgICAgcGFja2FnZVZlcnNpb24sXG4gICAgICAgICAgICBzZXF1ZW5jZU5hbWU6IHAuc2VxdWVuY2VOYW1lLFxuICAgICAgICAgICAgc2VxdWVuY2VOdW1iZXI6IG5leHQrKyxcbiAgICAgICAgICB9KVxuICAgICAgICAgIGNvbnNvbGUubG9nKFxuICAgICAgICAgICAgXCJSZW5hbWluZ1wiLFxuICAgICAgICAgICAgY2hhbGsuYm9sZChwLnBhdGNoRmlsZW5hbWUpLFxuICAgICAgICAgICAgXCJ0b1wiLFxuICAgICAgICAgICAgY2hhbGsuYm9sZChuZXdOYW1lKSxcbiAgICAgICAgICApXG4gICAgICAgICAgY29uc3Qgb2xkUGF0aCA9IGpvaW4oYXBwUGF0aCwgcGF0Y2hEaXIsIHAucGF0Y2hGaWxlbmFtZSlcbiAgICAgICAgICBjb25zdCBuZXdQYXRoID0gam9pbihhcHBQYXRoLCBwYXRjaERpciwgbmV3TmFtZSlcbiAgICAgICAgICByZW5hbWVTeW5jKG9sZFBhdGgsIG5ld1BhdGgpXG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICB3cml0ZUZpbGVTeW5jKHBhdGNoUGF0aCwgZGlmZlJlc3VsdC5zdGRvdXQpXG4gICAgY29uc29sZS5sb2coXG4gICAgICBgJHtjaGFsay5ncmVlbihcIuKclFwiKX0gQ3JlYXRlZCBmaWxlICR7am9pbihwYXRjaERpciwgcGF0Y2hGaWxlTmFtZSl9XFxuYCxcbiAgICApXG5cbiAgICBjb25zdCBwcmV2U3RhdGU6IFBhdGNoU3RhdGVbXSA9IHBhdGNoZXNUb0FwcGx5QmVmb3JlRGlmZmluZy5tYXAoXG4gICAgICAocCk6IFBhdGNoU3RhdGUgPT4gKHtcbiAgICAgICAgcGF0Y2hGaWxlbmFtZTogcC5wYXRjaEZpbGVuYW1lLFxuICAgICAgICBkaWRBcHBseTogdHJ1ZSxcbiAgICAgICAgcGF0Y2hDb250ZW50SGFzaDogaGFzaEZpbGUoam9pbihhcHBQYXRoLCBwYXRjaERpciwgcC5wYXRjaEZpbGVuYW1lKSksXG4gICAgICB9KSxcbiAgICApXG4gICAgY29uc3QgbmV4dFN0YXRlOiBQYXRjaFN0YXRlW10gPSBbXG4gICAgICAuLi5wcmV2U3RhdGUsXG4gICAgICB7XG4gICAgICAgIHBhdGNoRmlsZW5hbWU6IHBhdGNoRmlsZU5hbWUsXG4gICAgICAgIGRpZEFwcGx5OiB0cnVlLFxuICAgICAgICBwYXRjaENvbnRlbnRIYXNoOiBoYXNoRmlsZShwYXRjaFBhdGgpLFxuICAgICAgfSxcbiAgICBdXG5cbiAgICAvLyBpZiBhbnkgcGF0Y2hlcyBjb21lIGFmdGVyIHRoaXMgb25lIHdlIGp1c3QgbWFkZSwgd2Ugc2hvdWxkIHJlYXBwbHkgdGhlbVxuICAgIGxldCBkaWRGYWlsV2hpbGVGaW5pc2hpbmdSZWJhc2UgPSBmYWxzZVxuICAgIGlmIChpc1JlYmFzaW5nKSB7XG4gICAgICBjb25zdCBjdXJyZW50UGF0Y2hlcyA9IGdldEdyb3VwZWRQYXRjaGVzKGpvaW4oYXBwUGF0aCwgcGF0Y2hEaXIpKVxuICAgICAgICAucGF0aFNwZWNpZmllclRvUGF0Y2hGaWxlc1twYWNrYWdlRGV0YWlscy5wYXRoU3BlY2lmaWVyXVxuXG4gICAgICBjb25zdCBwcmV2aW91c2x5VW5hcHBsaWVkUGF0Y2hlcyA9IGN1cnJlbnRQYXRjaGVzLnNsaWNlKG5leHRTdGF0ZS5sZW5ndGgpXG4gICAgICBpZiAocHJldmlvdXNseVVuYXBwbGllZFBhdGNoZXMubGVuZ3RoKSB7XG4gICAgICAgIGNvbnNvbGUubG9nKGBGYXN0IGZvcndhcmRpbmcuLi5gKVxuICAgICAgICBmb3IgKGNvbnN0IHBhdGNoIG9mIHByZXZpb3VzbHlVbmFwcGxpZWRQYXRjaGVzKSB7XG4gICAgICAgICAgY29uc3QgcGF0Y2hGaWxlUGF0aCA9IGpvaW4oYXBwUGF0aCwgcGF0Y2hEaXIsIHBhdGNoLnBhdGNoRmlsZW5hbWUpXG4gICAgICAgICAgaWYgKFxuICAgICAgICAgICAgIWFwcGx5UGF0Y2goe1xuICAgICAgICAgICAgICBwYXRjaERldGFpbHM6IHBhdGNoLFxuICAgICAgICAgICAgICBwYXRjaERpcixcbiAgICAgICAgICAgICAgcGF0Y2hGaWxlUGF0aCxcbiAgICAgICAgICAgICAgcmV2ZXJzZTogZmFsc2UsXG4gICAgICAgICAgICAgIGN3ZDogcHJvY2Vzcy5jd2QoKSxcbiAgICAgICAgICAgICAgYmVzdEVmZm9ydDogZmFsc2UsXG4gICAgICAgICAgICB9KVxuICAgICAgICAgICkge1xuICAgICAgICAgICAgZGlkRmFpbFdoaWxlRmluaXNoaW5nUmViYXNlID0gdHJ1ZVxuICAgICAgICAgICAgbG9nUGF0Y2hTZXF1ZW5jZUVycm9yKHsgcGF0Y2hEZXRhaWxzOiBwYXRjaCB9KVxuICAgICAgICAgICAgbmV4dFN0YXRlLnB1c2goe1xuICAgICAgICAgICAgICBwYXRjaEZpbGVuYW1lOiBwYXRjaC5wYXRjaEZpbGVuYW1lLFxuICAgICAgICAgICAgICBkaWRBcHBseTogZmFsc2UsXG4gICAgICAgICAgICAgIHBhdGNoQ29udGVudEhhc2g6IGhhc2hGaWxlKHBhdGNoRmlsZVBhdGgpLFxuICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIGJyZWFrXG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKGAgICR7Y2hhbGsuZ3JlZW4oXCLinJRcIil9ICR7cGF0Y2gucGF0Y2hGaWxlbmFtZX1gKVxuICAgICAgICAgICAgbmV4dFN0YXRlLnB1c2goe1xuICAgICAgICAgICAgICBwYXRjaEZpbGVuYW1lOiBwYXRjaC5wYXRjaEZpbGVuYW1lLFxuICAgICAgICAgICAgICBkaWRBcHBseTogdHJ1ZSxcbiAgICAgICAgICAgICAgcGF0Y2hDb250ZW50SGFzaDogaGFzaEZpbGUocGF0Y2hGaWxlUGF0aCksXG4gICAgICAgICAgICB9KVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChpc1JlYmFzaW5nIHx8IG51bVBhdGNoZXNBZnRlckNyZWF0ZSA+IDEpIHtcbiAgICAgIHNhdmVQYXRjaEFwcGxpY2F0aW9uU3RhdGUoe1xuICAgICAgICBwYWNrYWdlRGV0YWlscyxcbiAgICAgICAgcGF0Y2hlczogbmV4dFN0YXRlLFxuICAgICAgICBpc1JlYmFzaW5nOiBkaWRGYWlsV2hpbGVGaW5pc2hpbmdSZWJhc2UsXG4gICAgICB9KVxuICAgIH0gZWxzZSB7XG4gICAgICBjbGVhclBhdGNoQXBwbGljYXRpb25TdGF0ZShwYWNrYWdlRGV0YWlscylcbiAgICB9XG5cbiAgICBpZiAoY2FuQ3JlYXRlSXNzdWUpIHtcbiAgICAgIGlmIChjcmVhdGVJc3N1ZSkge1xuICAgICAgICBvcGVuSXNzdWVDcmVhdGlvbkxpbmsoe1xuICAgICAgICAgIHBhY2thZ2VEZXRhaWxzLFxuICAgICAgICAgIHBhdGNoRmlsZUNvbnRlbnRzOiBkaWZmUmVzdWx0LnN0ZG91dC50b1N0cmluZygpLFxuICAgICAgICAgIHBhY2thZ2VWZXJzaW9uLFxuICAgICAgICB9KVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgbWF5YmVQcmludElzc3VlQ3JlYXRpb25Qcm9tcHQodmNzLCBwYWNrYWdlRGV0YWlscywgcGFja2FnZU1hbmFnZXIpXG4gICAgICB9XG4gICAgfVxuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5sb2coZSlcbiAgICB0aHJvdyBlXG4gIH0gZmluYWxseSB7XG4gICAgdG1wUmVwby5yZW1vdmVDYWxsYmFjaygpXG4gIH1cbn1cblxuZnVuY3Rpb24gY3JlYXRlUGF0Y2hGaWxlTmFtZSh7XG4gIHBhY2thZ2VEZXRhaWxzLFxuICBwYWNrYWdlVmVyc2lvbixcbiAgc2VxdWVuY2VOdW1iZXIsXG4gIHNlcXVlbmNlTmFtZSxcbn06IHtcbiAgcGFja2FnZURldGFpbHM6IFBhY2thZ2VEZXRhaWxzXG4gIHBhY2thZ2VWZXJzaW9uOiBzdHJpbmdcbiAgc2VxdWVuY2VOdW1iZXI/OiBudW1iZXJcbiAgc2VxdWVuY2VOYW1lPzogc3RyaW5nXG59KSB7XG4gIGNvbnN0IHBhY2thZ2VOYW1lcyA9IHBhY2thZ2VEZXRhaWxzLnBhY2thZ2VOYW1lc1xuICAgIC5tYXAoKG5hbWUpID0+IG5hbWUucmVwbGFjZSgvXFwvL2csIFwiK1wiKSlcbiAgICAuam9pbihcIisrXCIpXG5cbiAgY29uc3QgbmFtZUFuZFZlcnNpb24gPSBgJHtwYWNrYWdlTmFtZXN9KyR7cGFja2FnZVZlcnNpb259YFxuICBjb25zdCBudW0gPVxuICAgIHNlcXVlbmNlTnVtYmVyID09PSB1bmRlZmluZWRcbiAgICAgID8gXCJcIlxuICAgICAgOiBgKyR7c2VxdWVuY2VOdW1iZXIudG9TdHJpbmcoKS5wYWRTdGFydCgzLCBcIjBcIil9YFxuICBjb25zdCBuYW1lID0gIXNlcXVlbmNlTmFtZSA/IFwiXCIgOiBgKyR7c2VxdWVuY2VOYW1lfWBcblxuICByZXR1cm4gYCR7bmFtZUFuZFZlcnNpb259JHtudW19JHtuYW1lfS5wYXRjaGBcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGxvZ1BhdGNoU2VxdWVuY2VFcnJvcih7XG4gIHBhdGNoRGV0YWlscyxcbn06IHtcbiAgcGF0Y2hEZXRhaWxzOiBQYXRjaGVkUGFja2FnZURldGFpbHNcbn0pIHtcbiAgY29uc29sZS5sb2coYFxuJHtjaGFsay5yZWQuYm9sZChcIuKblCBFUlJPUlwiKX1cblxuRmFpbGVkIHRvIGFwcGx5IHBhdGNoIGZpbGUgJHtjaGFsay5ib2xkKHBhdGNoRGV0YWlscy5wYXRjaEZpbGVuYW1lKX0uXG5cbklmIHRoaXMgcGF0Y2ggZmlsZSBpcyBubyBsb25nZXIgdXNlZnVsLCBkZWxldGUgaXQgYW5kIHJ1blxuXG4gICR7Y2hhbGsuYm9sZChgcGF0Y2gtcGFja2FnZWApfVxuXG5UbyBwYXJ0aWFsbHkgYXBwbHkgdGhlIHBhdGNoIChpZiBwb3NzaWJsZSkgYW5kIG91dHB1dCBhIGxvZyBvZiBlcnJvcnMgdG8gZml4LCBydW5cblxuICAke2NoYWxrLmJvbGQoYHBhdGNoLXBhY2thZ2UgLS1wYXJ0aWFsYCl9XG5cbkFmdGVyIHdoaWNoIHlvdSBzaG91bGQgbWFrZSBhbnkgcmVxdWlyZWQgY2hhbmdlcyBpbnNpZGUgJHtcbiAgICBwYXRjaERldGFpbHMucGF0aFxuICB9LCBhbmQgZmluYWxseSBydW5cblxuICAke2NoYWxrLmJvbGQoYHBhdGNoLXBhY2thZ2UgJHtwYXRjaERldGFpbHMucGF0aFNwZWNpZmllcn1gKX1cblxudG8gdXBkYXRlIHRoZSBwYXRjaCBmaWxlLlxuYClcbn1cbiJdfQ==