#!/usr/bin/env node
import { spawn, exec } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const port = process.env.PORT || 3100;
const url = `http://localhost:${port}`;

function openBrowser(targetUrl) {
  const platform = process.platform;
  let cmd = "";
  if (platform === "darwin") {
    cmd = `open "${targetUrl}"`;
  } else if (platform === "win32") {
    cmd = `start "" "${targetUrl}"`;
  } else {
    cmd = `xdg-open "${targetUrl}"`;
  }
  exec(cmd, (err) => {
    if (err) {
      console.warn(`Could not open browser automatically: ${err.message}`);
    }
  });
}

console.log(`\n🚀 Starting Open Dot on ${url}...`);

let opened = false;
function triggerOpen() {
  if (opened) return;
  opened = true;
  console.log(`✨ Open Dot is ready! Opening ${url} in your browser...\n`);
  openBrowser(url);
}

// Poll the local server until it responds, then launch the browser
const start = Date.now();
const interval = setInterval(() => {
  const req = http.get(url, (res) => {
    clearInterval(interval);
    triggerOpen();
    res.resume();
  });

  req.on("error", () => {
    // If Next.js takes longer than 15s (e.g. slow initial compilation), open anyway
    if (Date.now() - start > 15000) {
      clearInterval(interval);
      triggerOpen();
    }
  });

  req.setTimeout(1000, () => {
    req.destroy();
  });
}, 400);

const devProcess = spawn("pnpm", ["run", "dev"], {
  cwd: rootDir,
  stdio: "inherit",
  shell: true,
});

devProcess.on("exit", (code) => {
  clearInterval(interval);
  process.exit(code ?? 0);
});

process.on("SIGINT", () => {
  clearInterval(interval);
  devProcess.kill("SIGINT");
  process.exit(0);
});

process.on("SIGTERM", () => {
  clearInterval(interval);
  devProcess.kill("SIGTERM");
  process.exit(0);
});
