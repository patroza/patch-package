import fs from "fs-extra";
import { dirname, join, relative, resolve } from "path";
import { assertNever } from "../assertNever.js";
export const executeEffects = (effects, { dryRun, bestEffort, errors, cwd, }) => {
    const inCwd = (path) => (cwd ? join(cwd, path) : path);
    const humanReadable = (path) => relative(process.cwd(), inCwd(path));
    effects.forEach((eff) => {
        switch (eff.type) {
            case "file deletion":
                if (dryRun) {
                    if (!fs.existsSync(inCwd(eff.path))) {
                        throw new Error("Trying to delete file that doesn't exist: " +
                            humanReadable(eff.path));
                    }
                }
                else {
                    // TODO: integrity checks
                    try {
                        fs.unlinkSync(inCwd(eff.path));
                    }
                    catch (e) {
                        if (bestEffort) {
                            errors === null || errors === void 0 ? void 0 : errors.push(`Failed to delete file ${eff.path}`);
                        }
                        else {
                            throw e;
                        }
                    }
                }
                break;
            case "rename":
                if (dryRun) {
                    // TODO: see what patch files look like if moving to exising path
                    if (!fs.existsSync(inCwd(eff.fromPath))) {
                        throw new Error("Trying to move file that doesn't exist: " +
                            humanReadable(eff.fromPath));
                    }
                }
                else {
                    try {
                        fs.moveSync(inCwd(eff.fromPath), inCwd(eff.toPath));
                    }
                    catch (e) {
                        if (bestEffort) {
                            errors === null || errors === void 0 ? void 0 : errors.push(`Failed to rename file ${eff.fromPath} to ${eff.toPath}`);
                        }
                        else {
                            throw e;
                        }
                    }
                }
                break;
            case "file creation":
                if (dryRun) {
                    if (fs.existsSync(inCwd(eff.path))) {
                        throw new Error("Trying to create file that already exists: " +
                            humanReadable(eff.path));
                    }
                    // todo: check file contents matches
                }
                else {
                    const fileContents = eff.hunk
                        ? eff.hunk.parts[0].lines.join("\n") +
                            (eff.hunk.parts[0].noNewlineAtEndOfFile ? "" : "\n")
                        : "";
                    const path = inCwd(eff.path);
                    try {
                        fs.ensureDirSync(dirname(path));
                        fs.writeFileSync(path, fileContents, { mode: eff.mode });
                    }
                    catch (e) {
                        if (bestEffort) {
                            errors === null || errors === void 0 ? void 0 : errors.push(`Failed to create new file ${eff.path}`);
                        }
                        else {
                            throw e;
                        }
                    }
                }
                break;
            case "patch":
                applyPatch(eff, { dryRun, cwd, bestEffort, errors });
                break;
            case "mode change":
                const currentMode = fs.statSync(inCwd(eff.path)).mode;
                if (((isExecutable(eff.newMode) && isExecutable(currentMode)) ||
                    (!isExecutable(eff.newMode) && !isExecutable(currentMode))) &&
                    dryRun) {
                    console.log(`Mode change is not required for file ${humanReadable(eff.path)}`);
                }
                fs.chmodSync(inCwd(eff.path), eff.newMode);
                break;
            default:
                assertNever(eff);
        }
    });
};
function isExecutable(fileMode) {
    // tslint:disable-next-line:no-bitwise
    return (fileMode & 64) > 0;
}
const trimRight = (s) => s.replace(/\s+$/, "");
function linesAreEqual(a, b) {
    return trimRight(a) === trimRight(b);
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
function applyPatch({ hunks, path }, { dryRun, cwd, bestEffort, errors, }) {
    path = cwd ? resolve(cwd, path) : path;
    // modifying the file in place
    const fileContents = fs.readFileSync(path).toString();
    const mode = fs.statSync(path).mode;
    const fileLines = fileContents.split(/\n/);
    const result = [];
    for (const hunk of hunks) {
        let fuzzingOffset = 0;
        while (true) {
            const modifications = evaluateHunk(hunk, fileLines, fuzzingOffset);
            if (modifications) {
                result.push(modifications);
                break;
            }
            fuzzingOffset =
                fuzzingOffset < 0 ? fuzzingOffset * -1 : fuzzingOffset * -1 - 1;
            if (Math.abs(fuzzingOffset) > 20) {
                const message = `Cannot apply hunk ${hunks.indexOf(hunk)} for file ${relative(process.cwd(), path)}\n\`\`\`diff\n${hunk.source}\n\`\`\`\n`;
                if (bestEffort) {
                    errors === null || errors === void 0 ? void 0 : errors.push(message);
                    break;
                }
                else {
                    throw new Error(message);
                }
            }
        }
    }
    if (dryRun) {
        return;
    }
    let diffOffset = 0;
    for (const modifications of result) {
        for (const modification of modifications) {
            switch (modification.type) {
                case "splice":
                    fileLines.splice(modification.index + diffOffset, modification.numToDelete, ...modification.linesToInsert);
                    diffOffset +=
                        modification.linesToInsert.length - modification.numToDelete;
                    break;
                case "pop":
                    fileLines.pop();
                    break;
                case "push":
                    fileLines.push(modification.line);
                    break;
                default:
                    assertNever(modification);
            }
        }
    }
    try {
        fs.writeFileSync(path, fileLines.join("\n"), { mode });
    }
    catch (e) {
        if (bestEffort) {
            errors === null || errors === void 0 ? void 0 : errors.push(`Failed to write file ${path}`);
        }
        else {
            throw e;
        }
    }
}
function evaluateHunk(hunk, fileLines, fuzzingOffset) {
    const result = [];
    let contextIndex = hunk.header.original.start - 1 + fuzzingOffset;
    // do bounds checks for index
    if (contextIndex < 0) {
        return null;
    }
    if (fileLines.length - contextIndex < hunk.header.original.length) {
        return null;
    }
    for (const part of hunk.parts) {
        switch (part.type) {
            case "deletion":
            case "context":
                for (const line of part.lines) {
                    const originalLine = fileLines[contextIndex];
                    if (!linesAreEqual(originalLine, line)) {
                        return null;
                    }
                    contextIndex++;
                }
                if (part.type === "deletion") {
                    result.push({
                        type: "splice",
                        index: contextIndex - part.lines.length,
                        numToDelete: part.lines.length,
                        linesToInsert: [],
                    });
                    if (part.noNewlineAtEndOfFile) {
                        result.push({
                            type: "push",
                            line: "",
                        });
                    }
                }
                break;
            case "insertion":
                result.push({
                    type: "splice",
                    index: contextIndex,
                    numToDelete: 0,
                    linesToInsert: part.lines,
                });
                if (part.noNewlineAtEndOfFile) {
                    result.push({ type: "pop" });
                }
                break;
            default:
                assertNever(part.type);
        }
    }
    return result;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBwbHkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zcmMvcGF0Y2gvYXBwbHkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLE1BQU0sVUFBVSxDQUFBO0FBQ3pCLE9BQU8sRUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxPQUFPLEVBQUUsTUFBTSxNQUFNLENBQUE7QUFFdkQsT0FBTyxFQUFFLFdBQVcsRUFBRSxNQUFNLG1CQUFtQixDQUFBO0FBRS9DLE1BQU0sQ0FBQyxNQUFNLGNBQWMsR0FBRyxDQUM1QixPQUF3QixFQUN4QixFQUNFLE1BQU0sRUFDTixVQUFVLEVBQ1YsTUFBTSxFQUNOLEdBQUcsR0FDdUUsRUFDNUUsRUFBRTtJQUNGLE1BQU0sS0FBSyxHQUFHLENBQUMsSUFBWSxFQUFFLEVBQUUsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUE7SUFDOUQsTUFBTSxhQUFhLEdBQUcsQ0FBQyxJQUFZLEVBQUUsRUFBRSxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsR0FBRyxFQUFFLEVBQUUsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUE7SUFDNUUsT0FBTyxDQUFDLE9BQU8sQ0FBQyxDQUFDLEdBQUcsRUFBRSxFQUFFO1FBQ3RCLFFBQVEsR0FBRyxDQUFDLElBQUksRUFBRSxDQUFDO1lBQ2pCLEtBQUssZUFBZTtnQkFDbEIsSUFBSSxNQUFNLEVBQUUsQ0FBQztvQkFDWCxJQUFJLENBQUMsRUFBRSxDQUFDLFVBQVUsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxDQUFDLEVBQUUsQ0FBQzt3QkFDcEMsTUFBTSxJQUFJLEtBQUssQ0FDYiw0Q0FBNEM7NEJBQzFDLGFBQWEsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLENBQzFCLENBQUE7b0JBQ0gsQ0FBQztn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Q0FBQyxDQUFBO2dCQUNGLElBQUksSUFBSSxDQUFDLG9CQUFvQixFQUFFLENBQUM7b0JBQzlCLE1BQU0sQ0FBQyxJQUFJLENBQUMsRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLENBQUMsQ0FBQTtnQkFDOUIsQ0FBQztnQkFDRCxNQUFLO1lBQ1A7Z0JBQ0UsV0FBVyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQTtRQUMxQixDQUFDO0lBQ0gsQ0FBQztJQUVELE9BQU8sTUFBTSxDQUFBO0FBQ2YsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBmcyBmcm9tIFwiZnMtZXh0cmFcIlxuaW1wb3J0IHsgZGlybmFtZSwgam9pbiwgcmVsYXRpdmUsIHJlc29sdmUgfSBmcm9tIFwicGF0aFwiXG5pbXBvcnQgeyBQYXJzZWRQYXRjaEZpbGUsIEZpbGVQYXRjaCwgSHVuayB9IGZyb20gXCIuL3BhcnNlLmpzXCJcbmltcG9ydCB7IGFzc2VydE5ldmVyIH0gZnJvbSBcIi4uL2Fzc2VydE5ldmVyLmpzXCJcblxuZXhwb3J0IGNvbnN0IGV4ZWN1dGVFZmZlY3RzID0gKFxuICBlZmZlY3RzOiBQYXJzZWRQYXRjaEZpbGUsXG4gIHtcbiAgICBkcnlSdW4sXG4gICAgYmVzdEVmZm9ydCxcbiAgICBlcnJvcnMsXG4gICAgY3dkLFxuICB9OiB7IGRyeVJ1bjogYm9vbGVhbjsgY3dkPzogc3RyaW5nOyBlcnJvcnM/OiBzdHJpbmdbXTsgYmVzdEVmZm9ydDogYm9vbGVhbiB9LFxuKSA9PiB7XG4gIGNvbnN0IGluQ3dkID0gKHBhdGg6IHN0cmluZykgPT4gKGN3ZCA/IGpvaW4oY3dkLCBwYXRoKSA6IHBhdGgpXG4gIGNvbnN0IGh1bWFuUmVhZGFibGUgPSAocGF0aDogc3RyaW5nKSA9PiByZWxhdGl2ZShwcm9jZXNzLmN3ZCgpLCBpbkN3ZChwYXRoKSlcbiAgZWZmZWN0cy5mb3JFYWNoKChlZmYpID0+IHtcbiAgICBzd2l0Y2ggKGVmZi50eXBlKSB7XG4gICAgICBjYXNlIFwiZmlsZSBkZWxldGlvblwiOlxuICAgICAgICBpZiAoZHJ5UnVuKSB7XG4gICAgICAgICAgaWYgKCFmcy5leGlzdHNTeW5jKGluQ3dkKGVmZi5wYXRoKSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgXCJUcnlpbmcgdG8gZGVsZXRlIGZpbGUgdGhhdCBkb2Vzbid0IGV4aXN0OiBcIiArXG4gICAgICAgICAgICAgICAgaHVtYW5SZWFkYWJsZShlZmYucGF0aCksXG4gICAgICAgICAgICApXG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIFRPRE86IGludGVncml0eSBjaGVja3NcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgZnMudW5saW5rU3luYyhpbkN3ZChlZmYucGF0aCkpXG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgaWYgKGJlc3RFZmZvcnQpIHtcbiAgICAgICAgICAgICAgZXJyb3JzPy5wdXNoKGBGYWlsZWQgdG8gZGVsZXRlIGZpbGUgJHtlZmYucGF0aH1gKVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgdGhyb3cgZVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBicmVha1xuICAgICAgY2FzZSBcInJlbmFtZVwiOlxuICAgICAgICBpZiAoZHJ5UnVuKSB7XG4gICAgICAgICAgLy8gVE9ETzogc2VlIHdoYXQgcGF0Y2ggZmlsZXMgbG9vayBsaWtlIGlmIG1vdmluZyB0byBleGlzaW5nIHBhdGhcbiAgICAgICAgICBpZiAoIWZzLmV4aXN0c1N5bmMoaW5Dd2QoZWZmLmZyb21QYXRoKSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgXCJUcnlpbmcgdG8gbW92ZSBmaWxlIHRoYXQgZG9lc24ndCBleGlzdDogXCIgK1xuICAgICAgICAgICAgICAgIGh1bWFuUmVhZGFibGUoZWZmLmZyb21QYXRoKSxcbiAgICAgICAgICAgIClcbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGZzLm1vdmVTeW5jKGluQ3dkKGVmZi5mcm9tUGF0aCksIGluQ3dkKGVmZi50b1BhdGgpKVxuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIGlmIChiZXN0RWZmb3J0KSB7XG4gICAgICAgICAgICAgIGVycm9ycz8ucHVzaChcbiAgICAgICAgICAgICAgICBgRmFpbGVkIHRvIHJlbmFtZSBmaWxlICR7ZWZmLmZyb21QYXRofSB0byAke2VmZi50b1BhdGh9YCxcbiAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgdGhyb3cgZVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBicmVha1xuICAgICAgY2FzZSBcImZpbGUgY3JlYXRpb25cIjpcbiAgICAgICAgaWYgKGRyeVJ1bikge1xuICAgICAgICAgIGlmIChmcy5leGlzdHNTeW5jKGluQ3dkKGVmZi5wYXRoKSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgXCJUcnlpbmcgdG8gY3JlYXRlIGZpbGUgdGhhdCBhbHJlYWR5IGV4aXN0czogXCIgK1xuICAgICAgICAgICAgICAgIGh1bWFuUmVhZGFibGUoZWZmLnBhdGgpLFxuICAgICAgICAgICAgKVxuICAgICAgICAgIH1cbiAgICAgICAgICAvLyB0b2RvOiBjaGVjayBmaWxlIGNvbnRlbnRzIG1hdGNoZXNcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBjb25zdCBmaWxlQ29udGVudHMgPSBlZmYuaHVua1xuICAgICAgICAgICAgPyBlZmYuaHVuay5wYXJ0c1swXS5saW5lcy5qb2luKFwiXFxuXCIpICtcbiAgICAgICAgICAgICAgKGVmZi5odW5rLnBhcnRzWzBdLm5vTmV3bGluZUF0RW5kT2ZGaWxlID8gXCJcIiA6IFwiXFxuXCIpXG4gICAgICAgICAgICA6IFwiXCJcbiAgICAgICAgICBjb25zdCBwYXRoID0gaW5Dd2QoZWZmLnBhdGgpXG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGZzLmVuc3VyZURpclN5bmMoZGlybmFtZShwYXRoKSlcbiAgICAgICAgICAgIGZzLndyaXRlRmlsZVN5bmMocGF0aCwgZmlsZUNvbnRlbnRzLCB7IG1vZGU6IGVmZi5tb2RlIH0pXG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgaWYgKGJlc3RFZmZvcnQpIHtcbiAgICAgICAgICAgICAgZXJyb3JzPy5wdXNoKGBGYWlsZWQgdG8gY3JlYXRlIG5ldyBmaWxlICR7ZWZmLnBhdGh9YClcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIHRocm93IGVcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWtcbiAgICAgIGNhc2UgXCJwYXRjaFwiOlxuICAgICAgICBhcHBseVBhdGNoKGVmZiwgeyBkcnlSdW4sIGN3ZCwgYmVzdEVmZm9ydCwgZXJyb3JzIH0pXG4gICAgICAgIGJyZWFrXG4gICAgICBjYXNlIFwibW9kZSBjaGFuZ2VcIjpcbiAgICAgICAgY29uc3QgY3VycmVudE1vZGUgPSBmcy5zdGF0U3luYyhpbkN3ZChlZmYucGF0aCkpLm1vZGVcbiAgICAgICAgaWYgKFxuICAgICAgICAgICgoaXNFeGVjdXRhYmxlKGVmZi5uZXdNb2RlKSAmJiBpc0V4ZWN1dGFibGUoY3VycmVudE1vZGUpKSB8fFxuICAgICAgICAgICAgKCFpc0V4ZWN1dGFibGUoZWZmLm5ld01vZGUpICYmICFpc0V4ZWN1dGFibGUoY3VycmVudE1vZGUpKSkgJiZcbiAgICAgICAgICBkcnlSdW5cbiAgICAgICAgKSB7XG4gICAgICAgICAgY29uc29sZS5sb2coXG4gICAgICAgICAgICBgTW9kZSBjaGFuZ2UgaXMgbm90IHJlcXVpcmVkIGZvciBmaWxlICR7aHVtYW5SZWFkYWJsZShlZmYucGF0aCl9YCxcbiAgICAgICAgICApXG4gICAgICAgIH1cbiAgICAgICAgZnMuY2htb2RTeW5jKGluQ3dkKGVmZi5wYXRoKSwgZWZmLm5ld01vZGUpXG4gICAgICAgIGJyZWFrXG4gICAgICBkZWZhdWx0OlxuICAgICAgICBhc3NlcnROZXZlcihlZmYpXG4gICAgfVxuICB9KVxufVxuXG5mdW5jdGlvbiBpc0V4ZWN1dGFibGUoZmlsZU1vZGU6IG51bWJlcikge1xuICAvLyB0c2xpbnQ6ZGlzYWJsZS1uZXh0LWxpbmU6bm8tYml0d2lzZVxuICByZXR1cm4gKGZpbGVNb2RlICYgMGIwMDFfMDAwXzAwMCkgPiAwXG59XG5cbmNvbnN0IHRyaW1SaWdodCA9IChzOiBzdHJpbmcpID0+IHMucmVwbGFjZSgvXFxzKyQvLCBcIlwiKVxuZnVuY3Rpb24gbGluZXNBcmVFcXVhbChhOiBzdHJpbmcsIGI6IHN0cmluZykge1xuICByZXR1cm4gdHJpbVJpZ2h0KGEpID09PSB0cmltUmlnaHQoYilcbn1cblxuLyoqXG4gKiBIb3cgZG9lcyBub05ld0xpbmVBdEVuZE9mRmlsZSB3b3JrP1xuICpcbiAqIGlmIHlvdSByZW1vdmUgdGhlIG5ld2xpbmUgZnJvbSBhIGZpbGUgdGhhdCBoYWQgb25lIHdpdGhvdXQgZWRpdGluZyBvdGhlciBiaXRzOlxuICpcbiAqICAgIGl0IGNyZWF0ZXMgYW4gaW5zZXJ0aW9uL3JlbW92YWwgcGFpciB3aGVyZSB0aGUgaW5zZXJ0aW9uIGhhcyBcXCBObyBuZXcgbGluZSBhdCBlbmQgb2YgZmlsZVxuICpcbiAqIGlmIHlvdSBlZGl0IGEgZmlsZSB0aGF0IGRpZG4ndCBoYXZlIGEgbmV3IGxpbmUgYW5kIGRvbid0IGFkZCBvbmU6XG4gKlxuICogICAgYm90aCBpbnNlcnRpb24gYW5kIGRlbGV0aW9uIGhhdmUgXFwgTm8gbmV3IGxpbmUgYXQgZW5kIG9mIGZpbGVcbiAqXG4gKiBpZiB5b3UgZWRpdCBhIGZpbGUgdGhhdCBkaWRuJ3QgaGF2ZSBhIG5ldyBsaW5lIGFuZCBhZGQgb25lOlxuICpcbiAqICAgIGRlbGV0aW9uIGhhcyBcXCBObyBuZXcgbGluZSBhdCBlbmQgb2YgZmlsZVxuICogICAgYnV0IG5vdCBpbnNlcnRpb25cbiAqXG4gKiBpZiB5b3UgZWRpdCBhIGZpbGUgdGhhdCBoYWQgYSBuZXcgbGluZSBhbmQgbGVhdmUgaXQgaW46XG4gKlxuICogICAgbmVpdGhlciBpbnNldGlvbiBub3IgZGVsZXRpb24gaGF2ZSB0aGUgYW5ub2F0aW9uXG4gKlxuICovXG5cbmZ1bmN0aW9uIGFwcGx5UGF0Y2goXG4gIHsgaHVua3MsIHBhdGggfTogRmlsZVBhdGNoLFxuICB7XG4gICAgZHJ5UnVuLFxuICAgIGN3ZCxcbiAgICBiZXN0RWZmb3J0LFxuICAgIGVycm9ycyxcbiAgfTogeyBkcnlSdW46IGJvb2xlYW47IGN3ZD86IHN0cmluZzsgYmVzdEVmZm9ydDogYm9vbGVhbjsgZXJyb3JzPzogc3RyaW5nW10gfSxcbik6IHZvaWQge1xuICBwYXRoID0gY3dkID8gcmVzb2x2ZShjd2QsIHBhdGgpIDogcGF0aFxuICAvLyBtb2RpZnlpbmcgdGhlIGZpbGUgaW4gcGxhY2VcbiAgY29uc3QgZmlsZUNvbnRlbnRzID0gZnMucmVhZEZpbGVTeW5jKHBhdGgpLnRvU3RyaW5nKClcbiAgY29uc3QgbW9kZSA9IGZzLnN0YXRTeW5jKHBhdGgpLm1vZGVcblxuICBjb25zdCBmaWxlTGluZXM6IHN0cmluZ1tdID0gZmlsZUNvbnRlbnRzLnNwbGl0KC9cXG4vKVxuXG4gIGNvbnN0IHJlc3VsdDogTW9kaWZpY2F0aW9uW11bXSA9IFtdXG5cbiAgZm9yIChjb25zdCBodW5rIG9mIGh1bmtzKSB7XG4gICAgbGV0IGZ1enppbmdPZmZzZXQgPSAwXG4gICAgd2hpbGUgKHRydWUpIHtcbiAgICAgIGNvbnN0IG1vZGlmaWNhdGlvbnMgPSBldmFsdWF0ZUh1bmsoaHVuaywgZmlsZUxpbmVzLCBmdXp6aW5nT2Zmc2V0KVxuICAgICAgaWYgKG1vZGlmaWNhdGlvbnMpIHtcbiAgICAgICAgcmVzdWx0LnB1c2gobW9kaWZpY2F0aW9ucylcbiAgICAgICAgYnJlYWtcbiAgICAgIH1cblxuICAgICAgZnV6emluZ09mZnNldCA9XG4gICAgICAgIGZ1enppbmdPZmZzZXQgPCAwID8gZnV6emluZ09mZnNldCAqIC0xIDogZnV6emluZ09mZnNldCAqIC0xIC0gMVxuXG4gICAgICBpZiAoTWF0aC5hYnMoZnV6emluZ09mZnNldCkgPiAyMCkge1xuICAgICAgICBjb25zdCBtZXNzYWdlID0gYENhbm5vdCBhcHBseSBodW5rICR7aHVua3MuaW5kZXhPZihcbiAgICAgICAgICBodW5rLFxuICAgICAgICApfSBmb3IgZmlsZSAke3JlbGF0aXZlKHByb2Nlc3MuY3dkKCksIHBhdGgpfVxcblxcYFxcYFxcYGRpZmZcXG4ke1xuICAgICAgICAgIGh1bmsuc291cmNlXG4gICAgICAgIH1cXG5cXGBcXGBcXGBcXG5gXG5cbiAgICAgICAgaWYgKGJlc3RFZmZvcnQpIHtcbiAgICAgICAgICBlcnJvcnM/LnB1c2gobWVzc2FnZSlcbiAgICAgICAgICBicmVha1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihtZXNzYWdlKVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgaWYgKGRyeVJ1bikge1xuICAgIHJldHVyblxuICB9XG5cbiAgbGV0IGRpZmZPZmZzZXQgPSAwXG5cbiAgZm9yIChjb25zdCBtb2RpZmljYXRpb25zIG9mIHJlc3VsdCkge1xuICAgIGZvciAoY29uc3QgbW9kaWZpY2F0aW9uIG9mIG1vZGlmaWNhdGlvbnMpIHtcbiAgICAgIHN3aXRjaCAobW9kaWZpY2F0aW9uLnR5cGUpIHtcbiAgICAgICAgY2FzZSBcInNwbGljZVwiOlxuICAgICAgICAgIGZpbGVMaW5lcy5zcGxpY2UoXG4gICAgICAgICAgICBtb2RpZmljYXRpb24uaW5kZXggKyBkaWZmT2Zmc2V0LFxuICAgICAgICAgICAgbW9kaWZpY2F0aW9uLm51bVRvRGVsZXRlLFxuICAgICAgICAgICAgLi4ubW9kaWZpY2F0aW9uLmxpbmVzVG9JbnNlcnQsXG4gICAgICAgICAgKVxuICAgICAgICAgIGRpZmZPZmZzZXQgKz1cbiAgICAgICAgICAgIG1vZGlmaWNhdGlvbi5saW5lc1RvSW5zZXJ0Lmxlbmd0aCAtIG1vZGlmaWNhdGlvbi5udW1Ub0RlbGV0ZVxuICAgICAgICAgIGJyZWFrXG4gICAgICAgIGNhc2UgXCJwb3BcIjpcbiAgICAgICAgICBmaWxlTGluZXMucG9wKClcbiAgICAgICAgICBicmVha1xuICAgICAgICBjYXNlIFwicHVzaFwiOlxuICAgICAgICAgIGZpbGVMaW5lcy5wdXNoKG1vZGlmaWNhdGlvbi5saW5lKVxuICAgICAgICAgIGJyZWFrXG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgYXNzZXJ0TmV2ZXIobW9kaWZpY2F0aW9uKVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHRyeSB7XG4gICAgZnMud3JpdGVGaWxlU3luYyhwYXRoLCBmaWxlTGluZXMuam9pbihcIlxcblwiKSwgeyBtb2RlIH0pXG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBpZiAoYmVzdEVmZm9ydCkge1xuICAgICAgZXJyb3JzPy5wdXNoKGBGYWlsZWQgdG8gd3JpdGUgZmlsZSAke3BhdGh9YClcbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgZVxuICAgIH1cbiAgfVxufVxuXG5pbnRlcmZhY2UgUHVzaCB7XG4gIHR5cGU6IFwicHVzaFwiXG4gIGxpbmU6IHN0cmluZ1xufVxuaW50ZXJmYWNlIFBvcCB7XG4gIHR5cGU6IFwicG9wXCJcbn1cbmludGVyZmFjZSBTcGxpY2Uge1xuICB0eXBlOiBcInNwbGljZVwiXG4gIGluZGV4OiBudW1iZXJcbiAgbnVtVG9EZWxldGU6IG51bWJlclxuICBsaW5lc1RvSW5zZXJ0OiBzdHJpbmdbXVxufVxuXG50eXBlIE1vZGlmaWNhdGlvbiA9IFB1c2ggfCBQb3AgfCBTcGxpY2VcblxuZnVuY3Rpb24gZXZhbHVhdGVIdW5rKFxuICBodW5rOiBIdW5rLFxuICBmaWxlTGluZXM6IHN0cmluZ1tdLFxuICBmdXp6aW5nT2Zmc2V0OiBudW1iZXIsXG4pOiBNb2RpZmljYXRpb25bXSB8IG51bGwge1xuICBjb25zdCByZXN1bHQ6IE1vZGlmaWNhdGlvbltdID0gW11cbiAgbGV0IGNvbnRleHRJbmRleCA9IGh1bmsuaGVhZGVyLm9yaWdpbmFsLnN0YXJ0IC0gMSArIGZ1enppbmdPZmZzZXRcbiAgLy8gZG8gYm91bmRzIGNoZWNrcyBmb3IgaW5kZXhcbiAgaWYgKGNvbnRleHRJbmRleCA8IDApIHtcbiAgICByZXR1cm4gbnVsbFxuICB9XG4gIGlmIChmaWxlTGluZXMubGVuZ3RoIC0gY29udGV4dEluZGV4IDwgaHVuay5oZWFkZXIub3JpZ2luYWwubGVuZ3RoKSB7XG4gICAgcmV0dXJuIG51bGxcbiAgfVxuXG4gIGZvciAoY29uc3QgcGFydCBvZiBodW5rLnBhcnRzKSB7XG4gICAgc3dpdGNoIChwYXJ0LnR5cGUpIHtcbiAgICAgIGNhc2UgXCJkZWxldGlvblwiOlxuICAgICAgY2FzZSBcImNvbnRleHRcIjpcbiAgICAgICAgZm9yIChjb25zdCBsaW5lIG9mIHBhcnQubGluZXMpIHtcbiAgICAgICAgICBjb25zdCBvcmlnaW5hbExpbmUgPSBmaWxlTGluZXNbY29udGV4dEluZGV4XVxuICAgICAgICAgIGlmICghbGluZXNBcmVFcXVhbChvcmlnaW5hbExpbmUsIGxpbmUpKSB7XG4gICAgICAgICAgICByZXR1cm4gbnVsbFxuICAgICAgICAgIH1cbiAgICAgICAgICBjb250ZXh0SW5kZXgrK1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHBhcnQudHlwZSA9PT0gXCJkZWxldGlvblwiKSB7XG4gICAgICAgICAgcmVzdWx0LnB1c2goe1xuICAgICAgICAgICAgdHlwZTogXCJzcGxpY2VcIixcbiAgICAgICAgICAgIGluZGV4OiBjb250ZXh0SW5kZXggLSBwYXJ0LmxpbmVzLmxlbmd0aCxcbiAgICAgICAgICAgIG51bVRvRGVsZXRlOiBwYXJ0LmxpbmVzLmxlbmd0aCxcbiAgICAgICAgICAgIGxpbmVzVG9JbnNlcnQ6IFtdLFxuICAgICAgICAgIH0pXG5cbiAgICAgICAgICBpZiAocGFydC5ub05ld2xpbmVBdEVuZE9mRmlsZSkge1xuICAgICAgICAgICAgcmVzdWx0LnB1c2goe1xuICAgICAgICAgICAgICB0eXBlOiBcInB1c2hcIixcbiAgICAgICAgICAgICAgbGluZTogXCJcIixcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGJyZWFrXG4gICAgICBjYXNlIFwiaW5zZXJ0aW9uXCI6XG4gICAgICAgIHJlc3VsdC5wdXNoKHtcbiAgICAgICAgICB0eXBlOiBcInNwbGljZVwiLFxuICAgICAgICAgIGluZGV4OiBjb250ZXh0SW5kZXgsXG4gICAgICAgICAgbnVtVG9EZWxldGU6IDAsXG4gICAgICAgICAgbGluZXNUb0luc2VydDogcGFydC5saW5lcyxcbiAgICAgICAgfSlcbiAgICAgICAgaWYgKHBhcnQubm9OZXdsaW5lQXRFbmRPZkZpbGUpIHtcbiAgICAgICAgICByZXN1bHQucHVzaCh7IHR5cGU6IFwicG9wXCIgfSlcbiAgICAgICAgfVxuICAgICAgICBicmVha1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgYXNzZXJ0TmV2ZXIocGFydC50eXBlKVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiByZXN1bHRcbn1cbiJdfQ==