import { BrowserWindow, dialog, ipcMain } from "electron";
import * as fs from "fs/promises";
import * as path from "path";
import { TextToMusicInputs } from "../audio/generateMusic";
import { ImageToImageInputs, TextToImageInputs, TextToVideoInputs } from "../comfyui/generate";
import { Orchestrator } from "../orchestrator";
import { TaskType } from "../registry/types";
import { IpcChannels } from "./channels";

export interface SaveOutputResult {
  saved: boolean;
  path?: string;
  error?: string;
}

export interface InstallModelResult {
  success: boolean;
  error?: string;
}

/**
 * Wires ipcMain.handle for every renderer-facing operation (spec §3: the
 * renderer never touches process/model logic directly, only ipcRenderer).
 * getMainWindow is a function rather than a fixed reference so progress
 * events keep reaching whichever window is currently open.
 */
export function registerIpcHandlers(
  orchestrator: Orchestrator,
  getMainWindow: () => BrowserWindow,
  documentsOutputDir: string
): void {
  ipcMain.handle(IpcChannels.GetHardwareProfile, () => orchestrator.getHardwareProfile());

  ipcMain.handle(IpcChannels.GetModelSelection, (_event, taskType: TaskType) =>
    orchestrator.getModelSelection(taskType)
  );

  ipcMain.handle(IpcChannels.InstallModel, async (_event, modelId: string): Promise<InstallModelResult> => {
    // Caught here rather than left to reject: a rejected ipcMain.handle
    // promise arrives in the renderer wrapped in Electron's own "Error
    // invoking remote method..." text, which would leak past our own
    // plain-language error message (spec §7).
    try {
      await orchestrator.installModelById(modelId, (progressEvent) => {
        getMainWindow().webContents.send(IpcChannels.InstallProgress, { modelId, event: progressEvent });
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle(IpcChannels.SetDefaultModel, (_event, taskType: TaskType, modelId: string) =>
    orchestrator.setDefaultModel(taskType, modelId)
  );

  ipcMain.handle(
    IpcChannels.Generate,
    (
      _event,
      taskType: TaskType,
      modelId: string,
      inputs: TextToImageInputs & TextToVideoInputs & TextToMusicInputs & ImageToImageInputs
    ) => {
      if (taskType === "text-to-image") return orchestrator.generateImage(modelId, inputs);
      if (taskType === "text-to-video") return orchestrator.generateVideo(modelId, inputs);
      if (taskType === "text-to-music") return orchestrator.generateMusic(modelId, inputs);
      if (taskType === "image-to-image") return orchestrator.generateImageToImage(modelId, inputs);
      return { status: "error", error: `Task type "${taskType}" is not implemented yet` };
    }
  );

  ipcMain.handle(
    IpcChannels.SaveOutput,
    async (_event, sourcePath: string, taskType: TaskType): Promise<SaveOutputResult> => {
      try {
        const suggestedName = path.basename(sourcePath);
        const defaultDir = path.join(documentsOutputDir, taskType);
        await fs.mkdir(defaultDir, { recursive: true });

        const result = await dialog.showSaveDialog(getMainWindow(), {
          defaultPath: path.join(defaultDir, suggestedName)
        });

        if (result.canceled || !result.filePath) {
          return { saved: false };
        }

        await fs.copyFile(sourcePath, result.filePath);
        return { saved: true, path: result.filePath };
      } catch (err) {
        return { saved: false, error: (err as Error).message };
      }
    }
  );
}
