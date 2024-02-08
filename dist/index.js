import chalk from "chalk";
import process from "process";
import minimist from "minimist";
import { applyPatchesForApp } from "./applyPatches";
import { getAppRootPath } from "./getAppRootPath";
import { makePatch } from "./makePatch";
import { makeRegExp } from "./makeRegExp";
import { detectPackageManager } from "./detectPackageManager";
import { join } from "./path";
import { normalize, sep } from "path";
import slash from "slash";
import { isCI } from "ci-info";
import { rebase } from "./rebase";
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxLQUFLLE1BQU0sT0FBTyxDQUFBO0FBQ3pCLE9BQU8sT0FBTyxNQUFNLFNBQVMsQ0FBQTtBQUM3QixPQUFPLFFBQVEsTUFBTSxVQUFVLENBQUE7QUFFL0IsT0FBTyxFQUFFLGtCQUFrQixFQUFFLE1BQU0sZ0JBQWdCLENBQUE7QUFDbkQsT0FBTyxFQUFFLGNBQWMsRUFBRSxNQUFNLGtCQUFrQixDQUFBO0FBQ2pELE9BQU8sRUFBRSxTQUFTLEVBQUUsTUFBTSxhQUFhLENBQUE7QUFDdkMsT0FBTyxFQUFFLFVBQVUsRUFBRSxNQUFNLGNBQWMsQ0FBQTtBQUN6QyxPQUFPLEVBQUUsb0JBQW9CLEVBQUUsTUFBTSx3QkFBd0IsQ0FBQTtBQUM3RCxPQUFPLEVBQUUsSUFBSSxFQUFFLE1BQU0sUUFBUSxDQUFBO0FBQzdCLE9BQU8sRUFBRSxTQUFTLEVBQUUsR0FBRyxFQUFFLE1BQU0sTUFBTSxDQUFBO0FBQ3JDLE9BQU8sS0FBSyxNQUFNLE9BQU8sQ0FBQTtBQUN6QixPQUFPLEVBQUUsSUFBSSxFQUFFLE1BQU0sU0FBUyxDQUFBO0FBQzlCLE9BQU8sRUFBRSxNQUFNLEVBQUUsTUFBTSxVQUFVLENBQUE7QUFFakMsTUFBTSxPQUFPLEdBQUcsY0FBYyxFQUFFLENBQUE7QUFDaEMsTUFBTSxJQUFJLEdBQUcsUUFBUSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxFQUFFO0lBQzNDLE9BQU8sRUFBRTtRQUNQLFVBQVU7UUFDViwrQkFBK0I7UUFDL0IsU0FBUztRQUNULE1BQU07UUFDTixTQUFTO1FBQ1QsZUFBZTtRQUNmLGVBQWU7UUFDZixjQUFjO1FBQ2QsU0FBUztRQUNULEVBQUU7S0FDSDtJQUNELE1BQU0sRUFBRSxDQUFDLFdBQVcsRUFBRSxRQUFRLEVBQUUsUUFBUSxDQUFDO0NB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QUksQ0FBQyxlQUFlLENBQUMsa0JBQWtCLEtBQUssQ0FBQyxNQUFNLENBQzNELG1CQUFtQixDQUNwQjs7Ozs7OztNQU9HLEtBQUssQ0FBQyxJQUFJLENBQUMsZ0JBQWdCLENBQUM7Ozs7O01BSzVCLEtBQUssQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDOzs7Ozs7O01BT3hCLEtBQUssQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDOzs7OztNQUt2QixLQUFLLENBQUMsSUFBSSxDQUFDLG9CQUFvQixDQUFDOzs7Ozs7O01BT2hDLEtBQUssQ0FBQyxJQUFJLENBQUMsb0JBQW9CLENBQUM7Ozs7Ozs7TUFPaEMsS0FBSyxDQUFDLElBQUksQ0FBQyxpQ0FBaUMsQ0FBQzs7OztNQUk3QyxLQUFLLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQzs7O0NBRzlCLENBQUMsQ0FBQTtBQUNGLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgY2hhbGsgZnJvbSBcImNoYWxrXCJcbmltcG9ydCBwcm9jZXNzIGZyb20gXCJwcm9jZXNzXCJcbmltcG9ydCBtaW5pbWlzdCBmcm9tIFwibWluaW1pc3RcIlxuXG5pbXBvcnQgeyBhcHBseVBhdGNoZXNGb3JBcHAgfSBmcm9tIFwiLi9hcHBseVBhdGNoZXNcIlxuaW1wb3J0IHsgZ2V0QXBwUm9vdFBhdGggfSBmcm9tIFwiLi9nZXRBcHBSb290UGF0aFwiXG5pbXBvcnQgeyBtYWtlUGF0Y2ggfSBmcm9tIFwiLi9tYWtlUGF0Y2hcIlxuaW1wb3J0IHsgbWFrZVJlZ0V4cCB9IGZyb20gXCIuL21ha2VSZWdFeHBcIlxuaW1wb3J0IHsgZGV0ZWN0UGFja2FnZU1hbmFnZXIgfSBmcm9tIFwiLi9kZXRlY3RQYWNrYWdlTWFuYWdlclwiXG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIi4vcGF0aFwiXG5pbXBvcnQgeyBub3JtYWxpemUsIHNlcCB9IGZyb20gXCJwYXRoXCJcbmltcG9ydCBzbGFzaCBmcm9tIFwic2xhc2hcIlxuaW1wb3J0IHsgaXNDSSB9IGZyb20gXCJjaS1pbmZvXCJcbmltcG9ydCB7IHJlYmFzZSB9IGZyb20gXCIuL3JlYmFzZVwiXG5cbmNvbnN0IGFwcFBhdGggPSBnZXRBcHBSb290UGF0aCgpXG5jb25zdCBhcmd2ID0gbWluaW1pc3QocHJvY2Vzcy5hcmd2LnNsaWNlKDIpLCB7XG4gIGJvb2xlYW46IFtcbiAgICBcInVzZS15YXJuXCIsXG4gICAgXCJjYXNlLXNlbnNpdGl2ZS1wYXRoLWZpbHRlcmluZ1wiLFxuICAgIFwicmV2ZXJzZVwiLFxuICAgIFwiaGVscFwiLFxuICAgIFwidmVyc2lvblwiLFxuICAgIFwiZXJyb3Itb24tZmFpbFwiLFxuICAgIFwiZXJyb3Itb24td2FyblwiLFxuICAgIFwiY3JlYXRlLWlzc3VlXCIsXG4gICAgXCJwYXJ0aWFsXCIsXG4gICAgXCJcIixcbiAgXSxcbiAgc3RyaW5nOiBbXCJwYXRjaC1kaXJcIiwgXCJhcHBlbmRcIiwgXCJyZWJhc2VcIl0sXG59KVxuY29uc3QgcGFja2FnZU5hbWVzID0gYXJndi5fXG5cbmNvbnNvbGUubG9nKFxuICBjaGFsay5ib2xkKFwicGF0Y2gtcGFja2FnZVwiKSxcbiAgLy8gdHNsaW50OmRpc2FibGUtbmV4dC1saW5lOm5vLXZhci1yZXF1aXJlc1xuICByZXF1aXJlKGpvaW4oX19kaXJuYW1lLCBcIi4uL3BhY2thZ2UuanNvblwiKSkudmVyc2lvbixcbilcblxuaWYgKGFyZ3YudmVyc2lvbiB8fCBhcmd2LnYpIHtcbiAgLy8gbm9vcFxufSBlbHNlIGlmIChhcmd2LmhlbHAgfHwgYXJndi5oKSB7XG4gIHByaW50SGVscCgpXG59IGVsc2Uge1xuICBjb25zdCBwYXRjaERpciA9IHNsYXNoKG5vcm1hbGl6ZSgoYXJndltcInBhdGNoLWRpclwiXSB8fCBcInBhdGNoZXNcIikgKyBzZXApKVxuICBpZiAocGF0Y2hEaXIuc3RhcnRzV2l0aChcIi9cIikpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCItLXBhdGNoLWRpciBtdXN0IGJlIGEgcmVsYXRpdmUgcGF0aFwiKVxuICB9XG4gIGlmIChcInJlYmFzZVwiIGluIGFyZ3YpIHtcbiAgICBpZiAoIWFyZ3YucmViYXNlKSB7XG4gICAgICBjb25zb2xlLmxvZyhcbiAgICAgICAgY2hhbGsucmVkKFxuICAgICAgICAgIFwiWW91IG11c3Qgc3BlY2lmeSBhIHBhdGNoIGZpbGUgbmFtZSBvciBudW1iZXIgd2hlbiByZWJhc2luZyBwYXRjaGVzXCIsXG4gICAgICAgICksXG4gICAgICApXG4gICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICB9XG4gICAgaWYgKHBhY2thZ2VOYW1lcy5sZW5ndGggIT09IDEpIHtcbiAgICAgIGNvbnNvbGUubG9nKFxuICAgICAgICBjaGFsay5yZWQoXG4gICAgICAgICAgXCJZb3UgbXVzdCBzcGVjaWZ5IGV4YWN0bHkgb25lIHBhY2thZ2UgbmFtZSB3aGVuIHJlYmFzaW5nIHBhdGNoZXNcIixcbiAgICAgICAgKSxcbiAgICAgIClcbiAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgIH1cbiAgICByZWJhc2Uoe1xuICAgICAgYXBwUGF0aCxcbiAgICAgIHBhY2thZ2VQYXRoU3BlY2lmaWVyOiBwYWNrYWdlTmFtZXNbMF0sXG4gICAgICBwYXRjaERpcixcbiAgICAgIHRhcmdldFBhdGNoOiBhcmd2LnJlYmFzZSxcbiAgICB9KVxuICB9IGVsc2UgaWYgKHBhY2thZ2VOYW1lcy5sZW5ndGgpIHtcbiAgICBjb25zdCBpbmNsdWRlUGF0aHMgPSBtYWtlUmVnRXhwKFxuICAgICAgYXJndi5pbmNsdWRlLFxuICAgICAgXCJpbmNsdWRlXCIsXG4gICAgICAvLiovLFxuICAgICAgYXJndltcImNhc2Utc2Vuc2l0aXZlLXBhdGgtZmlsdGVyaW5nXCJdLFxuICAgIClcbiAgICBjb25zdCBleGNsdWRlUGF0aHMgPSBtYWtlUmVnRXhwKFxuICAgICAgYXJndi5leGNsdWRlLFxuICAgICAgXCJleGNsdWRlXCIsXG4gICAgICAvXnBhY2thZ2VcXC5qc29uJC8sXG4gICAgICBhcmd2W1wiY2FzZS1zZW5zaXRpdmUtcGF0aC1maWx0ZXJpbmdcIl0sXG4gICAgKVxuICAgIGNvbnN0IHBhY2thZ2VNYW5hZ2VyID0gZGV0ZWN0UGFja2FnZU1hbmFnZXIoXG4gICAgICBhcHBQYXRoLFxuICAgICAgYXJndltcInVzZS15YXJuXCJdID8gXCJ5YXJuXCIgOiBhcmd2W1widXNlLWJ1blwiXSA/IFwiYnVuXCIgOiBudWxsLFxuICAgIClcbiAgICBjb25zdCBjcmVhdGVJc3N1ZSA9IGFyZ3ZbXCJjcmVhdGUtaXNzdWVcIl1cbiAgICBwYWNrYWdlTmFtZXMuZm9yRWFjaCgocGFja2FnZVBhdGhTcGVjaWZpZXI6IHN0cmluZykgPT4ge1xuICAgICAgbWFrZVBhdGNoKHtcbiAgICAgICAgcGFja2FnZVBhdGhTcGVjaWZpZXIsXG4gICAgICAgIGFwcFBhdGgsXG4gICAgICAgIHBhY2thZ2VNYW5hZ2VyLFxuICAgICAgICBpbmNsdWRlUGF0aHMsXG4gICAgICAgIGV4Y2x1ZGVQYXRocyxcbiAgICAgICAgcGF0Y2hEaXIsXG4gICAgICAgIGNyZWF0ZUlzc3VlLFxuICAgICAgICBtb2RlOlxuICAgICAgICAgIFwiYXBwZW5kXCIgaW4gYXJndlxuICAgICAgICAgICAgPyB7IHR5cGU6IFwiYXBwZW5kXCIsIG5hbWU6IGFyZ3YuYXBwZW5kIHx8IHVuZGVmaW5lZCB9XG4gICAgICAgICAgICA6IHsgdHlwZTogXCJvdmVyd3JpdGVfbGFzdFwiIH0sXG4gICAgICB9KVxuICAgIH0pXG4gIH0gZWxzZSB7XG4gICAgY29uc29sZS5sb2coXCJBcHBseWluZyBwYXRjaGVzLi4uXCIpXG4gICAgY29uc3QgcmV2ZXJzZSA9ICEhYXJndltcInJldmVyc2VcIl1cbiAgICAvLyBkb24ndCB3YW50IHRvIGV4aXQoMSkgb24gcG9zdGluc3RhbGwgbG9jYWxseS5cbiAgICAvLyBzZWUgaHR0cHM6Ly9naXRodWIuY29tL2RzMzAwL3BhdGNoLXBhY2thZ2UvaXNzdWVzLzg2XG4gICAgY29uc3Qgc2hvdWxkRXhpdFdpdGhFcnJvciA9XG4gICAgICAhIWFyZ3ZbXCJlcnJvci1vbi1mYWlsXCJdIHx8XG4gICAgICAocHJvY2Vzcy5lbnYuTk9ERV9FTlYgPT09IFwicHJvZHVjdGlvblwiICYmIGlzQ0kpIHx8XG4gICAgICAoaXNDSSAmJiAhcHJvY2Vzcy5lbnYuUEFUQ0hfUEFDS0FHRV9JTlRFR1JBVElPTl9URVNUKSB8fFxuICAgICAgcHJvY2Vzcy5lbnYuTk9ERV9FTlYgPT09IFwidGVzdFwiXG5cbiAgICBjb25zdCBzaG91bGRFeGl0V2l0aFdhcm5pbmcgPSAhIWFyZ3ZbXCJlcnJvci1vbi13YXJuXCJdXG5cbiAgICBhcHBseVBhdGNoZXNGb3JBcHAoe1xuICAgICAgYXBwUGF0aCxcbiAgICAgIHJldmVyc2UsXG4gICAgICBwYXRjaERpcixcbiAgICAgIHNob3VsZEV4aXRXaXRoRXJyb3IsXG4gICAgICBzaG91bGRFeGl0V2l0aFdhcm5pbmcsXG4gICAgICBiZXN0RWZmb3J0OiBhcmd2LnBhcnRpYWwsXG4gICAgfSlcbiAgfVxufVxuXG5mdW5jdGlvbiBwcmludEhlbHAoKSB7XG4gIGNvbnNvbGUubG9nKGBcblVzYWdlOlxuXG4gIDEuIFBhdGNoaW5nIHBhY2thZ2VzXG4gID09PT09PT09PT09PT09PT09PT09XG5cbiAgICAke2NoYWxrLmJvbGQoXCJwYXRjaC1wYWNrYWdlXCIpfVxuXG4gIFdpdGhvdXQgYXJndW1lbnRzLCB0aGUgJHtjaGFsay5ib2xkKFxuICAgIFwicGF0Y2gtcGFja2FnZVwiLFxuICApfSBjb21tYW5kIHdpbGwgYXR0ZW1wdCB0byBmaW5kIGFuZCBhcHBseVxuICBwYXRjaCBmaWxlcyB0byB5b3VyIHByb2plY3QuIEl0IGxvb2tzIGZvciBmaWxlcyBuYW1lZCBsaWtlXG5cbiAgICAgLi9wYXRjaGVzLzxwYWNrYWdlLW5hbWU+Kzx2ZXJzaW9uPi5wYXRjaFxuXG4gIE9wdGlvbnM6XG5cbiAgICAke2NoYWxrLmJvbGQoXCItLXBhdGNoLWRpciA8ZGlybmFtZT5cIil9XG5cbiAgICAgIFNwZWNpZnkgdGhlIG5hbWUgZm9yIHRoZSBkaXJlY3RvcnkgaW4gd2hpY2ggdGhlIHBhdGNoIGZpbGVzIGFyZSBsb2NhdGVkLlxuICAgICAgXG4gICAgJHtjaGFsay5ib2xkKFwiLS1lcnJvci1vbi1mYWlsXCIpfVxuICAgIFxuICAgICAgRm9yY2VzIHBhdGNoLXBhY2thZ2UgdG8gZXhpdCB3aXRoIGNvZGUgMSBhZnRlciBmYWlsaW5nLlxuICAgIFxuICAgICAgV2hlbiBydW5uaW5nIGxvY2FsbHkgcGF0Y2gtcGFja2FnZSBhbHdheXMgZXhpdHMgd2l0aCAwIGJ5IGRlZmF1bHQuXG4gICAgICBUaGlzIGhhcHBlbnMgZXZlbiBhZnRlciBmYWlsaW5nIHRvIGFwcGx5IHBhdGNoZXMgYmVjYXVzZSBvdGhlcndpc2UgXG4gICAgICB5YXJuLmxvY2sgYW5kIHBhY2thZ2UuanNvbiBtaWdodCBnZXQgb3V0IG9mIHN5bmMgd2l0aCBub2RlX21vZHVsZXMsXG4gICAgICB3aGljaCBjYW4gYmUgdmVyeSBjb25mdXNpbmcuXG4gICAgICBcbiAgICAgIC0tZXJyb3Itb24tZmFpbCBpcyAke2NoYWxrLmJvbGQoXCJzd2l0Y2hlZCBvblwiKX0gYnkgZGVmYXVsdCBvbiBDSS5cbiAgICAgIFxuICAgICAgU2VlIGh0dHBzOi8vZ2l0aHViLmNvbS9kczMwMC9wYXRjaC1wYWNrYWdlL2lzc3Vlcy84NiBmb3IgYmFja2dyb3VuZC5cbiAgICAgIFxuICAgICR7Y2hhbGsuYm9sZChcIi0tZXJyb3Itb24td2FyblwiKX1cbiAgICBcbiAgICAgIEZvcmNlcyBwYXRjaC1wYWNrYWdlIHRvIGV4aXQgd2l0aCBjb2RlIDEgYWZ0ZXIgd2FybmluZy5cbiAgICAgIFxuICAgICAgU2VlIGh0dHBzOi8vZ2l0aHViLmNvbS9kczMwMC9wYXRjaC1wYWNrYWdlL2lzc3Vlcy8zMTQgZm9yIGJhY2tncm91bmQuXG5cbiAgICAke2NoYWxrLmJvbGQoXCItLXJldmVyc2VcIil9XG4gICAgICAgIFxuICAgICAgVW4tYXBwbGllcyBhbGwgcGF0Y2hlcy5cblxuICAgICAgTm90ZSB0aGF0IHRoaXMgd2lsbCBmYWlsIGlmIHRoZSBwYXRjaGVkIGZpbGVzIGhhdmUgY2hhbmdlZCBzaW5jZSBiZWluZ1xuICAgICAgcGF0Y2hlZC4gSW4gdGhhdCBjYXNlLCB5b3UnbGwgcHJvYmFibHkgbmVlZCB0byByZS1pbnN0YWxsICdub2RlX21vZHVsZXMnLlxuXG4gICAgICBUaGlzIG9wdGlvbiB3YXMgYWRkZWQgdG8gaGVscCBwZW9wbGUgdXNpbmcgQ2lyY2xlQ0kgYXZvaWQgYW4gaXNzdWUgYXJvdW5kIGNhY2hpbmdcbiAgICAgIGFuZCBwYXRjaCBmaWxlIHVwZGF0ZXMgKGh0dHBzOi8vZ2l0aHViLmNvbS9kczMwMC9wYXRjaC1wYWNrYWdlL2lzc3Vlcy8zNyksXG4gICAgICBidXQgbWlnaHQgYmUgdXNlZnVsIGluIG90aGVyIGNvbnRleHRzIHRvby5cbiAgICAgIFxuXG4gIDIuIENyZWF0aW5nIHBhdGNoIGZpbGVzXG4gID09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICAke2NoYWxrLmJvbGQoXCJwYXRjaC1wYWNrYWdlXCIpfSA8cGFja2FnZS1uYW1lPiR7Y2hhbGsuaXRhbGljKFxuICAgIFwiWyA8cGFja2FnZS1uYW1lPl1cIixcbiAgKX1cblxuICBXaGVuIGdpdmVuIHBhY2thZ2UgbmFtZXMgYXMgYXJndW1lbnRzLCBwYXRjaC1wYWNrYWdlIHdpbGwgY3JlYXRlIHBhdGNoIGZpbGVzXG4gIGJhc2VkIG9uIGFueSBjaGFuZ2VzIHlvdSd2ZSBtYWRlIHRvIHRoZSB2ZXJzaW9ucyBpbnN0YWxsZWQgYnkgeWFybi9ucG0uXG5cbiAgT3B0aW9uczpcbiAgXG4gICAgJHtjaGFsay5ib2xkKFwiLS1jcmVhdGUtaXNzdWVcIil9XG4gICAgXG4gICAgICAgRm9yIHBhY2thZ2VzIHdob3NlIHNvdXJjZSBpcyBob3N0ZWQgb24gR2l0SHViIHRoaXMgb3B0aW9uIG9wZW5zIGEgd2ViXG4gICAgICAgYnJvd3NlciB3aXRoIGEgZHJhZnQgaXNzdWUgYmFzZWQgb24geW91ciBkaWZmLlxuXG4gICAgJHtjaGFsay5ib2xkKFwiLS11c2UteWFyblwiKX1cblxuICAgICAgICBCeSBkZWZhdWx0LCBwYXRjaC1wYWNrYWdlIGNoZWNrcyB3aGV0aGVyIHlvdSB1c2UgbnBtLCB5YXJuIG9yIGJ1biBiYXNlZCBvblxuICAgICAgICB3aGljaCBsb2NrZmlsZSB5b3UgaGF2ZS4gSWYgeW91IGhhdmUgbXVsdGlwbGUgbG9ja2ZpbGVzLCBpdCB1c2VzIG5wbSBieVxuICAgICAgICBkZWZhdWx0IChpbiBjYXNlcyB3aGVyZSBucG0gaXMgbm90IGF2YWlsYWJsZSwgaXQgd2lsbCByZXNvcnQgdG8geWFybikuIFNldCBcbiAgICAgICAgdGhpcyBvcHRpb24gdG8gb3ZlcnJpZGUgdGhhdCBkZWZhdWx0IGFuZCBhbHdheXMgdXNlIHlhcm4uXG4gICAgICAgIFxuICAgICR7Y2hhbGsuYm9sZChcIi0tdXNlLWJ1blwiKX1cbiAgICBcbiAgICAgICAgU2ltaWxhciB0byAtLXVzZS15YXJuLCBidXQgZm9yIGJ1bi4gSWYgYm90aCAtLXVzZS15YXJuIGFuZCAtLXVzZS1idW4gYXJlXG4gICAgICAgIHNwZWNpZmllZCwgLS11c2UteWFybiB0YWtlcyBwcmVjZWRlbmNlLlxuXG4gICAgJHtjaGFsay5ib2xkKFwiLS1leGNsdWRlIDxyZWdleHA+XCIpfVxuXG4gICAgICAgIElnbm9yZSBwYXRocyBtYXRjaGluZyB0aGUgcmVnZXhwIHdoZW4gY3JlYXRpbmcgcGF0Y2ggZmlsZXMuXG4gICAgICAgIFBhdGhzIGFyZSByZWxhdGl2ZSB0byB0aGUgcm9vdCBkaXIgb2YgdGhlIHBhY2thZ2UgdG8gYmUgcGF0Y2hlZC5cblxuICAgICAgICBEZWZhdWx0OiAncGFja2FnZVxcXFwuanNvbiQnXG5cbiAgICAke2NoYWxrLmJvbGQoXCItLWluY2x1ZGUgPHJlZ2V4cD5cIil9XG5cbiAgICAgICAgT25seSBjb25zaWRlciBwYXRocyBtYXRjaGluZyB0aGUgcmVnZXhwIHdoZW4gY3JlYXRpbmcgcGF0Y2ggZmlsZXMuXG4gICAgICAgIFBhdGhzIGFyZSByZWxhdGl2ZSB0byB0aGUgcm9vdCBkaXIgb2YgdGhlIHBhY2thZ2UgdG8gYmUgcGF0Y2hlZC5cblxuICAgICAgICBEZWZhdWx0ICcuKidcblxuICAgICR7Y2hhbGsuYm9sZChcIi0tY2FzZS1zZW5zaXRpdmUtcGF0aC1maWx0ZXJpbmdcIil9XG5cbiAgICAgICAgTWFrZSByZWdleHBzIHVzZWQgaW4gLS1pbmNsdWRlIG9yIC0tZXhjbHVkZSBmaWx0ZXJzIGNhc2Utc2Vuc2l0aXZlLlxuICAgIFxuICAgICR7Y2hhbGsuYm9sZChcIi0tcGF0Y2gtZGlyXCIpfVxuXG4gICAgICAgIFNwZWNpZnkgdGhlIG5hbWUgZm9yIHRoZSBkaXJlY3RvcnkgaW4gd2hpY2ggdG8gcHV0IHRoZSBwYXRjaCBmaWxlcy5cbmApXG59XG4iXX0=