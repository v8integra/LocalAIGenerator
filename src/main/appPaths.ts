import { app } from "electron";
import * as path from "path";

export interface AppPaths {
  userData: string;
  modelsDir: string;
  venvsDir: string;
  enginesDir: string;
  tempDir: string;
  documentsOutputDir: string;
  settingsPath: string;
}

/** Central directory layout under Electron's per-user app data folder (spec §4.5). */
export function getAppPaths(): AppPaths {
  const userData = app.getPath("userData");
  return {
    userData,
    modelsDir: path.join(userData, "models"),
    venvsDir: path.join(userData, "venvs"),
    enginesDir: path.join(userData, "engines"),
    tempDir: path.join(userData, "temp"),
    documentsOutputDir: path.join(app.getPath("documents"), "LocalAIStudio"),
    settingsPath: path.join(userData, "settings.json")
  };
}
