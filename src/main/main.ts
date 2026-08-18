import { app, BrowserWindow } from "electron";
import * as path from "path";
import { getAppPaths } from "./appPaths";
import { detectHardware } from "./hardware/detectHardware";
import { registerIpcHandlers } from "./ipc/registerIpc";
import { Orchestrator } from "./orchestrator";
import { loadBundledRegistry } from "./registry/loadRegistry";
import { SettingsStore } from "./settings";
import { resetTempDir } from "./tempCleanup";

// Pins app.getPath("userData") to %APPDATA%\local-ai-studio regardless of how
// the app is packaged (electron-builder's productName could otherwise change
// Electron's default app name away from package.json's "name") — this is the
// folder tens of GB of already-downloaded models/engines live in, so it must
// never silently change out from under a packaged build.
app.setName("local-ai-studio");

let mainWindow: BrowserWindow | null = null;
let orchestrator: Orchestrator | null = null;

function getMainWindow(): BrowserWindow {
  if (!mainWindow) throw new Error("No main window is open");
  return mainWindow;
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function initialize(): Promise<void> {
  const paths = getAppPaths();

  // Crash-recovery cleanup happens before anything else touches the temp
  // dir (spec §4.5).
  await resetTempDir(paths.tempDir);

  // Checks free space on the drive via paths.userData, which Electron
  // guarantees exists — modelsDir itself is created lazily on first install.
  const [profile, registry, settings] = await Promise.all([
    detectHardware(paths.userData),
    loadBundledRegistry(),
    SettingsStore.load(paths.settingsPath)
  ]);

  orchestrator = new Orchestrator({ paths, profile, registry, settings });

  createMainWindow();
  registerIpcHandlers(orchestrator, getMainWindow, paths.documentsOutputDir);
}

app.whenReady().then(initialize);

app.on("window-all-closed", async () => {
  await orchestrator?.shutdown();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async () => {
  await orchestrator?.shutdown();
  await resetTempDir(getAppPaths().tempDir);
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});
