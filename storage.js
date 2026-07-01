const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { app } = require("electron");

const STORAGE_DIR = path.join(app.getPath("userData"), "storage");
const TRANSCRIPTS_DIR = path.join(STORAGE_DIR, "transcripts");
const SUMMARIES_DIR = path.join(STORAGE_DIR, "summaries");
const SHARES_DIR = path.join(STORAGE_DIR, "shares");

if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
if (!fs.existsSync(TRANSCRIPTS_DIR)) fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
if (!fs.existsSync(SUMMARIES_DIR)) fs.mkdirSync(SUMMARIES_DIR, { recursive: true });
if (!fs.existsSync(SHARES_DIR)) fs.mkdirSync(SHARES_DIR, { recursive: true });

function generateId() {
  return crypto.randomUUID();
}

function saveTranscript(id, data) {
  const filePath = path.join(TRANSCRIPTS_DIR, `${id}.json`);
  const record = {
    id,
    createdAt: new Date().toISOString(),
    fileName: data.fileName || "unknown",
    fullText: data.fullText,
    wordTimestamps: data.wordTimestamps,
  };
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2));
  console.log(`[Storage] Transcript saved: ${id}`);
  return record;
}

function saveSummary(id, data) {
  const filePath = path.join(SUMMARIES_DIR, `${id}.json`);
  const record = {
    id,
    createdAt: new Date().toISOString(),
    fileName: data.fileName || "unknown",
    summary: data.summary,
    keyPoints: data.keyPoints,
    decisions: data.decisions,
    actionItems: data.actionItems,
    topics: data.topics,
    speakerInsights: data.speakerInsights,
  };
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2));
  console.log(`[Storage] Summary saved: ${id}`);
  return record;
}

function getTranscript(id) {
  const filePath = path.join(TRANSCRIPTS_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getSummary(id) {
  const filePath = path.join(SUMMARIES_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function listAll() {
  const transcripts = fs.readdirSync(TRANSCRIPTS_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(TRANSCRIPTS_DIR, f), "utf8"));
      return {
        id: data.id,
        fileName: data.fileName,
        createdAt: data.createdAt,
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return transcripts;
}

function createShare(id) {
  const token = crypto.randomBytes(6).toString("hex");
  const filePath = path.join(SHARES_DIR, `${token}.json`);
  fs.writeFileSync(filePath, JSON.stringify({
    id,
    createdAt: new Date().toISOString(),
  }));
  console.log(`[Storage] Share created: ${token} → ${id}`);
  return token;
}

function getShare(token) {
  const filePath = path.join(SHARES_DIR, `${token}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/**
 * Delete a transcript + summary pair by id.
 * Returns true if at least one file was deleted, false if neither existed.
 */
function deleteRecord(id) {
  const transcriptPath = path.join(TRANSCRIPTS_DIR, `${id}.json`);
  const summaryPath = path.join(SUMMARIES_DIR, `${id}.json`);
  let deleted = false;
  if (fs.existsSync(transcriptPath)) {
    fs.unlinkSync(transcriptPath);
    deleted = true;
  }
  if (fs.existsSync(summaryPath)) {
    fs.unlinkSync(summaryPath);
    deleted = true;
  }
  if (deleted) console.log(`[Storage] Deleted record: ${id}`);
  return deleted;
}

module.exports = {
  generateId,
  saveTranscript,
  saveSummary,
  getTranscript,
  getSummary,
  listAll,
  createShare,
  getShare,
  deleteRecord,
};