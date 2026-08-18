/** Shared IPC channel names — the one source of truth for both the main and preload sides. */
export const IpcChannels = {
  GetHardwareProfile: "hardware:get",
  GetModelSelection: "models:getSelection",
  InstallModel: "models:install",
  /** Main -> renderer push, sent while an install triggered via InstallModel is in progress. */
  InstallProgress: "models:installProgress",
  SetDefaultModel: "models:setDefault",
  Generate: "generate:run",
  SaveOutput: "save:showDialog"
} as const;
