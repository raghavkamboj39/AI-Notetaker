const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");
const AdmZip = require("adm-zip");
const { app: electronApp } = require("electron");

const dotenvPath = electronApp.isPackaged
  ? path.join(process.resourcesPath, ".env")
  : path.join(__dirname, ".env");
require("dotenv").config({ path: dotenvPath });

const { transcribeAudioFile, resolveFfmpegPath } = require("./transcribe");
const { generateSmartNotes, translateNotes, translateTranscript } = require("./notesengine");
const storage = require("./storage");
const loopReader = require("./loop-reader");
const fileParser = require("./fileparser");

const app = express();
const PORT = 5001;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ── Upload setup ──
const UPLOAD_DIR = path.join(electronApp.getPath("userData"), "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
});

// ── Progress tracking via SSE ──
const progressClients = {};

function sendProgress(jobId, percent, message) {
  const clients = progressClients[jobId];
  if (!clients) return;
  const payload = JSON.stringify({ percent, message });
  clients.forEach(res => {
    try { res.write(`data: ${payload}\n\n`); } catch (e) {}
  });
}

function endProgress(jobId) {
  const clients = progressClients[jobId];
  if (!clients) return;
  clients.forEach(res => {
    try {
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (e) {}
  });
  delete progressClients[jobId];
}

app.get("/progress/:jobId", (req, res) => {
  const { jobId } = req.params;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  if (!progressClients[jobId]) progressClients[jobId] = [];
  progressClients[jobId].push(res);
  req.on("close", () => {
    if (progressClients[jobId]) {
      progressClients[jobId] = progressClients[jobId].filter(c => c !== res);
    }
  });
});

// ── ffmpeg path (shared resolver, asar-safe — see transcribe.js) ──
// We intentionally reuse transcribe.js's resolveFfmpegPath() instead of
// duplicating ffmpeg path logic here. The old duplicate version in this
// file called require("@ffmpeg-installer/ffmpeg") directly, which throws
// immediately inside a packaged asar app before any fallback path-fixing
// code can run — that was the root cause of the "Could not find ffmpeg
// executable" backend crash on macOS arm64 builds.
let ffmpegPath;
try {
  ffmpegPath = resolveFfmpegPath();
  console.log("[ffmpeg] Path resolved:", ffmpegPath);
} catch (err) {
  console.error("[ffmpeg] Failed to resolve path:", err.message);
  ffmpegPath = null;
}

function convertToWav(inputPath) {
  if (!ffmpegPath) throw new Error("ffmpeg is not available on this system.");
  const outputPath = inputPath + "_converted.wav";
  execSync(`"${ffmpegPath}" -i "${inputPath}" -acodec pcm_s16le -ac 1 -ar 16000 -f wav "${outputPath}" -y`, { stdio: "ignore" });
  return outputPath;
}

// ── POST /upload ──
app.post("/upload", upload.single("audio"), async (req, res) => {
  const startTime = Date.now();
  const jobId = req.body.jobId || Date.now().toString();
  const promptInstruction = req.body.promptInstruction || "";
  const outputLanguage = req.body.outputLanguage || "auto";
  let wavPath = null;
  let convertedPath = null;

  try {
    if (!req.file) {
      return res.status(400).json({ status: "Error", error: "No audio file uploaded." });
    }

    const originalName = req.file.originalname;
    const isTextFile = /\.(txt|log)$/i.test(originalName);
    const isLoopFile = /\.loop$/i.test(originalName);
    const isZipFile = /\.zip$/i.test(originalName);
    const isDocumentFile = fileParser.isSupportedDocument(originalName);

    let transcription;

    // ── document file (.pdf, .docx, .pptx, .xlsx) ──
    if (isDocumentFile) {
      sendProgress(jobId, 15, "Reading document...");
      let rawText;
      try {
        rawText = await fileParser.extractTextFromDocument(req.file.path, originalName);
      } catch (parseErr) {
        console.error("[/upload] Document parse error:", parseErr.message);
        throw new Error(`Could not read this file: ${parseErr.message}`);
      }

      if (!rawText || !rawText.trim()) {
        throw new Error("No readable text could be extracted from this document. It may be empty, image-based, or scanned without OCR.");
      }

      const words = rawText.split(/\s+/).filter(Boolean).map(word => ({
        word, speaker: "1", startTime: "0.00s", duration: "0.00s",
      }));

      transcription = {
        status: "Success",
        fullText: rawText,
        wordTimestamps: words,
        detectedLanguage: null,
        partialFailure: false,
        failedChunks: [],
      };

      sendProgress(jobId, 50, "Document read. Generating notes...");
    }

    // ── .loop file uploaded directly ──
    else if (isLoopFile) {
      sendProgress(jobId, 20, "Reading Loop file...");
      const text = loopReader.extractTextFromLoopFile(req.file.path, originalName);
      if (!text || text.includes("Could not extract text")) {
        throw new Error("Could not extract text from this Loop file. Try using the Loop tab to connect OneDrive instead.");
      }
      const words = text.split(/\s+/).filter(Boolean).map(word => ({
        word, speaker: "1", startTime: "0.00s", duration: "0.00s",
      }));
      transcription = {
        status: "Success",
        fullText: text,
        wordTimestamps: words,
        detectedLanguage: null,
        partialFailure: false,
        failedChunks: [],
      };
      sendProgress(jobId, 50, "Loop file read. Generating notes...");
    }

    // ── .zip file containing .loop files ──
    else if (isZipFile) {
      sendProgress(jobId, 10, "Opening zip file...");
      const zip = new AdmZip(req.file.path);
      const loopEntries = zip.getEntries().filter(e => e.entryName.endsWith(".loop"));

      if (loopEntries.length === 0) {
        throw new Error("No .loop files found inside this zip. Please upload a zip exported from Microsoft Loop / OneDrive.");
      }

      sendProgress(jobId, 20, `Found ${loopEntries.length} Loop file(s). Extracting...`);

      const allTexts = [];
      for (const entry of loopEntries) {
        const buffer = entry.getData();
        const fileName = path.basename(entry.entryName);
        const text = loopReader.extractTextFromLoopBuffer(buffer, fileName);
        if (text && !text.includes("Could not extract text")) {
          allTexts.push(`## ${fileName}\n\n${text}`);
        }
      }

      if (allTexts.length === 0) {
        throw new Error("Could not extract readable text from any .loop files in this zip.");
      }

      const combinedText = allTexts.join("\n\n---\n\n");
      const words = combinedText.split(/\s+/).filter(Boolean).map(word => ({
        word, speaker: "1", startTime: "0.00s", duration: "0.00s",
      }));

      transcription = {
        status: "Success",
        fullText: combinedText,
        wordTimestamps: words,
        detectedLanguage: null,
        partialFailure: false,
        failedChunks: [],
      };

      sendProgress(jobId, 50, `Extracted ${allTexts.length} Loop file(s). Generating notes...`);
    }

    // ── plain text file ──
    else if (isTextFile) {
      sendProgress(jobId, 20, "Reading text file...");
      const rawText = fs.readFileSync(req.file.path, "utf8").trim();
      if (!rawText) throw new Error("The uploaded text file is empty.");

      const words = rawText.split(/\s+/).filter(Boolean);
      const wordTimestamps = words.map(word => ({
        word, speaker: "1", startTime: "0.00s", duration: "0.00s",
      }));

      transcription = {
        status: "Success",
        fullText: rawText,
        wordTimestamps,
        detectedLanguage: null,
        partialFailure: false,
        failedChunks: [],
      };

      sendProgress(jobId, 50, "Text loaded. Generating notes...");
    }

    // ── audio / video file ──
    else {
      wavPath = req.file.path;
      sendProgress(jobId, 2, "Preparing audio...");
      convertedPath = convertToWav(wavPath);
      sendProgress(jobId, 5, "Starting transcription...");

      transcription = await transcribeAudioFile(convertedPath, (percent, message) => {
        const overall = 5 + Math.round((percent / 100) * 45);
        sendProgress(jobId, overall, message);
      });

      if (transcription.status === "Error") {
        throw new Error(transcription.error || "Transcription failed.");
      }

      sendProgress(jobId, 55, "Transcription complete. Generating notes...");
    }

    const effectiveOutputLanguage =
      (!outputLanguage || outputLanguage.toLowerCase() === "auto")
        ? (transcription.detectedLanguage || "auto")
        : outputLanguage;

    const notes = await generateSmartNotes(
      transcription.wordTimestamps,
      transcription.fullText,
      promptInstruction,
      (percent, message) => {
        const overall = 55 + Math.round((percent / 100) * 43);
        sendProgress(jobId, overall, message);
      },
      effectiveOutputLanguage
    );

    const id = storage.generateId();
    storage.saveTranscript(id, {
      fileName: originalName,
      fullText: transcription.fullText,
      wordTimestamps: transcription.wordTimestamps,
    });
    storage.saveSummary(id, {
      fileName: originalName,
      ...notes,
    });

    sendProgress(jobId, 100, "Done!");
    endProgress(jobId);

    const processingTime = ((Date.now() - startTime) / 1000).toFixed(1);
    res.json({
      status: "Success",
      id,
      processingTime,
      transcription: {
        fullText: transcription.fullText,
        wordTimestamps: transcription.wordTimestamps,
      },
      notes,
      partialFailure: transcription.partialFailure || false,
      failedChunks: transcription.failedChunks || [],
    });
  } catch (error) {
    console.error("[/upload] Error:", error.message);
    sendProgress(jobId, 0, "Error: " + error.message);
    endProgress(jobId);
    res.status(500).json({ status: "Error", error: error.message });
  } finally {
    [wavPath, convertedPath].forEach(p => {
      if (p && fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch (e) {}
      }
    });
    if (req.file?.path && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
  }
});

// ── POST /translate ──
app.post("/translate", async (req, res) => {
  try {
    const { id, targetLanguage, notes } = req.body;
    if (!targetLanguage?.trim()) {
      return res.status(400).json({ status: "Error", error: "targetLanguage is required." });
    }
    let sourceNotes = notes;
    if (!sourceNotes && id) {
      const record = storage.getSummary(id);
      if (!record) return res.status(404).json({ status: "Error", error: "Notes not found for that id." });
      sourceNotes = record;
    }
    if (!sourceNotes) {
      return res.status(400).json({ status: "Error", error: "Provide either 'notes' or 'id'." });
    }
    const translated = await translateNotes(sourceNotes, targetLanguage);
    res.json({ status: "Success", notes: translated, targetLanguage });
  } catch (error) {
    console.error("[/translate] Error:", error.message);
    res.status(500).json({ status: "Error", error: error.message });
  }
});

// ── POST /translate-transcript ──
app.post("/translate-transcript", async (req, res) => {
  try {
    const { id, targetLanguage, wordTimestamps } = req.body;
    if (!targetLanguage?.trim()) {
      return res.status(400).json({ status: "Error", error: "targetLanguage is required." });
    }
    let sourceWords = wordTimestamps;
    if (!sourceWords && id) {
      const record = storage.getTranscript(id);
      if (!record) return res.status(404).json({ status: "Error", error: "Transcript not found for that id." });
      sourceWords = record.wordTimestamps;
    }
    if (!sourceWords || sourceWords.length === 0) {
      return res.status(400).json({ status: "Error", error: "Provide either 'wordTimestamps' or 'id'." });
    }
    const translatedBlocks = await translateTranscript(sourceWords, targetLanguage);
    res.json({ status: "Success", blocks: translatedBlocks, targetLanguage });
  } catch (error) {
    console.error("[/translate-transcript] Error:", error.message);
    res.status(500).json({ status: "Error", error: error.message });
  }
});

// ── POST /share/:id ──
app.post("/share/:id", (req, res) => {
  try {
    const { id } = req.params;
    const transcript = storage.getTranscript(id);
    const summary = storage.getSummary(id);
    if (!transcript && !summary) {
      return res.status(404).json({ status: "Error", error: "No record found for that ID." });
    }
    const token = storage.createShare(id);
    res.json({ status: "Success", token, url: `http://localhost:5001/share/${token}` });
  } catch (error) {
    console.error("[/share] Error:", error.message);
    res.status(500).json({ status: "Error", error: error.message });
  }
});

// ── GET /share/:token ──
app.get("/share/:token", (req, res) => {
  try {
    const share = storage.getShare(req.params.token);
    if (!share) {
      return res.status(404).send(`
        <!DOCTYPE html><html><head><title>Not Found</title>
        <style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f1f5f9;}
        .box{text-align:center;color:#64748b;} h2{color:#0f172a;}</style></head>
        <body><div class="box"><h2>Link not found</h2><p>This share link is invalid or has expired.</p></div></body></html>
      `);
    }
    const transcript = storage.getTranscript(share.id);
    const summary = storage.getSummary(share.id);
    if (!transcript && !summary) {
      return res.status(404).send(`<!DOCTYPE html><html><head><title>Not Found</title></head><body><h2>Content not found.</h2></body></html>`);
    }

    const fileName = summary?.fileName || transcript?.fileName || "Untitled";
    const createdAt = summary?.createdAt ? new Date(summary.createdAt).toLocaleString() : "";

    const notesHtml = summary ? `
      <div class="section">
        ${summary.summary ? `<div class="block"><div class="block-label">Summary</div><p>${escapeHtml(summary.summary)}</p></div>` : ""}
        ${summary.keyPoints?.length ? `<div class="block"><div class="block-label">Key Points</div><ul>${summary.keyPoints.map(i => `<li>${escapeHtml(i)}</li>`).join("")}</ul></div>` : ""}
        ${summary.decisions?.length ? `<div class="block"><div class="block-label">Decisions</div><ul>${summary.decisions.map(i => `<li>${escapeHtml(i)}</li>`).join("")}</ul></div>` : ""}
        ${summary.actionItems?.length ? `<div class="block"><div class="block-label">Action Items</div><ul>${summary.actionItems.map(i => `<li>${escapeHtml(i)}</li>`).join("")}</ul></div>` : ""}
        ${summary.topics?.length ? `<div class="block"><div class="block-label">Topics</div><ul>${summary.topics.map(i => `<li>${escapeHtml(i)}</li>`).join("")}</ul></div>` : ""}
        ${summary.speakerInsights?.length ? `<div class="block"><div class="block-label">Speaker Insights</div><ul>${summary.speakerInsights.map(i => `<li>${escapeHtml(i)}</li>`).join("")}</ul></div>` : ""}
      </div>` : "";

    const speakerColors = { "1": "#16a34a", "2": "#2563eb", "3": "#9333ea" };
    const speakerBg = { "1": "#f0fdf4", "2": "#eff6ff", "3": "#faf5ff" };
    const speakerBorder = { "1": "#22c55e", "2": "#2563eb", "3": "#a855f7" };

    let transcriptHtml = "";
    if (transcript?.wordTimestamps?.length) {
      const blocks = [];
      let cur = null;
      transcript.wordTimestamps.forEach(w => {
        const id = w.speaker || "1";
        if (!cur || cur.speaker !== id) {
          cur = { speaker: id, startTime: w.startTime, words: [w.word] };
          blocks.push(cur);
        } else {
          cur.words.push(w.word);
        }
      });
      transcriptHtml = `<div class="section"><div class="section-title">Transcript</div>` +
        blocks.map(b => {
          const color = speakerColors[b.speaker] || "#64748b";
          const bg = speakerBg[b.speaker] || "#f8fafc";
          const border = speakerBorder[b.speaker] || "#cbd5e1";
          return `<div style="margin-bottom:12px;padding:12px 14px;background:${bg};border-left:3px solid ${border};border-radius:8px;">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:${color};margin-bottom:5px;">
              Speaker ${escapeHtml(b.speaker)} <span style="color:#94a3b8;font-weight:400;margin-left:8px;">${escapeHtml(b.startTime)}</span>
            </div>
            <p style="font-size:14px;color:#334155;line-height:1.7;margin:0;">${escapeHtml(b.words.join(" "))}</p>
          </div>`;
        }).join("") + `</div>`;
    }

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(fileName)} — AI Notetaker</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Inter",sans-serif;background:#f0f4f8;color:#0f172a;padding:32px 16px 80px;-webkit-font-smoothing:antialiased;}
.shell{max-width:680px;margin:0 auto;}
.header{margin-bottom:20px;}
.header h1{font-size:20px;font-weight:600;letter-spacing:-0.3px;color:#0f172a;}
.header p{font-size:13px;color:#64748b;margin-top:3px;}
.card{background:#fff;border-radius:16px;border:1px solid #e2e8f0;box-shadow:0 2px 8px rgba(0,0,0,0.04),0 8px 32px rgba(0,0,0,0.06);padding:24px;}
.section{margin-bottom:24px;}
.section-title{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#94a3b8;margin-bottom:12px;}
.block{padding:14px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:10px;}
.block-label{font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#94a3b8;margin-bottom:7px;}
.block p{font-size:14px;color:#334155;line-height:1.75;}
.block ul{padding-left:18px;}
.block li{font-size:14px;color:#334155;line-height:1.85;}
.footer{text-align:center;font-size:12px;color:#94a3b8;margin-top:32px;}
</style>
</head>
<body>
<div class="shell">
  <div class="header">
    <h1>${escapeHtml(fileName)}</h1>
    <p>Shared via AI Notetaker${createdAt ? ` · ${createdAt}` : ""}</p>
  </div>
  <div class="card">
    ${notesHtml}
    ${transcriptHtml}
  </div>
  <div class="footer">Generated by AI Notetaker</div>
</div>
</body>
</html>`);
  } catch (error) {
    console.error("[/share/:token] Error:", error.message);
    res.status(500).send("<h2>Something went wrong.</h2>");
  }
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── GET /history ──
app.get("/history", (req, res) => {
  try {
    const history = storage.listAll();
    res.json({ history });
  } catch (error) {
    console.error("[/history] Error:", error.message);
    res.status(500).json({ status: "Error", error: error.message });
  }
});

// ── DELETE /history/:id ──
app.delete("/history/:id", (req, res) => {
  try {
    const deleted = storage.deleteRecord(req.params.id);
    if (!deleted) {
      return res.status(404).json({ status: "Error", error: "Record not found." });
    }
    res.json({ status: "Success" });
  } catch (error) {
    console.error("[/history/:id DELETE] Error:", error.message);
    res.status(500).json({ status: "Error", error: error.message });
  }
});

// ── GET /transcript/:id ──
app.get("/transcript/:id", (req, res) => {
  try {
    const record = storage.getTranscript(req.params.id);
    if (!record) return res.status(404).json({ status: "Error", error: "Transcript not found." });
    res.json({ status: "Success", transcript: record });
  } catch (error) {
    console.error("[/transcript/:id] Error:", error.message);
    res.status(500).json({ status: "Error", error: error.message });
  }
});

// ── GET /summary/:id ──
app.get("/summary/:id", (req, res) => {
  try {
    const record = storage.getSummary(req.params.id);
    if (!record) return res.status(404).json({ status: "Error", error: "Summary not found." });
    res.json({ status: "Success", summary: record });
  } catch (error) {
    console.error("[/summary/:id] Error:", error.message);
    res.status(500).json({ status: "Error", error: error.message });
  }
});

// ── Microsoft Loop / OneDrive endpoints ──
let pendingLoopToken = null;

app.get("/loop/status", async (req, res) => {
  try {
    const result = await loopReader.getTokenSilentOrNull();
    if (result) {
      res.json({ status: "signed_in", username: result.username });
    } else {
      res.json({ status: "signed_out" });
    }
  } catch (e) {
    res.json({ status: "signed_out" });
  }
});

app.post("/loop/signin", (req, res) => {
  pendingLoopToken = null;
  loopReader.startDeviceCodeFlow(
    (deviceCode) => {
      res.json({ status: "device_code", ...deviceCode });
    },
    (result) => {
      pendingLoopToken = result.token;
      console.log("[Loop] Signed in as:", result.username);
    },
    (err) => {
      console.error("[Loop] Sign in error:", err.message);
      pendingLoopToken = null;
    }
  );
});

app.get("/loop/token-ready", async (req, res) => {
  if (pendingLoopToken) {
    res.json({ ready: true });
  } else {
    const result = await loopReader.getTokenSilentOrNull();
    res.json({ ready: !!result });
  }
});

app.post("/loop/signout", async (req, res) => {
  await loopReader.signOut();
  pendingLoopToken = null;
  res.json({ status: "signed_out" });
});

app.get("/loop/files", async (req, res) => {
  try {
    let token = pendingLoopToken;
    if (!token) {
      const result = await loopReader.getTokenSilentOrNull();
      if (!result) return res.status(401).json({ status: "Error", error: "Not signed in to Microsoft." });
      token = result.token;
    }
    const files = await loopReader.listLoopFiles(token);
    res.json({ status: "Success", files });
  } catch (e) {
    console.error("[/loop/files]", e.message);
    res.status(500).json({ status: "Error", error: e.message });
  }
});

app.post("/loop/read", async (req, res) => {
  const { itemId, fileName, promptInstruction, jobId, outputLanguage } = req.body;
  if (!itemId || !fileName) return res.status(400).json({ status: "Error", error: "itemId and fileName required." });

  try {
    let token = pendingLoopToken;
    if (!token) {
      const result = await loopReader.getTokenSilentOrNull();
      if (!result) return res.status(401).json({ status: "Error", error: "Not signed in to Microsoft." });
      token = result.token;
    }

    sendProgress(jobId, 10, "Reading Loop file from OneDrive...");
    const text = await loopReader.readLoopFileContent(token, itemId, fileName);

    if (!text || text.length < 10) throw new Error("Loop file appears to be empty or unreadable.");

    sendProgress(jobId, 40, "Generating notes...");

    const words = text.split(/\s+/).filter(Boolean).map(word => ({
      word, speaker: "1", startTime: "0.00s", duration: "0.00s",
    }));

    const effectiveLanguage = (!outputLanguage || outputLanguage.toLowerCase() === "auto") ? "auto" : outputLanguage;

    const notes = await generateSmartNotes(words, text, promptInstruction || "", (pct, msg) => {
      sendProgress(jobId, 40 + Math.round((pct / 100) * 55), msg);
    }, effectiveLanguage);

    const id = storage.generateId();
    storage.saveTranscript(id, { fileName, fullText: text, wordTimestamps: words });
    storage.saveSummary(id, { fileName, ...notes });

    sendProgress(jobId, 100, "Done!");
    endProgress(jobId);

    res.json({
      status: "Success",
      id,
      transcription: { fullText: text, wordTimestamps: words },
      notes,
    });
  } catch (e) {
    console.error("[/loop/read]", e.message);
    sendProgress(jobId, 0, "Error: " + e.message);
    endProgress(jobId);
    res.status(500).json({ status: "Error", error: e.message });
  }
});

// ── Start server ──
app.listen(PORT, "127.0.0.1", () => {
  console.log(`🚀 AI Notetaker server running at http://127.0.0.1:${PORT}`);
});

module.exports = app;