import fsSync from "fs";
import path from "path";

/**
 * Stock Windows Node MSI global-bin helpers for cliRuntime.ts.
 *
 * Extracted so #12563 does not grow `cliRuntime.ts` (frozen file-size budget).
 * `validateEnvPath` is injected to reuse the same Program Files allowlist
 * already used by `getExpectedParentPaths()` — no circular import.
 *
 * Always uses `path.win32` so candidate strings stay Windows-shaped even when
 * unit tests mock `process.platform` on a POSIX runner.
 */

type ValidateEnvPath = (value: string | undefined, allowedParents: string[]) => string;

const winPath = path.win32;
const PROGRAM_FILES_PARENTS = ["C:\\Program Files", "C:\\Program Files (x86)"];

/**
 * Directories where `npm install -g` drops `.cmd` shims on a stock Windows Node
 * MSI (`%ProgramFiles%\nodejs`, plus the x86 twin). Already trusted for
 * containment, but historically never enumerated as known install paths.
 */
export const getWindowsSystemNodeBinDirs = (validateEnvPath: ValidateEnvPath): string[] => {
  if (process.platform !== "win32") return [];

  const roots = [
    validateEnvPath(process.env.ProgramFiles, PROGRAM_FILES_PARENTS),
    validateEnvPath(process.env["ProgramFiles(x86)"], PROGRAM_FILES_PARENTS),
  ];

  const dirs: string[] = [];
  for (const root of roots) {
    if (!root) continue;
    const nodeDir = winPath.join(root, "nodejs");
    const normalized = winPath.normalize(nodeDir).toLowerCase();
    if (!dirs.some((existing) => winPath.normalize(existing).toLowerCase() === normalized)) {
      dirs.push(nodeDir);
    }
  }
  return dirs;
};

const appendWindowsSystemNodeShims = (
  paths: string[],
  winName: string,
  npmPrefix: string,
  nvmNodePath: string | null,
  validateEnvPath: ValidateEnvPath
): void => {
  for (const systemNodeDir of getWindowsSystemNodeBinDirs(validateEnvPath)) {
    const systemPath = winPath.join(systemNodeDir, winName);
    const alreadyListed =
      (npmPrefix &&
        winPath.normalize(systemPath) === winPath.normalize(winPath.join(npmPrefix, winName))) ||
      (nvmNodePath &&
        winPath.normalize(systemPath) === winPath.normalize(winPath.join(nvmNodePath, winName)));
    if (!alreadyListed) paths.push(systemPath);
  }
};

/** npm-prefix / `%APPDATA%\npm` / nvm / `%ProgramFiles%\nodejs` `.cmd` candidates. */
export const appendWindowsKnownBinPaths = (
  paths: string[],
  winName: string,
  npmPrefix: string,
  appData: string,
  nvmNodePath: string | null,
  validateEnvPath: ValidateEnvPath
): void => {
  if (npmPrefix) paths.push(winPath.join(npmPrefix, winName));
  if (appData) {
    const appDataPath = winPath.join(appData, "npm", winName);
    if (
      !npmPrefix ||
      winPath.normalize(appDataPath) !== winPath.normalize(winPath.join(npmPrefix, winName))
    ) {
      paths.push(appDataPath);
    }
  }
  if (nvmNodePath) paths.push(winPath.join(nvmNodePath, winName));
  appendWindowsSystemNodeShims(paths, winName, npmPrefix, nvmNodePath, validateEnvPath);
};

/**
 * #12563: prepend existing `%ProgramFiles%\nodejs` dirs so Electron/`where.exe`
 * can see npm-global `.cmd` shims even when the GUI PATH omitted them.
 */
export const mergeWindowsLookupPath = (
  extraPaths: string[],
  enrichedPath: string,
  validateEnvPath: ValidateEnvPath
): string => {
  const systemNodeDirs = getWindowsSystemNodeBinDirs(validateEnvPath).filter((dir) =>
    fsSync.existsSync(dir)
  );
  return [...extraPaths, ...systemNodeDirs, enrichedPath].filter(Boolean).join(path.delimiter);
};
