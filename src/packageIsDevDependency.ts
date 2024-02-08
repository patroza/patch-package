import { PatchedPackageDetails } from "./PackageDetails.js"
import { join } from "./path.js"
import { existsSync } from "fs"

export function packageIsDevDependency({
  appPath,
  patchDetails,
}: {
  appPath: string
  patchDetails: PatchedPackageDetails
}) {
  const packageJsonPath = join(appPath, "package.json")
  if (!existsSync(packageJsonPath)) {
    return false
  }
  const { devDependencies } = require(packageJsonPath)
  return Boolean(
    devDependencies && devDependencies[patchDetails.packageNames[0]],
  )
}
