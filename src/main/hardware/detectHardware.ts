import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

const statfs = promisify(fs.statfs);

export type GpuVendor = "nvidia" | "amd" | "intel" | "none" | "unknown";

export interface HardwareProfile {
  os: "windows";
  os_version: string;
  gpu_vendor: GpuVendor;
  gpu_model: string | null;
  vram_gb: number;
  ram_gb: number;
  free_disk_gb: number;
}

interface GpuCandidate {
  name: string;
  vendor: GpuVendor;
  vramBytes: number | null;
}

interface RawGpuEntry {
  name: string;
  vendor: string;
  pnpDeviceId: string;
  adapterRamBytes: number;
  registryVramBytes: number | null;
}

const VENDOR_RANK: Record<GpuVendor, number> = {
  nvidia: 3,
  amd: 2,
  intel: 1,
  unknown: 0,
  none: -1
};

function normalizeVendor(raw: string): GpuVendor {
  const v = raw.toLowerCase();
  if (v.includes("nvidia")) return "nvidia";
  if (v.includes("advanced micro devices") || v.includes("amd") || v.includes("ati")) return "amd";
  if (v.includes("intel")) return "intel";
  return "unknown";
}

async function queryGpuCandidates(): Promise<GpuCandidate[]> {
  const scriptPath = path.join(__dirname, "get-gpu-info.ps1");
  const stdout = await runPowerShellScript(scriptPath);

  let raw: RawGpuEntry[];
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error(`Failed to parse GPU info from PowerShell output: ${stdout}`);
  }

  return raw
    .map((entry) => ({
      name: entry.name,
      vendor: normalizeVendor(entry.vendor ?? ""),
      // Registry VRAM is accurate; AdapterRAM is a known-unreliable fallback
      // (WMI misreports it for many GPUs, typically capping near 4GB).
      vramBytes: entry.registryVramBytes ?? entry.adapterRamBytes ?? null
    }))
    .filter((c) => c.vendor !== "unknown");
}

function runPowerShellScript(scriptPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      { timeout: 10000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`PowerShell GPU query failed: ${stderr || error.message}`));
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}

async function queryNvidiaSmi(): Promise<GpuCandidate | null> {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
      { timeout: 5000 },
      (error, stdout) => {
        if (error) {
          // nvidia-smi not installed, no NVIDIA GPU, or it timed out — all
          // non-fatal, we just fall back to the WMI/registry candidates.
          resolve(null);
          return;
        }
        const firstLine = stdout.trim().split("\n")[0];
        const [namePart, vramMbPart] = firstLine.split(",").map((s) => s.trim());
        const vramMb = Number(vramMbPart);
        if (!namePart || Number.isNaN(vramMb)) {
          resolve(null);
          return;
        }
        resolve({ name: namePart, vendor: "nvidia", vramBytes: vramMb * 1024 * 1024 });
      }
    );
  });
}

async function detectPrimaryGpu(): Promise<{ vendor: GpuVendor; model: string | null; vramGb: number }> {
  const [candidates, nvidiaSmiResult] = await Promise.all([queryGpuCandidates(), queryNvidiaSmi()]);

  // nvidia-smi is the most authoritative source when present (spec §4.1)
  // — it replaces the matching WMI candidate's VRAM/name rather than being
  // added as a duplicate entry.
  let merged = candidates;
  if (nvidiaSmiResult) {
    const matchIndex = candidates.findIndex((c) => c.vendor === "nvidia");
    if (matchIndex >= 0) {
      merged = [...candidates];
      merged[matchIndex] = nvidiaSmiResult;
    } else {
      merged = [...candidates, nvidiaSmiResult];
    }
  }

  if (merged.length === 0) {
    return { vendor: "none", model: null, vramGb: 0 };
  }

  const best = [...merged].sort((a, b) => {
    const rankDiff = VENDOR_RANK[b.vendor] - VENDOR_RANK[a.vendor];
    if (rankDiff !== 0) return rankDiff;
    return (b.vramBytes ?? 0) - (a.vramBytes ?? 0);
  })[0];

  return {
    vendor: best.vendor,
    model: best.name,
    vramGb: Math.round((best.vramBytes ?? 0) / 1024 ** 3)
  };
}

function getRamGb(): number {
  return Math.round(os.totalmem() / 1024 ** 3);
}

async function getFreeDiskGb(targetPath: string): Promise<number> {
  const stats = await statfs(targetPath);
  return Math.round((stats.bavail * stats.bsize) / 1024 ** 3);
}

/**
 * Detects the current machine's hardware profile (spec §4.1).
 * @param targetPath Path on the drive to check free space for — pass
 *   `app.getPath("userData")` once wired into the Electron app lifecycle.
 *   Defaults to the current working directory for standalone use.
 */
export async function detectHardware(targetPath: string = process.cwd()): Promise<HardwareProfile> {
  if (os.platform() !== "win32") {
    throw new Error(
      `Hardware detection is not yet implemented for platform "${os.platform()}" (Windows-only in v1, see spec §9)`
    );
  }

  const [gpu, ramGb, freeDiskGb] = await Promise.all([
    detectPrimaryGpu(),
    Promise.resolve(getRamGb()),
    getFreeDiskGb(targetPath)
  ]);

  return {
    os: "windows",
    os_version: os.release(),
    gpu_vendor: gpu.vendor,
    gpu_model: gpu.model,
    vram_gb: gpu.vramGb,
    ram_gb: ramGb,
    free_disk_gb: freeDiskGb
  };
}

if (require.main === module) {
  detectHardware()
    .then((profile) => {
      console.log(JSON.stringify(profile, null, 2));
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
