import { existsSync } from "fs";
import path from "path";

type PackageSetting = string | { source?: unknown };

type PackageSettingsReader = {
  getGlobalSettings: () => { packages?: PackageSetting[] };
  getProjectSettings: () => { packages?: PackageSetting[] };
};

export const BUNDLED_PI_PACKAGE_NAMES = [
  "pi-subagents",
  "pi-mcp-adapter",
  "pi-web-access",
  "@juicesharp/rpiv-ask-user-question",
  "@narumitw/pi-goal",
] as const;

function getPackageSource(setting: PackageSetting): string | undefined {
  const source = typeof setting === "string" ? setting : setting.source;
  return typeof source === "string" ? source.trim() : undefined;
}

function isConfiguredPackage(setting: PackageSetting, packageName: string): boolean {
  const source = getPackageSource(setting);
  return source === `npm:${packageName}` || source?.startsWith(`npm:${packageName}@`) === true;
}

export function hasConfiguredPiPackage(
  settings: PackageSettingsReader,
  packageName: string,
): boolean {
  return [settings.getGlobalSettings(), settings.getProjectSettings()]
    .some((scope) => scope.packages?.some((setting) => isConfiguredPackage(setting, packageName)) ?? false);
}

export function resolveBundledPiPackageRoot(
  packageName: string,
  searchRoots: string[] = [__dirname, process.cwd()],
): string | undefined {
  for (const searchRoot of searchRoots) {
    let directory = path.resolve(searchRoot);
    while (true) {
      const packageRoot = path.join(directory, "node_modules", ...packageName.split("/"));
      if (existsSync(path.join(packageRoot, "package.json"))) return packageRoot;

      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return undefined;
}

export function getBundledPiPackageResourceLoaderOptions(
  settings: PackageSettingsReader,
  searchRoots?: string[],
): { additionalExtensionPaths?: string[] } {
  const packageRoots = BUNDLED_PI_PACKAGE_NAMES.flatMap((packageName) => {
    if (hasConfiguredPiPackage(settings, packageName)) return [];
    const packageRoot = resolveBundledPiPackageRoot(packageName, searchRoots);
    return packageRoot ? [packageRoot] : [];
  });

  return packageRoots.length > 0 ? { additionalExtensionPaths: packageRoots } : {};
}
