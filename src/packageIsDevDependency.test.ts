import { packageIsDevDependency } from "./packageIsDevDependency.js"
import { join } from "./path.js"
import { normalize } from "path"
import { getPackageDetailsFromPatchFilename } from "./PackageDetails.js"
import { existsSync } from "fs"

const appPath = normalize(join(__dirname, "../"))

describe(packageIsDevDependency, () => {
  it("returns true if package is a dev dependency", () => {
    expect(
      packageIsDevDependency({
        appPath,
        patchDetails: getPackageDetailsFromPatchFilename(
          "typescript+3.0.1.patch",
        )!,
      }),
    ).toBe(true)
  })
  it("returns false if package is not a dev dependency", () => {
    expect(
      packageIsDevDependency({
        appPath,
        patchDetails: getPackageDetailsFromPatchFilename("chalk+3.0.1.patch")!,
      }),
    ).toBe(false)
  })
  it("returns false if package is a transitive dependency of a dev dependency", () => {
    expect(existsSync(join(appPath, "node_modules/cosmiconfig"))).toBe(true)
    expect(
      packageIsDevDependency({
        appPath,
        patchDetails: getPackageDetailsFromPatchFilename(
          // cosmiconfig is a transitive dep of lint-staged
          "cosmiconfig+3.0.1.patch",
        )!,
      }),
    ).toBe(false)
  })
})
