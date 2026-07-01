const { app, BrowserWindow, shell, dialog } = require("electron");
const path = require("path");
const http = require("http");
let mainWindow;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log("⚠️ Another instance is already running. Quitting this one.");
  app.quit();
  process.exit(0);
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function startBackend() {
  if (!app.isPackaged) {
    process.chdir(__dirname);
  }
  try {
    require("./main.js");
  } catch (err) {
    console.error("❌ Backend crash:", err);
    // Don't call dialog.showErrorBox here — on Windows the app may not be
    // fully ready yet when startBackend() is called, which causes:
    // "TypeError: Error processing argument at index 1, conversion failure from undefined"
    // Instead we throw and let the caller handle it after the window is ready.
    throw err;
  }
}

function showErrorInWindow(err) {
  if (!mainWindow) return;
  const safeMessage = (err.stack || err.message || String(err))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  mainWindow.loadURL(
    "data:text/html," +
    encodeURIComponent(`
      <html>
        <body style="font-family:-apple-system,sans-serif;padding:24px;background:#fff5f5;color:#7f1d1d;">
          <h2>AI Notetaker failed to start its backend</h2>
          <pre style="white-space:pre-wrap;font-size:13px;background:#fff;border:1px solid #fca5a5;border-radius:8px;padding:16px;">${safeMessage}</pre>
        </body>
      </html>
    `)
  );
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 800,
    minWidth: 700,
    minHeight: 600,
    title: "AI Notetaker",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    backgroundColor: "#f5f7fa",
  });

  let attempts = 0;
  const maxAttempts = 15;

  function tryLoad() {
    attempts++;
    console.log(`Attempting to connect to backend (attempt ${attempts})...`);
    const req = http.get("http://127.0.0.1:5001", (res) => {
      console.log("✅ Backend is ready! Loading app...");
      res.resume();
      req.setTimeout(0);
      mainWindow.loadURL("http://127.0.0.1:5001");
    });
    req.setTimeout(2000, () => {
      console.log("⏱ Connection attempt timed out.");
      req.destroy();
    });
    req.on("error", (err) => {
      console.log(`Connection failed: ${err.message}`);
      if (attempts < maxAttempts) {
        console.log(`Backend not ready yet, retrying in 1s...`);
        setTimeout(tryLoad, 1000);
      } else {
        console.error("❌ Backend failed to start after attempts.");
        showErrorInWindow(new Error("Backend never responded on port 5001. Last error: " + err.message));
      }
    });
    req.end();
  }

  setTimeout(tryLoad, 800);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  let backendError = null;
  try {
    startBackend();
  } catch (err) {
    console.error("❌ Backend failed to start:", err);
    backendError = err;
    // Now the window exists so we can safely show the error
    if (mainWindow) {
      showErrorInWindow(err);
      // Also try dialog now that app is ready
      try {
        dialog.showErrorBox("AI Notetaker — Backend Error", err.stack || err.message);
      } catch (e) {
        console.error("Could not show error dialog:", e.message);
      }
    }
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});