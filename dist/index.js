import chalk from "chalk";
import process from "process";
import minimist from "minimist";
import { applyPatchesForApp } from "./applyPatches.js";
import { getAppRootPath } from "./getAppRootPath.js";
import { makePatch } from "./makePatch.js";
import { makeRegExp } from "./makeRegExp.js";
import { detectPackageManager } from "./detectPackageManager.js";
import { join } from "./path.js";
import { normalize, sep } from "path";
import slash from "slash";
import { isCI } from "ci-info";
import { rebase } from "./rebase.js";
const appPath = getAppRootPath();
const argv = minimist(process.argv.slice(2), {
    boolean: [
        "use-yarn",
        "case-sensitive-path-filtering",
        "reverse",
        "help",
        "version",
        "error-on-fail",
        "error-on-warn",
        "create-issue",
        "partial",
        "",
    ],
    string: ["patch-dir", "append", "rebase"],
});
const packageNames = argv._;
console.log(chalk.bold("patch-package"), 
// tslint:disable-next-line:no-var-requires
require(join(__dirname, "../package.json")).version);
if (argv.version || argv.v) {
    // noop
}
else if (argv.help || argv.h) {
    printHelp();
}
else {
    const patchDir = slash(normalize((argv["patch-dir"] || "patches") + sep));
    if (patchDir.startsWith("/")) {
        throw new Error("--patch-dir must be a relative path");
    }
    if ("rebase" in argv) {
        if (!argv.rebase) {
            console.log(chalk.red("You must specify a patch file name or number when rebasing patches"));
            process.exit(1);
        }
        if (packageNames.length !== 1) {
            console.log(chalk.red("You must specify exactly one package name when rebasing patches"));
            process.exit(1);
        }
        rebase({
            appPath,
            packagePathSpecifier: packageNames[0],
            patchDir,
            targetPatch: argv.rebase,
        });
    }
    else if (packageNames.length) {
        const includePaths = makeRegExp(argv.include, "include", /.*/, argv["case-sensitive-path-filtering"]);
        const excludePaths = makeRegExp(argv.exclude, "exclude", /^package\.json$/, argv["case-sensitive-path-filtering"]);
        const packageManager = detectPackageManager(appPath, argv["use-yarn"] ? "yarn" : argv["use-bun"] ? "bun" : null);
        const createIssue = argv["create-issue"];
        packageNames.forEach((packagePathSpecifier) => {
            makePatch({
                packagePathSpecifier,
                appPath,
                packageManager,
                includePaths,
                excludePaths,
                patchDir,
                createIssue,
                mode: "append" in argv
                    ? { type: "append", name: argv.append || undefined }
                    : { type: "overwrite_last" },
            });
        });
    }
    else {
        console.log("Applying patches...");
        const reverse = !!argv["reverse"];
        // don't want to exit(1) on postinstall locally.
        // see https://github.com/ds300/patch-package/issues/86
        const shouldExitWithError = !!argv["error-on-fail"] ||
            (process.env.NODE_ENV === "production" && isCI) ||
            (isCI && !process.env.PATCH_PACKAGE_INTEGRATION_TEST) ||
            process.env.NODE_ENV === "test";
        const shouldExitWithWarning = !!argv["error-on-warn"];
        applyPatchesForApp({
            appPath,
            reverse,
            patchDir,
            shouldExitWithError,
            shouldExitWithWarning,
            bestEffort: argv.partial,
        });
    }
}
function printHelp() {
    console.log(`
Usage:

  1. Patching packages
  ====================

    ${chalk.bold("patch-package")}

  Without arguments, the ${chalk.bold("patch-package")} command will attempt to find and apply
  patch files to your project. It looks for files named like

     ./patches/<package-name>+<version>.patch

  Options:

    ${chalk.bold("--patch-dir <dirname>")}

      Specify the name for the directory in which the patch files are located.
      
    ${chalk.bold("--error-on-fail")}
    
      Forces patch-package to exit with code 1 after failing.
    
      When running locally patch-package always exits with 0 by default.
      This happens even after failing to apply patches because otherwise 
      yarn.lock and package.json might get out of sync with node_modules,
      which can be very confusing.
      
      --error-on-fail is ${chalk.bold("switched on")} by default on CI.
      
      See https://github.com/ds300/patch-package/issues/86 for background.
      
    ${chalk.bold("--error-on-warn")}
    
      Forces patch-package to exit with code 1 after warning.
      
      See https://github.com/ds300/patch-package/issues/314 for background.

    ${chalk.bold("--reverse")}
        
      Un-applies all patches.

      Note that this will fail if the patched files have changed since being
      patched. In that case, you'll probably need to re-install 'node_modules'.

      This option was added to help people using CircleCI avoid an issue around caching
      and patch file updates (https://github.com/ds300/patch-package/issues/37),
      but might be useful in other contexts too.
      

  2. Creating patch files
  =======================

    ${chalk.bold("patch-package")} <package-name>${chalk.italic("[ <package-name>]")}

  When given package names as arguments, patch-package will create patch files
  based on any changes you've made to the versions installed by yarn/npm.

  Options:
  
    ${chalk.bold("--create-issue")}
    
       For packages whose source is hosted on GitHub this option opens a web
       browser with a draft issue based on your diff.

    ${chalk.bold("--use-yarn")}

        By default, patch-package checks whether you use npm, yarn or bun based on
        which lockfile you have. If you have multiple lockfiles, it uses npm by
        default (in cases where npm is not available, it will resort to yarn). Set 
        this option to override that default and always use yarn.
        
    ${chalk.bold("--use-bun")}
    
        Similar to --use-yarn, but for bun. If both --use-yarn and --use-bun are
        specified, --use-yarn takes precedence.

    ${chalk.bold("--exclude <regexp>")}

        Ignore paths matching the regexp when creating patch files.
        Paths are relative to the root dir of the package to be patched.

        Default: 'package\\.json$'

    ${chalk.bold("--include <regexp>")}

        Only consider paths matching the regexp when creating patch files.
        Paths are relative to the root dir of the package to be patched.

        Default '.*'

    ${chalk.bold("--case-sensitive-path-filtering")}

        Make regexps used in --include or --exclude filters case-sensitive.
    
    ${chalk.bold("--patch-dir")}

        Specify the name for the directory in which to put the patch files.
`);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxLQUFLLE1BQU0sT0FBTyxDQUFBO0FBQ3pCLE9BQU8sT0FBTyxNQUFNLFNBQVMsQ0FBQTtBQUM3QixPQUFPLFFBQVEsTUFBTSxVQUFVLENBQUE7QUFFL0IsT0FBTyxFQUFFLGtCQUFrQixFQUFFLE1BQU0sbUJBQW1CLENBQUE7QUFDdEQsT0FBTyxFQUFFLGNBQWMsRUFBRSxNQUFNLHFCQUFxQixDQUFBO0FBQ3BELE9BQU8sRUFBRSxTQUFTLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQTtBQUMxQyxPQUFPLEVBQUUsVUFBVSxFQUFFLE1BQU0saUJBQWlCLENBQUE7QUFDNUMsT0FBTyxFQUFFLG9CQUFvQixFQUFFLE1BQU0sMkJBQTJCLENBQUE7QUFDaEUsT0FBTyxFQUFFLElBQUksRUFBRSxNQUFNLFdBQVcsQ0FBQTtBQUNoQyxPQUFPLEVBQUUsU0FBUyxFQUFFLEdBQUcsRUFBRSxNQUFNLE1BQU0sQ0FBQTtBQUNyQyxPQUFPLEtBQUssTUFBTSxPQUFPLENBQUE7QUFDekIsT0FBTyxFQUFFLElBQUksRUFBRSxNQUFNLFNBQVMsQ0FBQTtBQUM5QixPQUFPLEVBQUUsTUFBTSxFQUFFLE1BQU0sYUFBYSxDQUFBO0FBRXBDLE1BQU0sT0FBTyxHQUFHLGNBQWMsRUFBRSxDQUFBO0FBQ2hDLE1BQU0sSUFBSSxHQUFHLFFBQVEsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsRUFBRTtJQUMzQyxPQUFPLEVBQUU7UUFDUCxVQUFVO1FBQ1YsK0JBQStCO1FBQy9CLFNBQVM7UUFDVCxNQUFNO1FBQ04sU0FBUztRQUNULGVBQWU7UUFDZixlQUFlO1FBQ2YsY0FBYztRQUNkLFNBQVM7UUFDVCxFQUFFO0tBQ0g7SUFDRCxNQUFNLEVBQUUsQ0FBQyxXQUFXLEVBQUUsUUFBUSxFQUFFLFFBQVEsQ0FB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QUFJLENBQUMsaUJBQWlCLENBQUM7Ozs7OztNQU03QixLQUFLLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQzs7Ozs7Ozs7Ozs7Ozs7O01BZXZCLEtBQUssQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLGtCQUFrQixLQUFLLENBQUMsTUFBTSxDQUMzRCxtQkFBbUIsQ0FDcEI7Ozs7Ozs7TUFPRyxLQUFLLENBQUMsSUFBSSxDQUFDLGdCQUFnQixDQUFDOzs7OztNQUs1QixLQUFLLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQzs7Ozs7OztNQU94QixLQUFLLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQzs7Ozs7TUFLdkIsS0FBSyxDQUFDLElBQUksQ0FBQyxvQkFBb0IsQ0FBQzs7Ozs7OztNQU9oQyxLQUFLLENBQUMsSUFBSSxDQUFDLG9CQUFvQixDQUFDOzs7Ozs7O01BT2hDLEtBQUssQ0FBQyxJQUFJLENBQUMsaUNBQWlDLENBQUM7Ozs7TUFJN0MsS0FBSyxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUM7OztDQUc5QixDQUFDLENBQUE7QUFDRixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IGNoYWxrIGZyb20gXCJjaGFsa1wiXG5pbXBvcnQgcHJvY2VzcyBmcm9tIFwicHJvY2Vzc1wiXG5pbXBvcnQgbWluaW1pc3QgZnJvbSBcIm1pbmltaXN0XCJcblxuaW1wb3J0IHsgYXBwbHlQYXRjaGVzRm9yQXBwIH0gZnJvbSBcIi4vYXBwbHlQYXRjaGVzLmpzXCJcbmltcG9ydCB7IGdldEFwcFJvb3RQYXRoIH0gZnJvbSBcIi4vZ2V0QXBwUm9vdFBhdGguanNcIlxuaW1wb3J0IHsgbWFrZVBhdGNoIH0gZnJvbSBcIi4vbWFrZVBhdGNoLmpzXCJcbmltcG9ydCB7IG1ha2VSZWdFeHAgfSBmcm9tIFwiLi9tYWtlUmVnRXhwLmpzXCJcbmltcG9ydCB7IGRldGVjdFBhY2thZ2VNYW5hZ2VyIH0gZnJvbSBcIi4vZGV0ZWN0UGFja2FnZU1hbmFnZXIuanNcIlxuaW1wb3J0IHsgam9pbiB9IGZyb20gXCIuL3BhdGguanNcIlxuaW1wb3J0IHsgbm9ybWFsaXplLCBzZXAgfSBmcm9tIFwicGF0aFwiXG5pbXBvcnQgc2xhc2ggZnJvbSBcInNsYXNoXCJcbmltcG9ydCB7IGlzQ0kgfSBmcm9tIFwiY2ktaW5mb1wiXG5pbXBvcnQgeyByZWJhc2UgfSBmcm9tIFwiLi9yZWJhc2UuanNcIlxuXG5jb25zdCBhcHBQYXRoID0gZ2V0QXBwUm9vdFBhdGgoKVxuY29uc3QgYXJndiA9IG1pbmltaXN0KHByb2Nlc3MuYXJndi5zbGljZSgyKSwge1xuICBib29sZWFuOiBbXG4gICAgXCJ1c2UteWFyblwiLFxuICAgIFwiY2FzZS1zZW5zaXRpdmUtcGF0aC1maWx0ZXJpbmdcIixcbiAgICBcInJldmVyc2VcIixcbiAgICBcImhlbHBcIixcbiAgICBcInZlcnNpb25cIixcbiAgICBcImVycm9yLW9uLWZhaWxcIixcbiAgICBcImVycm9yLW9uLXdhcm5cIixcbiAgICBcImNyZWF0ZS1pc3N1ZVwiLFxuICAgIFwicGFydGlhbFwiLFxuICAgIFwiXCIsXG4gIF0sXG4gIHN0cmluZzogW1wicGF0Y2gtZGlyXCIsIFwiYXBwZW5kXCIsIFwicmViYXNlXCJdLFxufSlcbmNvbnN0IHBhY2thZ2VOYW1lcyA9IGFyZ3YuX1xuXG5jb25zb2xlLmxvZyhcbiAgY2hhbGsuYm9sZChcInBhdGNoLXBhY2thZ2VcIiksXG4gIC8vIHRzbGludDpkaXNhYmxlLW5leHQtbGluZTpuby12YXItcmVxdWlyZXNcbiAgcmVxdWlyZShqb2luKF9fZGlybmFtZSwgXCIuLi9wYWNrYWdlLmpzb25cIikpLnZlcnNpb24sXG4pXG5cbmlmIChhcmd2LnZlcnNpb24gfHwgYXJndi52KSB7XG4gIC8vIG5vb3Bcbn0gZWxzZSBpZiAoYXJndi5oZWxwIHx8IGFyZ3YuaCkge1xuICBwcmludEhlbHAoKVxufSBlbHNlIHtcbiAgY29uc3QgcGF0Y2hEaXIgPSBzbGFzaChub3JtYWxpemUoKGFyZ3ZbXCJwYXRjaC1kaXJcIl0gfHwgXCJwYXRjaGVzXCIpICsgc2VwKSlcbiAgaWYgKHBhdGNoRGlyLnN0YXJ0c1dpdGgoXCIvXCIpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiLS1wYXRjaC1kaXIgbXVzdCBiZSBhIHJlbGF0aXZlIHBhdGhcIilcbiAgfVxuICBpZiAoXCJyZWJhc2VcIiBpbiBhcmd2KSB7XG4gICAgaWYgKCFhcmd2LnJlYmFzZSkge1xuICAgICAgY29uc29sZS5sb2coXG4gICAgICAgIGNoYWxrLnJlZChcbiAgICAgICAgICBcIllvdSBtdXN0IHNwZWNpZnkgYSBwYXRjaCBmaWxlIG5hbWUgb3IgbnVtYmVyIHdoZW4gcmViYXNpbmcgcGF0Y2hlc1wiLFxuICAgICAgICApLFxuICAgICAgKVxuICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgfVxuICAgIGlmIChwYWNrYWdlTmFtZXMubGVuZ3RoICE9PSAxKSB7XG4gICAgICBjb25zb2xlLmxvZyhcbiAgICAgICAgY2hhbGsucmVkKFxuICAgICAgICAgIFwiWW91IG11c3Qgc3BlY2lmeSBleGFjdGx5IG9uZSBwYWNrYWdlIG5hbWUgd2hlbiByZWJhc2luZyBwYXRjaGVzXCIsXG4gICAgICAgICksXG4gICAgICApXG4gICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICB9XG4gICAgcmViYXNlKHtcbiAgICAgIGFwcFBhdGgsXG4gICAgICBwYWNrYWdlUGF0aFNwZWNpZmllcjogcGFja2FnZU5hbWVzWzBdLFxuICAgICAgcGF0Y2hEaXIsXG4gICAgICB0YXJnZXRQYXRjaDogYXJndi5yZWJhc2UsXG4gICAgfSlcbiAgfSBlbHNlIGlmIChwYWNrYWdlTmFtZXMubGVuZ3RoKSB7XG4gICAgY29uc3QgaW5jbHVkZVBhdGhzID0gbWFrZVJlZ0V4cChcbiAgICAgIGFyZ3YuaW5jbHVkZSxcbiAgICAgIFwiaW5jbHVkZVwiLFxuICAgICAgLy4qLyxcbiAgICAgIGFyZ3ZbXCJjYXNlLXNlbnNpdGl2ZS1wYXRoLWZpbHRlcmluZ1wiXSxcbiAgICApXG4gICAgY29uc3QgZXhjbHVkZVBhdGhzID0gbWFrZVJlZ0V4cChcbiAgICAgIGFyZ3YuZXhjbHVkZSxcbiAgICAgIFwiZXhjbHVkZVwiLFxuICAgICAgL15wYWNrYWdlXFwuanNvbiQvLFxuICAgICAgYXJndltcImNhc2Utc2Vuc2l0aXZlLXBhdGgtZmlsdGVyaW5nXCJdLFxuICAgIClcbiAgICBjb25zdCBwYWNrYWdlTWFuYWdlciA9IGRldGVjdFBhY2thZ2VNYW5hZ2VyKFxuICAgICAgYXBwUGF0aCxcbiAgICAgIGFyZ3ZbXCJ1c2UteWFyblwiXSA/IFwieWFyblwiIDogYXJndltcInVzZS1idW5cIl0gPyBcImJ1blwiIDogbnVsbCxcbiAgICApXG4gICAgY29uc3QgY3JlYXRlSXNzdWUgPSBhcmd2W1wiY3JlYXRlLWlzc3VlXCJdXG4gICAgcGFja2FnZU5hbWVzLmZvckVhY2goKHBhY2thZ2VQYXRoU3BlY2lmaWVyOiBzdHJpbmcpID0+IHtcbiAgICAgIG1ha2VQYXRjaCh7XG4gICAgICAgIHBhY2thZ2VQYXRoU3BlY2lmaWVyLFxuICAgICAgICBhcHBQYXRoLFxuICAgICAgICBwYWNrYWdlTWFuYWdlcixcbiAgICAgICAgaW5jbHVkZVBhdGhzLFxuICAgICAgICBleGNsdWRlUGF0aHMsXG4gICAgICAgIHBhdGNoRGlyLFxuICAgICAgICBjcmVhdGVJc3N1ZSxcbiAgICAgICAgbW9kZTpcbiAgICAgICAgICBcImFwcGVuZFwiIGluIGFyZ3ZcbiAgICAgICAgICAgID8geyB0eXBlOiBcImFwcGVuZFwiLCBuYW1lOiBhcmd2LmFwcGVuZCB8fCB1bmRlZmluZWQgfVxuICAgICAgICAgICAgOiB7IHR5cGU6IFwib3ZlcndyaXRlX2xhc3RcIiB9LFxuICAgICAgfSlcbiAgICB9KVxuICB9IGVsc2Uge1xuICAgIGNvbnNvbGUubG9nKFwiQXBwbHlpbmcgcGF0Y2hlcy4uLlwiKVxuICAgIGNvbnN0IHJldmVyc2UgPSAhIWFyZ3ZbXCJyZXZlcnNlXCJdXG4gICAgLy8gZG9uJ3Qgd2FudCB0byBleGl0KDEpIG9uIHBvc3RpbnN0YWxsIGxvY2FsbHkuXG4gICAgLy8gc2VlIGh0dHBzOi8vZ2l0aHViLmNvbS9kczMwMC9wYXRjaC1wYWNrYWdlL2lzc3Vlcy84NlxuICAgIGNvbnN0IHNob3VsZEV4aXRXaXRoRXJyb3IgPVxuICAgICAgISFhcmd2W1wiZXJyb3Itb24tZmFpbFwiXSB8fFxuICAgICAgKHByb2Nlc3MuZW52Lk5PREVfRU5WID09PSBcInByb2R1Y3Rpb25cIiAmJiBpc0NJKSB8fFxuICAgICAgKGlzQ0kgJiYgIXByb2Nlc3MuZW52LlBBVENIX1BBQ0tBR0VfSU5URUdSQVRJT05fVEVTVCkgfHxcbiAgICAgIHByb2Nlc3MuZW52Lk5PREVfRU5WID09PSBcInRlc3RcIlxuXG4gICAgY29uc3Qgc2hvdWxkRXhpdFdpdGhXYXJuaW5nID0gISFhcmd2W1wiZXJyb3Itb24td2FyblwiXVxuXG4gICAgYXBwbHlQYXRjaGVzRm9yQXBwKHtcbiAgICAgIGFwcFBhdGgsXG4gICAgICByZXZlcnNlLFxuICAgICAgcGF0Y2hEaXIsXG4gICAgICBzaG91bGRFeGl0V2l0aEVycm9yLFxuICAgICAgc2hvdWxkRXhpdFdpdGhXYXJuaW5nLFxuICAgICAgYmVzdEVmZm9ydDogYXJndi5wYXJ0aWFsLFxuICAgIH0pXG4gIH1cbn1cblxuZnVuY3Rpb24gcHJpbnRIZWxwKCkge1xuICBjb25zb2xlLmxvZyhgXG5Vc2FnZTpcblxuICAxLiBQYXRjaGluZyBwYWNrYWdlc1xuICA9PT09PT09PT09PT09PT09PT09PVxuXG4gICAgJHtjaGFsay5ib2xkKFwicGF0Y2gtcGFja2FnZVwiKX1cblxuICBXaXRob3V0IGFyZ3VtZW50cywgdGhlICR7Y2hhbGsuYm9sZChcbiAgICBcInBhdGNoLXBhY2thZ2VcIixcbiAgKX0gY29tbWFuZCB3aWxsIGF0dGVtcHQgdG8gZmluZCBhbmQgYXBwbHlcbiAgcGF0Y2ggZmlsZXMgdG8geW91ciBwcm9qZWN0LiBJdCBsb29rcyBmb3IgZmlsZXMgbmFtZWQgbGlrZVxuXG4gICAgIC4vcGF0Y2hlcy88cGFja2FnZS1uYW1lPis8dmVyc2lvbj4ucGF0Y2hcblxuICBPcHRpb25zOlxuXG4gICAgJHtjaGFsay5ib2xkKFwiLS1wYXRjaC1kaXIgPGRpcm5hbWU+XCIpfVxuXG4gICAgICBTcGVjaWZ5IHRoZSBuYW1lIGZvciB0aGUgZGlyZWN0b3J5IGluIHdoaWNoIHRoZSBwYXRjaCBmaWxlcyBhcmUgbG9jYXRlZC5cbiAgICAgIFxuICAgICR7Y2hhbGsuYm9sZChcIi0tZXJyb3Itb24tZmFpbFwiKX1cbiAgICBcbiAgICAgIEZvcmNlcyBwYXRjaC1wYWNrYWdlIHRvIGV4aXQgd2l0aCBjb2RlIDEgYWZ0ZXIgZmFpbGluZy5cbiAgICBcbiAgICAgIFdoZW4gcnVubmluZyBsb2NhbGx5IHBhdGNoLXBhY2thZ2UgYWx3YXlzIGV4aXRzIHdpdGggMCBieSBkZWZhdWx0LlxuICAgICAgVGhpcyBoYXBwZW5zIGV2ZW4gYWZ0ZXIgZmFpbGluZyB0byBhcHBseSBwYXRjaGVzIGJlY2F1c2Ugb3RoZXJ3aXNlIFxuICAgICAgeWFybi5sb2NrIGFuZCBwYWNrYWdlLmpzb24gbWlnaHQgZ2V0IG91dCBvZiBzeW5jIHdpdGggbm9kZV9tb2R1bGVzLFxuICAgICAgd2hpY2ggY2FuIGJlIHZlcnkgY29uZnVzaW5nLlxuICAgICAgXG4gICAgICAtLWVycm9yLW9uLWZhaWwgaXMgJHtjaGFsay5ib2xkKFwic3dpdGNoZWQgb25cIil9IGJ5IGRlZmF1bHQgb24gQ0kuXG4gICAgICBcbiAgICAgIFNlZSBodHRwczovL2dpdGh1Yi5jb20vZHMzMDAvcGF0Y2gtcGFja2FnZS9pc3N1ZXMvODYgZm9yIGJhY2tncm91bmQuXG4gICAgICBcbiAgICAke2NoYWxrLmJvbGQoXCItLWVycm9yLW9uLXdhcm5cIil9XG4gICAgXG4gICAgICBGb3JjZXMgcGF0Y2gtcGFja2FnZSB0byBleGl0IHdpdGggY29kZSAxIGFmdGVyIHdhcm5pbmcuXG4gICAgICBcbiAgICAgIFNlZSBodHRwczovL2dpdGh1Yi5jb20vZHMzMDAvcGF0Y2gtcGFja2FnZS9pc3N1ZXMvMzE0IGZvciBiYWNrZ3JvdW5kLlxuXG4gICAgJHtjaGFsay5ib2xkKFwiLS1yZXZlcnNlXCIpfVxuICAgICAgICBcbiAgICAgIFVuLWFwcGxpZXMgYWxsIHBhdGNoZXMuXG5cbiAgICAgIE5vdGUgdGhhdCB0aGlzIHdpbGwgZmFpbCBpZiB0aGUgcGF0Y2hlZCBmaWxlcyBoYXZlIGNoYW5nZWQgc2luY2UgYmVpbmdcbiAgICAgIHBhdGNoZWQuIEluIHRoYXQgY2FzZSwgeW91J2xsIHByb2JhYmx5IG5lZWQgdG8gcmUtaW5zdGFsbCAnbm9kZV9tb2R1bGVzJy5cblxuICAgICAgVGhpcyBvcHRpb24gd2FzIGFkZGVkIHRvIGhlbHAgcGVvcGxlIHVzaW5nIENpcmNsZUNJIGF2b2lkIGFuIGlzc3VlIGFyb3VuZCBjYWNoaW5nXG4gICAgICBhbmQgcGF0Y2ggZmlsZSB1cGRhdGVzIChodHRwczovL2dpdGh1Yi5jb20vZHMzMDAvcGF0Y2gtcGFja2FnZS9pc3N1ZXMvMzcpLFxuICAgICAgYnV0IG1pZ2h0IGJlIHVzZWZ1bCBpbiBvdGhlciBjb250ZXh0cyB0b28uXG4gICAgICBcblxuICAyLiBDcmVhdGluZyBwYXRjaCBmaWxlc1xuICA9PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgJHtjaGFsay5ib2xkKFwicGF0Y2gtcGFja2FnZVwiKX0gPHBhY2thZ2UtbmFtZT4ke2NoYWxrLml0YWxpYyhcbiAgICBcIlsgPHBhY2thZ2UtbmFtZT5dXCIsXG4gICl9XG5cbiAgV2hlbiBnaXZlbiBwYWNrYWdlIG5hbWVzIGFzIGFyZ3VtZW50cywgcGF0Y2gtcGFja2FnZSB3aWxsIGNyZWF0ZSBwYXRjaCBmaWxlc1xuICBiYXNlZCBvbiBhbnkgY2hhbmdlcyB5b3UndmUgbWFkZSB0byB0aGUgdmVyc2lvbnMgaW5zdGFsbGVkIGJ5IHlhcm4vbnBtLlxuXG4gIE9wdGlvbnM6XG4gIFxuICAgICR7Y2hhbGsuYm9sZChcIi0tY3JlYXRlLWlzc3VlXCIpfVxuICAgIFxuICAgICAgIEZvciBwYWNrYWdlcyB3aG9zZSBzb3VyY2UgaXMgaG9zdGVkIG9uIEdpdEh1YiB0aGlzIG9wdGlvbiBvcGVucyBhIHdlYlxuICAgICAgIGJyb3dzZXIgd2l0aCBhIGRyYWZ0IGlzc3VlIGJhc2VkIG9uIHlvdXIgZGlmZi5cblxuICAgICR7Y2hhbGsuYm9sZChcIi0tdXNlLXlhcm5cIil9XG5cbiAgICAgICAgQnkgZGVmYXVsdCwgcGF0Y2gtcGFja2FnZSBjaGVja3Mgd2hldGhlciB5b3UgdXNlIG5wbSwgeWFybiBvciBidW4gYmFzZWQgb25cbiAgICAgICAgd2hpY2ggbG9ja2ZpbGUgeW91IGhhdmUuIElmIHlvdSBoYXZlIG11bHRpcGxlIGxvY2tmaWxlcywgaXQgdXNlcyBucG0gYnlcbiAgICAgICAgZGVmYXVsdCAoaW4gY2FzZXMgd2hlcmUgbnBtIGlzIG5vdCBhdmFpbGFibGUsIGl0IHdpbGwgcmVzb3J0IHRvIHlhcm4pLiBTZXQgXG4gICAgICAgIHRoaXMgb3B0aW9uIHRvIG92ZXJyaWRlIHRoYXQgZGVmYXVsdCBhbmQgYWx3YXlzIHVzZSB5YXJuLlxuICAgICAgICBcbiAgICAke2NoYWxrLmJvbGQoXCItLXVzZS1idW5cIil9XG4gICAgXG4gICAgICAgIFNpbWlsYXIgdG8gLS11c2UteWFybiwgYnV0IGZvciBidW4uIElmIGJvdGggLS11c2UteWFybiBhbmQgLS11c2UtYnVuIGFyZVxuICAgICAgICBzcGVjaWZpZWQsIC0tdXNlLXlhcm4gdGFrZXMgcHJlY2VkZW5jZS5cblxuICAgICR7Y2hhbGsuYm9sZChcIi0tZXhjbHVkZSA8cmVnZXhwPlwiKX1cblxuICAgICAgICBJZ25vcmUgcGF0aHMgbWF0Y2hpbmcgdGhlIHJlZ2V4cCB3aGVuIGNyZWF0aW5nIHBhdGNoIGZpbGVzLlxuICAgICAgICBQYXRocyBhcmUgcmVsYXRpdmUgdG8gdGhlIHJvb3QgZGlyIG9mIHRoZSBwYWNrYWdlIHRvIGJlIHBhdGNoZWQuXG5cbiAgICAgICAgRGVmYXVsdDogJ3BhY2thZ2VcXFxcLmpzb24kJ1xuXG4gICAgJHtjaGFsay5ib2xkKFwiLS1pbmNsdWRlIDxyZWdleHA+XCIpfVxuXG4gICAgICAgIE9ubHkgY29uc2lkZXIgcGF0aHMgbWF0Y2hpbmcgdGhlIHJlZ2V4cCB3aGVuIGNyZWF0aW5nIHBhdGNoIGZpbGVzLlxuICAgICAgICBQYXRocyBhcmUgcmVsYXRpdmUgdG8gdGhlIHJvb3QgZGlyIG9mIHRoZSBwYWNrYWdlIHRvIGJlIHBhdGNoZWQuXG5cbiAgICAgICAgRGVmYXVsdCAnLionXG5cbiAgICAke2NoYWxrLmJvbGQoXCItLWNhc2Utc2Vuc2l0aXZlLXBhdGgtZmlsdGVyaW5nXCIpfVxuXG4gICAgICAgIE1ha2UgcmVnZXhwcyB1c2VkIGluIC0taW5jbHVkZSBvciAtLWV4Y2x1ZGUgZmlsdGVycyBjYXNlLXNlbnNpdGl2ZS5cbiAgICBcbiAgICAke2NoYWxrLmJvbGQoXCItLXBhdGNoLWRpclwiKX1cblxuICAgICAgICBTcGVjaWZ5IHRoZSBuYW1lIGZvciB0aGUgZGlyZWN0b3J5IGluIHdoaWNoIHRvIHB1dCB0aGUgcGF0Y2ggZmlsZXMuXG5gKVxufVxuIl19