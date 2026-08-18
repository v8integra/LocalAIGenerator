import { contextBridge, ipcRenderer } from "electron";

/**
 * Electron's sandboxed preload context (webPreferences.sandbox defaults to
 * true) can only require its own file — no relative imports of other
 * project modules — so these are duplicated from ipc/channels.ts rather
 * than imported. Keep the two in sync if a channel name changes.
 */
const IpcChannels = {
  GetHardwareProfile: "hardware:get",
  GetModelSelection: "models:getSelection",
  InstallModel: "models:install",
  InstallProgress: "models:installProgress",
  SetDefaultModel: "models:setDefault",
  Generate: "generate:run",
  SaveOutput: "save:showDialog"
} as const;

/**
 * The renderer's only window into the main process (spec §3): a scoped
 * API surface, not raw ipcRenderer access, so the renderer can never spawn
 * processes or touch the filesystem directly.
 */
contextBridge.exposeInMainWorld("api", {
  getHardwareProfile: () => ipcRenderer.invoke(IpcChannels.GetHardwareProfile),

  getModelSelection: (taskType: string) => ipcRenderer.invoke(IpcChannels.GetModelSelection, taskType),

  installModel: (modelId: string) => ipcRenderer.invoke(IpcChannels.InstallModel, modelId),

  setDefaultModel: (taskType: string, modelId: string) =>
    ipcRenderer.invoke(IpcChannels.SetDefaultModel, taskType, modelId),

  onInstallProgress: (callback: (payload: { modelId: string; event: unknown }) => void) => {
    const listener = (_event: unknown, payload: { modelId: string; event: unknown }) => callback(payload);
    ipcRenderer.on(IpcChannels.InstallProgress, listener);
    return () => ipcRenderer.removeListener(IpcChannels.InstallProgress, listener);
  },

  generate: (taskType: string, modelId: string, inputs: unknown) =>
    ipcRenderer.invoke(IpcChannels.Generate, taskType, modelId, inputs),

  saveOutput: (sourcePath: string, taskType: string) => ipcRenderer.invoke(IpcChannels.SaveOutput, sourcePath, taskType)
});
