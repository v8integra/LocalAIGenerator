const fs = require("fs");
const path = require("path");

const assets = [
  ["src/renderer/index.html", "dist/renderer/index.html"],
  ["src/renderer/styles.css", "dist/renderer/styles.css"],
  ["src/main/hardware/get-gpu-info.ps1", "dist/main/hardware/get-gpu-info.ps1"],
  ["src/main/registry/models.json", "dist/main/registry/models.json"],
  ["src/main/audio/musicgen_server.py", "dist/main/audio/musicgen_server.py"]
];

for (const [src, dest] of assets) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}
