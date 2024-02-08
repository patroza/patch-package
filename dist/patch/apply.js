import fs from "fs-extra";
import { dirname, join, relative, resolve } from "path";
import { assertNever } from "../assertNever";
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBwbHkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zcmMvcGF0Y2gvYXBwbHkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLE1BQU0sVUFBVSxDQUFBO0FBQ3pCLE9BQU8sRUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxPQUFPLEVBQUUsTUFBTSxNQUFNLENBQUE7QUFFdkQsT0FBTyxFQUFFLFdBQVcsRUFBRSxNQUFNLGdCQUFnQixDQUFBO0FBRTVDLE1BQU0sQ0FBQyxNQUFNLGNBQWMsR0FBRyxDQUM1QixPQUF3QixFQUN4QixFQUNFLE1BQU0sRUFDTixVQUFVLEVBQ1YsTUFBTSxFQUNOLEdBQUcsR0FDdUUsRUFDNUUsRUFBRTtJQUNGLE1BQU0sS0FBSyxHQUFHLENBQUMsSUFBWSxFQUFFLEVBQUUsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUE7SUFDOUQsTUFBTSxhQUFhLEdBQUcsQ0FBQyxJQUFZLEVBQUUsRUFBRSxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsR0FBRyxFQUFFLEVBQUUsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUE7SUFDNUUsT0FBTyxDQUFDLE9BQU8sQ0FBQyxDQUFDLEdBQUcsRUFBRSxFQUFFO1FBQ3RCLFFBQVEsR0FBRyxDQUFDLElBQUksRUFBRTtZQUNoQixLQUFLLGVBQWU7Z0JBQ2xCLElBQUksTUFBTSxFQUFFO29CQUNWLElBQUksQ0FBQyxFQUFFLENBQUMsVUFBVSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLENBQUMsRUFBRTt3QkFDbkMsTUFBTSxJQUFJLEtBQUssQ0FDYiw0Q0FBNEM7NEJBQzFDLGFBQWEsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLENBQzFCLENBQUE7cUJBQ0Y7aUJBQ0Y7cUJBQU07b0JBQ0wseUJB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QixNQUFNLENBQUMsSUFBSSxDQUFDO3dCQUNWLElBQUksRUFBRSxRQUFRO3dCQUNkLEtBQUssRUFBRSxZQUFZLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNO3dCQUN2QyxXQUFXLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNO3dCQUM5QixhQUFhLEVBQUUsRUFBRTtxQkFDbEIsQ0FBQyxDQUFBO29CQUVGLElBQUksSUFBSSxDQUFDLG9CQUFvQixFQUFFO3dCQUM3QixNQUFNLENBQUMsSUFBSSxDQUFDOzRCQUNWLElBQUksRUFBRSxNQUFNOzRCQUNaLElBQUksRUFBRSxFQUFFO3lCQUNULENBQUMsQ0FBQTtxQkFDSDtpQkFDRjtnQkFDRCxNQUFLO1lBQ1AsS0FBSyxXQUFXO2dCQUNkLE1BQU0sQ0FBQyxJQUFJLENBQUM7b0JBQ1YsSUFBSSxFQUFFLFFBQVE7b0JBQ2QsS0FBSyxFQUFFLFlBQVk7b0JBQ25CLFdBQVcsRUFBRSxDQUFDO29CQUNkLGFBQWEsRUFBRSxJQUFJLENBQUMsS0FBSztpQkFDMUIsQ0FBQyxDQUFBO2dCQUNGLElBQUksSUFBSSxDQUFDLG9CQUFvQixFQUFFO29CQUM3QixNQUFNLENBQUMsSUFBSSxDQUFDLEVBQUUsSUFBSSxFQUFFLEtBQUssRUFBRSxDQUFDLENBQUE7aUJBQzdCO2dCQUNELE1BQUs7WUFDUDtnQkFDRSxXQUFXLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFBO1NBQ3pCO0tBQ0Y7SUFFRCxPQUFPLE1BQU0sQ0FBQTtBQUNmLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgZnMgZnJvbSBcImZzLWV4dHJhXCJcbmltcG9ydCB7IGRpcm5hbWUsIGpvaW4sIHJlbGF0aXZlLCByZXNvbHZlIH0gZnJvbSBcInBhdGhcIlxuaW1wb3J0IHsgUGFyc2VkUGF0Y2hGaWxlLCBGaWxlUGF0Y2gsIEh1bmsgfSBmcm9tIFwiLi9wYXJzZVwiXG5pbXBvcnQgeyBhc3NlcnROZXZlciB9IGZyb20gXCIuLi9hc3NlcnROZXZlclwiXG5cbmV4cG9ydCBjb25zdCBleGVjdXRlRWZmZWN0cyA9IChcbiAgZWZmZWN0czogUGFyc2VkUGF0Y2hGaWxlLFxuICB7XG4gICAgZHJ5UnVuLFxuICAgIGJlc3RFZmZvcnQsXG4gICAgZXJyb3JzLFxuICAgIGN3ZCxcbiAgfTogeyBkcnlSdW46IGJvb2xlYW47IGN3ZD86IHN0cmluZzsgZXJyb3JzPzogc3RyaW5nW107IGJlc3RFZmZvcnQ6IGJvb2xlYW4gfSxcbikgPT4ge1xuICBjb25zdCBpbkN3ZCA9IChwYXRoOiBzdHJpbmcpID0+IChjd2QgPyBqb2luKGN3ZCwgcGF0aCkgOiBwYXRoKVxuICBjb25zdCBodW1hblJlYWRhYmxlID0gKHBhdGg6IHN0cmluZykgPT4gcmVsYXRpdmUocHJvY2Vzcy5jd2QoKSwgaW5Dd2QocGF0aCkpXG4gIGVmZmVjdHMuZm9yRWFjaCgoZWZmKSA9PiB7XG4gICAgc3dpdGNoIChlZmYudHlwZSkge1xuICAgICAgY2FzZSBcImZpbGUgZGVsZXRpb25cIjpcbiAgICAgICAgaWYgKGRyeVJ1bikge1xuICAgICAgICAgIGlmICghZnMuZXhpc3RzU3luYyhpbkN3ZChlZmYucGF0aCkpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgIFwiVHJ5aW5nIHRvIGRlbGV0ZSBmaWxlIHRoYXQgZG9lc24ndCBleGlzdDogXCIgK1xuICAgICAgICAgICAgICAgIGh1bWFuUmVhZGFibGUoZWZmLnBhdGgpLFxuICAgICAgICAgICAgKVxuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyBUT0RPOiBpbnRlZ3JpdHkgY2hlY2tzXG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGZzLnVubGlua1N5bmMoaW5Dd2QoZWZmLnBhdGgpKVxuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIGlmIChiZXN0RWZmb3J0KSB7XG4gICAgICAgICAgICAgIGVycm9ycz8ucHVzaChgRmFpbGVkIHRvIGRlbGV0ZSBmaWxlICR7ZWZmLnBhdGh9YClcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIHRocm93IGVcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWtcbiAgICAgIGNhc2UgXCJyZW5hbWVcIjpcbiAgICAgICAgaWYgKGRyeVJ1bikge1xuICAgICAgICAgIC8vIFRPRE86IHNlZSB3aGF0IHBhdGNoIGZpbGVzIGxvb2sgbGlrZSBpZiBtb3ZpbmcgdG8gZXhpc2luZyBwYXRoXG4gICAgICAgICAgaWYgKCFmcy5leGlzdHNTeW5jKGluQ3dkKGVmZi5mcm9tUGF0aCkpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgIFwiVHJ5aW5nIHRvIG1vdmUgZmlsZSB0aGF0IGRvZXNuJ3QgZXhpc3Q6IFwiICtcbiAgICAgICAgICAgICAgICBodW1hblJlYWRhYmxlKGVmZi5mcm9tUGF0aCksXG4gICAgICAgICAgICApXG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBmcy5tb3ZlU3luYyhpbkN3ZChlZmYuZnJvbVBhdGgpLCBpbkN3ZChlZmYudG9QYXRoKSlcbiAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICBpZiAoYmVzdEVmZm9ydCkge1xuICAgICAgICAgICAgICBlcnJvcnM/LnB1c2goXG4gICAgICAgICAgICAgICAgYEZhaWxlZCB0byByZW5hbWUgZmlsZSAke2VmZi5mcm9tUGF0aH0gdG8gJHtlZmYudG9QYXRofWAsXG4gICAgICAgICAgICAgIClcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIHRocm93IGVcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWtcbiAgICAgIGNhc2UgXCJmaWxlIGNyZWF0aW9uXCI6XG4gICAgICAgIGlmIChkcnlSdW4pIHtcbiAgICAgICAgICBpZiAoZnMuZXhpc3RzU3luYyhpbkN3ZChlZmYucGF0aCkpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgIFwiVHJ5aW5nIHRvIGNyZWF0ZSBmaWxlIHRoYXQgYWxyZWFkeSBleGlzdHM6IFwiICtcbiAgICAgICAgICAgICAgICBodW1hblJlYWRhYmxlKGVmZi5wYXRoKSxcbiAgICAgICAgICAgIClcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8gdG9kbzogY2hlY2sgZmlsZSBjb250ZW50cyBtYXRjaGVzXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgY29uc3QgZmlsZUNvbnRlbnRzID0gZWZmLmh1bmtcbiAgICAgICAgICAgID8gZWZmLmh1bmsucGFydHNbMF0ubGluZXMuam9pbihcIlxcblwiKSArXG4gICAgICAgICAgICAgIChlZmYuaHVuay5wYXJ0c1swXS5ub05ld2xpbmVBdEVuZE9mRmlsZSA/IFwiXCIgOiBcIlxcblwiKVxuICAgICAgICAgICAgOiBcIlwiXG4gICAgICAgICAgY29uc3QgcGF0aCA9IGluQ3dkKGVmZi5wYXRoKVxuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBmcy5lbnN1cmVEaXJTeW5jKGRpcm5hbWUocGF0aCkpXG4gICAgICAgICAgICBmcy53cml0ZUZpbGVTeW5jKHBhdGgsIGZpbGVDb250ZW50cywgeyBtb2RlOiBlZmYubW9kZSB9KVxuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIGlmIChiZXN0RWZmb3J0KSB7XG4gICAgICAgICAgICAgIGVycm9ycz8ucHVzaChgRmFpbGVkIHRvIGNyZWF0ZSBuZXcgZmlsZSAke2VmZi5wYXRofWApXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICB0aHJvdyBlXG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGJyZWFrXG4gICAgICBjYXNlIFwicGF0Y2hcIjpcbiAgICAgICAgYXBwbHlQYXRjaChlZmYsIHsgZHJ5UnVuLCBjd2QsIGJlc3RFZmZvcnQsIGVycm9ycyB9KVxuICAgICAgICBicmVha1xuICAgICAgY2FzZSBcIm1vZGUgY2hhbmdlXCI6XG4gICAgICAgIGNvbnN0IGN1cnJlbnRNb2RlID0gZnMuc3RhdFN5bmMoaW5Dd2QoZWZmLnBhdGgpKS5tb2RlXG4gICAgICAgIGlmIChcbiAgICAgICAgICAoKGlzRXhlY3V0YWJsZShlZmYubmV3TW9kZSkgJiYgaXNFeGVjdXRhYmxlKGN1cnJlbnRNb2RlKSkgfHxcbiAgICAgICAgICAgICghaXNFeGVjdXRhYmxlKGVmZi5uZXdNb2RlKSAmJiAhaXNFeGVjdXRhYmxlKGN1cnJlbnRNb2RlKSkpICYmXG4gICAgICAgICAgZHJ5UnVuXG4gICAgICAgICkge1xuICAgICAgICAgIGNvbnNvbGUubG9nKFxuICAgICAgICAgICAgYE1vZGUgY2hhbmdlIGlzIG5vdCByZXF1aXJlZCBmb3IgZmlsZSAke2h1bWFuUmVhZGFibGUoZWZmLnBhdGgpfWAsXG4gICAgICAgICAgKVxuICAgICAgICB9XG4gICAgICAgIGZzLmNobW9kU3luYyhpbkN3ZChlZmYucGF0aCksIGVmZi5uZXdNb2RlKVxuICAgICAgICBicmVha1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgYXNzZXJ0TmV2ZXIoZWZmKVxuICAgIH1cbiAgfSlcbn1cblxuZnVuY3Rpb24gaXNFeGVjdXRhYmxlKGZpbGVNb2RlOiBudW1iZXIpIHtcbiAgLy8gdHNsaW50OmRpc2FibGUtbmV4dC1saW5lOm5vLWJpdHdpc2VcbiAgcmV0dXJuIChmaWxlTW9kZSAmIDBiMDAxXzAwMF8wMDApID4gMFxufVxuXG5jb25zdCB0cmltUmlnaHQgPSAoczogc3RyaW5nKSA9PiBzLnJlcGxhY2UoL1xccyskLywgXCJcIilcbmZ1bmN0aW9uIGxpbmVzQXJlRXF1YWwoYTogc3RyaW5nLCBiOiBzdHJpbmcpIHtcbiAgcmV0dXJuIHRyaW1SaWdodChhKSA9PT0gdHJpbVJpZ2h0KGIpXG59XG5cbi8qKlxuICogSG93IGRvZXMgbm9OZXdMaW5lQXRFbmRPZkZpbGUgd29yaz9cbiAqXG4gKiBpZiB5b3UgcmVtb3ZlIHRoZSBuZXdsaW5lIGZyb20gYSBmaWxlIHRoYXQgaGFkIG9uZSB3aXRob3V0IGVkaXRpbmcgb3RoZXIgYml0czpcbiAqXG4gKiAgICBpdCBjcmVhdGVzIGFuIGluc2VydGlvbi9yZW1vdmFsIHBhaXIgd2hlcmUgdGhlIGluc2VydGlvbiBoYXMgXFwgTm8gbmV3IGxpbmUgYXQgZW5kIG9mIGZpbGVcbiAqXG4gKiBpZiB5b3UgZWRpdCBhIGZpbGUgdGhhdCBkaWRuJ3QgaGF2ZSBhIG5ldyBsaW5lIGFuZCBkb24ndCBhZGQgb25lOlxuICpcbiAqICAgIGJvdGggaW5zZXJ0aW9uIGFuZCBkZWxldGlvbiBoYXZlIFxcIE5vIG5ldyBsaW5lIGF0IGVuZCBvZiBmaWxlXG4gKlxuICogaWYgeW91IGVkaXQgYSBmaWxlIHRoYXQgZGlkbid0IGhhdmUgYSBuZXcgbGluZSBhbmQgYWRkIG9uZTpcbiAqXG4gKiAgICBkZWxldGlvbiBoYXMgXFwgTm8gbmV3IGxpbmUgYXQgZW5kIG9mIGZpbGVcbiAqICAgIGJ1dCBub3QgaW5zZXJ0aW9uXG4gKlxuICogaWYgeW91IGVkaXQgYSBmaWxlIHRoYXQgaGFkIGEgbmV3IGxpbmUgYW5kIGxlYXZlIGl0IGluOlxuICpcbiAqICAgIG5laXRoZXIgaW5zZXRpb24gbm9yIGRlbGV0aW9uIGhhdmUgdGhlIGFubm9hdGlvblxuICpcbiAqL1xuXG5mdW5jdGlvbiBhcHBseVBhdGNoKFxuICB7IGh1bmtzLCBwYXRoIH06IEZpbGVQYXRjaCxcbiAge1xuICAgIGRyeVJ1bixcbiAgICBjd2QsXG4gICAgYmVzdEVmZm9ydCxcbiAgICBlcnJvcnMsXG4gIH06IHsgZHJ5UnVuOiBib29sZWFuOyBjd2Q/OiBzdHJpbmc7IGJlc3RFZmZvcnQ6IGJvb2xlYW47IGVycm9ycz86IHN0cmluZ1tdIH0sXG4pOiB2b2lkIHtcbiAgcGF0aCA9IGN3ZCA/IHJlc29sdmUoY3dkLCBwYXRoKSA6IHBhdGhcbiAgLy8gbW9kaWZ5aW5nIHRoZSBmaWxlIGluIHBsYWNlXG4gIGNvbnN0IGZpbGVDb250ZW50cyA9IGZzLnJlYWRGaWxlU3luYyhwYXRoKS50b1N0cmluZygpXG4gIGNvbnN0IG1vZGUgPSBmcy5zdGF0U3luYyhwYXRoKS5tb2RlXG5cbiAgY29uc3QgZmlsZUxpbmVzOiBzdHJpbmdbXSA9IGZpbGVDb250ZW50cy5zcGxpdCgvXFxuLylcblxuICBjb25zdCByZXN1bHQ6IE1vZGlmaWNhdGlvbltdW10gPSBbXVxuXG4gIGZvciAoY29uc3QgaHVuayBvZiBodW5rcykge1xuICAgIGxldCBmdXp6aW5nT2Zmc2V0ID0gMFxuICAgIHdoaWxlICh0cnVlKSB7XG4gICAgICBjb25zdCBtb2RpZmljYXRpb25zID0gZXZhbHVhdGVIdW5rKGh1bmssIGZpbGVMaW5lcywgZnV6emluZ09mZnNldClcbiAgICAgIGlmIChtb2RpZmljYXRpb25zKSB7XG4gICAgICAgIHJlc3VsdC5wdXNoKG1vZGlmaWNhdGlvbnMpXG4gICAgICAgIGJyZWFrXG4gICAgICB9XG5cbiAgICAgIGZ1enppbmdPZmZzZXQgPVxuICAgICAgICBmdXp6aW5nT2Zmc2V0IDwgMCA/IGZ1enppbmdPZmZzZXQgKiAtMSA6IGZ1enppbmdPZmZzZXQgKiAtMSAtIDFcblxuICAgICAgaWYgKE1hdGguYWJzKGZ1enppbmdPZmZzZXQpID4gMjApIHtcbiAgICAgICAgY29uc3QgbWVzc2FnZSA9IGBDYW5ub3QgYXBwbHkgaHVuayAke2h1bmtzLmluZGV4T2YoXG4gICAgICAgICAgaHVuayxcbiAgICAgICAgKX0gZm9yIGZpbGUgJHtyZWxhdGl2ZShwcm9jZXNzLmN3ZCgpLCBwYXRoKX1cXG5cXGBcXGBcXGBkaWZmXFxuJHtcbiAgICAgICAgICBodW5rLnNvdXJjZVxuICAgICAgICB9XFxuXFxgXFxgXFxgXFxuYFxuXG4gICAgICAgIGlmIChiZXN0RWZmb3J0KSB7XG4gICAgICAgICAgZXJyb3JzPy5wdXNoKG1lc3NhZ2UpXG4gICAgICAgICAgYnJlYWtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IobWVzc2FnZSlcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGlmIChkcnlSdW4pIHtcbiAgICByZXR1cm5cbiAgfVxuXG4gIGxldCBkaWZmT2Zmc2V0ID0gMFxuXG4gIGZvciAoY29uc3QgbW9kaWZpY2F0aW9ucyBvZiByZXN1bHQpIHtcbiAgICBmb3IgKGNvbnN0IG1vZGlmaWNhdGlvbiBvZiBtb2RpZmljYXRpb25zKSB7XG4gICAgICBzd2l0Y2ggKG1vZGlmaWNhdGlvbi50eXBlKSB7XG4gICAgICAgIGNhc2UgXCJzcGxpY2VcIjpcbiAgICAgICAgICBmaWxlTGluZXMuc3BsaWNlKFxuICAgICAgICAgICAgbW9kaWZpY2F0aW9uLmluZGV4ICsgZGlmZk9mZnNldCxcbiAgICAgICAgICAgIG1vZGlmaWNhdGlvbi5udW1Ub0RlbGV0ZSxcbiAgICAgICAgICAgIC4uLm1vZGlmaWNhdGlvbi5saW5lc1RvSW5zZXJ0LFxuICAgICAgICAgIClcbiAgICAgICAgICBkaWZmT2Zmc2V0ICs9XG4gICAgICAgICAgICBtb2RpZmljYXRpb24ubGluZXNUb0luc2VydC5sZW5ndGggLSBtb2RpZmljYXRpb24ubnVtVG9EZWxldGVcbiAgICAgICAgICBicmVha1xuICAgICAgICBjYXNlIFwicG9wXCI6XG4gICAgICAgICAgZmlsZUxpbmVzLnBvcCgpXG4gICAgICAgICAgYnJlYWtcbiAgICAgICAgY2FzZSBcInB1c2hcIjpcbiAgICAgICAgICBmaWxlTGluZXMucHVzaChtb2RpZmljYXRpb24ubGluZSlcbiAgICAgICAgICBicmVha1xuICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgIGFzc2VydE5ldmVyKG1vZGlmaWNhdGlvbilcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICB0cnkge1xuICAgIGZzLndyaXRlRmlsZVN5bmMocGF0aCwgZmlsZUxpbmVzLmpvaW4oXCJcXG5cIiksIHsgbW9kZSB9KVxuICB9IGNhdGNoIChlKSB7XG4gICAgaWYgKGJlc3RFZmZvcnQpIHtcbiAgICAgIGVycm9ycz8ucHVzaChgRmFpbGVkIHRvIHdyaXRlIGZpbGUgJHtwYXRofWApXG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IGVcbiAgICB9XG4gIH1cbn1cblxuaW50ZXJmYWNlIFB1c2gge1xuICB0eXBlOiBcInB1c2hcIlxuICBsaW5lOiBzdHJpbmdcbn1cbmludGVyZmFjZSBQb3Age1xuICB0eXBlOiBcInBvcFwiXG59XG5pbnRlcmZhY2UgU3BsaWNlIHtcbiAgdHlwZTogXCJzcGxpY2VcIlxuICBpbmRleDogbnVtYmVyXG4gIG51bVRvRGVsZXRlOiBudW1iZXJcbiAgbGluZXNUb0luc2VydDogc3RyaW5nW11cbn1cblxudHlwZSBNb2RpZmljYXRpb24gPSBQdXNoIHwgUG9wIHwgU3BsaWNlXG5cbmZ1bmN0aW9uIGV2YWx1YXRlSHVuayhcbiAgaHVuazogSHVuayxcbiAgZmlsZUxpbmVzOiBzdHJpbmdbXSxcbiAgZnV6emluZ09mZnNldDogbnVtYmVyLFxuKTogTW9kaWZpY2F0aW9uW10gfCBudWxsIHtcbiAgY29uc3QgcmVzdWx0OiBNb2RpZmljYXRpb25bXSA9IFtdXG4gIGxldCBjb250ZXh0SW5kZXggPSBodW5rLmhlYWRlci5vcmlnaW5hbC5zdGFydCAtIDEgKyBmdXp6aW5nT2Zmc2V0XG4gIC8vIGRvIGJvdW5kcyBjaGVja3MgZm9yIGluZGV4XG4gIGlmIChjb250ZXh0SW5kZXggPCAwKSB7XG4gICAgcmV0dXJuIG51bGxcbiAgfVxuICBpZiAoZmlsZUxpbmVzLmxlbmd0aCAtIGNvbnRleHRJbmRleCA8IGh1bmsuaGVhZGVyLm9yaWdpbmFsLmxlbmd0aCkge1xuICAgIHJldHVybiBudWxsXG4gIH1cblxuICBmb3IgKGNvbnN0IHBhcnQgb2YgaHVuay5wYXJ0cykge1xuICAgIHN3aXRjaCAocGFydC50eXBlKSB7XG4gICAgICBjYXNlIFwiZGVsZXRpb25cIjpcbiAgICAgIGNhc2UgXCJjb250ZXh0XCI6XG4gICAgICAgIGZvciAoY29uc3QgbGluZSBvZiBwYXJ0LmxpbmVzKSB7XG4gICAgICAgICAgY29uc3Qgb3JpZ2luYWxMaW5lID0gZmlsZUxpbmVzW2NvbnRleHRJbmRleF1cbiAgICAgICAgICBpZiAoIWxpbmVzQXJlRXF1YWwob3JpZ2luYWxMaW5lLCBsaW5lKSkge1xuICAgICAgICAgICAgcmV0dXJuIG51bGxcbiAgICAgICAgICB9XG4gICAgICAgICAgY29udGV4dEluZGV4KytcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChwYXJ0LnR5cGUgPT09IFwiZGVsZXRpb25cIikge1xuICAgICAgICAgIHJlc3VsdC5wdXNoKHtcbiAgICAgICAgICAgIHR5cGU6IFwic3BsaWNlXCIsXG4gICAgICAgICAgICBpbmRleDogY29udGV4dEluZGV4IC0gcGFydC5saW5lcy5sZW5ndGgsXG4gICAgICAgICAgICBudW1Ub0RlbGV0ZTogcGFydC5saW5lcy5sZW5ndGgsXG4gICAgICAgICAgICBsaW5lc1RvSW5zZXJ0OiBbXSxcbiAgICAgICAgICB9KVxuXG4gICAgICAgICAgaWYgKHBhcnQubm9OZXdsaW5lQXRFbmRPZkZpbGUpIHtcbiAgICAgICAgICAgIHJlc3VsdC5wdXNoKHtcbiAgICAgICAgICAgICAgdHlwZTogXCJwdXNoXCIsXG4gICAgICAgICAgICAgIGxpbmU6IFwiXCIsXG4gICAgICAgICAgICB9KVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBicmVha1xuICAgICAgY2FzZSBcImluc2VydGlvblwiOlxuICAgICAgICByZXN1bHQucHVzaCh7XG4gICAgICAgICAgdHlwZTogXCJzcGxpY2VcIixcbiAgICAgICAgICBpbmRleDogY29udGV4dEluZGV4LFxuICAgICAgICAgIG51bVRvRGVsZXRlOiAwLFxuICAgICAgICAgIGxpbmVzVG9JbnNlcnQ6IHBhcnQubGluZXMsXG4gICAgICAgIH0pXG4gICAgICAgIGlmIChwYXJ0Lm5vTmV3bGluZUF0RW5kT2ZGaWxlKSB7XG4gICAgICAgICAgcmVzdWx0LnB1c2goeyB0eXBlOiBcInBvcFwiIH0pXG4gICAgICAgIH1cbiAgICAgICAgYnJlYWtcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIGFzc2VydE5ldmVyKHBhcnQudHlwZSlcbiAgICB9XG4gIH1cblxuICByZXR1cm4gcmVzdWx0XG59XG4iXX0=