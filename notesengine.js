const axios = require("axios");
const path = require("path");
const { app: electronApp } = require("electron");

const dotenvPath = electronApp.isPackaged
  ? path.join(process.resourcesPath, ".env")
  : path.join(__dirname, ".env");
require("dotenv").config({ path: dotenvPath });

const AZURE_OPENAI_KEY = process.env.AZURE_OPENAI_KEY;
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o-mini";
const API_VERSION = "2024-12-01-preview";

async function azureChat(messages, maxTokens = 1500) {
  const endpoint = AZURE_OPENAI_ENDPOINT.endsWith("/") ? AZURE_OPENAI_ENDPOINT : AZURE_OPENAI_ENDPOINT + "/";
  const url = `${endpoint}openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${API_VERSION}`;
  try {
    const response = await axios.post(url, { messages, max_tokens: maxTokens, temperature: 0.3 }, {
      headers: { "api-key": AZURE_OPENAI_KEY, "Content-Type": "application/json" },
      timeout: 60000,
    });
    const result = response.data.choices[0].message.content;
    response.data = null;
    return result;
  } catch (err) {
    const azureError = err.response?.data;
    console.error("[azureChat] Status:", err.response?.status);
    console.error("[azureChat] Azure error body:", JSON.stringify(azureError, null, 2));
    const filtered = azureError?.error?.code === "content_filter" ||
      azureError?.error?.innererror?.code === "ResponsibleAIPolicyViolation";
    const reason = filtered
      ? "Content filtered by Azure OpenAI's content policy"
      : azureError?.error?.message || err.message;
    const wrappedErr = new Error(reason);
    wrappedErr.isContentFiltered = filtered;
    throw wrappedErr;
  }
}

function splitIntoChunks(wordTimestamps, chunkSize = 300, overlap = 60) {
  if (!wordTimestamps || wordTimestamps.length === 0) return [];
  const chunks = [];
  let start = 0;
  while (start < wordTimestamps.length) {
    const end = Math.min(start + chunkSize, wordTimestamps.length);
    const text = wordTimestamps.slice(start, end).map(w => `[Speaker ${w.speaker} @ ${w.startTime}] ${w.word}`).join(" ");
    chunks.push(text);
    if (end === wordTimestamps.length) break;
    start += chunkSize - overlap;
  }
  return chunks;
}

async function detectLanguage(fullText) {
  const sample = fullText.slice(0, 500);
  const response = await azureChat([
    {
      role: "system",
      content: "Identify the language of the following text. Reply with ONLY the language name in English, nothing else. Example: Hindi, Spanish, Tamil, French, English, etc. Do not add any explanation."
    },
    { role: "user", content: sample }
  ], 10);
  return response.trim();
}

function languageInstruction(outputLanguage) {
  if (!outputLanguage || outputLanguage.toLowerCase() === "auto") {
    return "Respond in the same language as the transcript (match the speakers' language).";
  }
  return `CRITICAL: Respond ENTIRELY in ${outputLanguage}. Every word, every sentence, every bullet point must be written in ${outputLanguage}. Do NOT use English under any circumstances unless ${outputLanguage} is English.`;
}

function safeParseJSON(raw) {
  if (!raw || typeof raw !== "string") return null;
  try { return JSON.parse(raw); } catch (e) {}
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) {}
  try {
    const stripped = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    return JSON.parse(stripped);
  } catch (e) {}
  return null;
}

function ensureValidNotes(parsed, fallbackText = "") {
  const required = ["summary", "keyPoints", "decisions", "actionItems", "speakerInsights", "topics"];
  if (!parsed || typeof parsed !== "object") {
    return {
      summary: fallbackText,
      keyPoints: [],
      decisions: [],
      actionItems: [],
      speakerInsights: [],
      topics: [],
    };
  }
  for (const key of required) {
    if (!parsed[key]) parsed[key] = key === "summary" ? "" : [];
  }
  ["keyPoints", "decisions", "actionItems", "speakerInsights", "topics"].forEach(field => {
    if (!Array.isArray(parsed[field])) parsed[field] = [];
    parsed[field] = parsed[field].map(item =>
      typeof item === "string" ? item : Object.values(item).join(" - ")
    );
  });
  return parsed;
}

function userRequestedBold(promptInstruction) {
  if (!promptInstruction) return false;
  return /\b(bold|highlight(ed)?|emphasi[sz]e[d]?)\b/i.test(promptInstruction);
}

/**
 * Post-processing: strip bold from label patterns like **Audio File Formats:**
 * These appear when the AI bolds a heading/label at the start of a bullet
 * instead of the key phrase inside the sentence.
 *
 * Patterns we strip:
 *   "**Label:** rest of text"  → "Label: rest of text"
 *   "**Label** - rest of text" → "Label - rest of text" (owner-style labels)
 *
 * We leave bold alone if it appears in the MIDDLE of a sentence (that's correct).
 */
function stripLabelBold(text) {
  if (typeof text !== "string") return text;

  // Pattern 1: **Label:** something → Label: something
  // Catches things like "**Audio File Formats:** The system will..."
  text = text.replace(/^\*\*([^*]+):\*\*\s*/g, "$1: ");

  // Pattern 2: **Label** - something → Label - something
  // Catches things like "**Raghav Kamboj** - develop a prototype..."
  text = text.replace(/^\*\*([^*]+)\*\*(\s*[-–]\s*)/g, "$1$2");

  // Pattern 3: **Label:** at start even if it's mid-text after a dash or bullet char
  text = text.replace(/\*\*([^*]+):\*\*/g, (match, label) => {
    // Only strip if the label looks like a short heading (no sentence punctuation inside)
    if (label.length < 40 && !/[.!?]/.test(label)) return label + ":";
    return match; // keep bold if it looks like a real phrase, not a label
  });

  return text;
}

/**
 * Apply stripLabelBold across all array fields and summary in a notes object.
 * Only runs when the user requested bold — no point running it otherwise.
 */
function cleanLabelBoldFromNotes(notes) {
  const arrayFields = ["keyPoints", "decisions", "actionItems", "speakerInsights", "topics"];
  arrayFields.forEach(field => {
    if (Array.isArray(notes[field])) {
      notes[field] = notes[field].map(stripLabelBold);
    }
  });
  if (typeof notes.summary === "string") {
    notes.summary = stripLabelBold(notes.summary);
  }
  return notes;
}

function applyBoldFallback(parsed, promptInstruction) {
  if (!userRequestedBold(promptInstruction)) return parsed;

  const lower = promptInstruction.toLowerCase();

  const arrayFields = ["keyPoints", "decisions", "actionItems", "speakerInsights", "topics"];
  const alreadyBold =
    (typeof parsed.summary === "string" && parsed.summary.includes("**")) ||
    arrayFields.some(f => Array.isArray(parsed[f]) && parsed[f].some(i => typeof i === "string" && i.includes("**")));

  if (alreadyBold) return parsed;

  const onlyMatch = lower.match(/(?:bold\s+only|only\s+bold)\s+([\w\s]+?)(?:\s*$|\s+and\s+|\s*[.,;])/);

  let targets = [];

  if (onlyMatch) {
    const onlyTarget = onlyMatch[1].trim();
    if (/key\s*point/.test(onlyTarget)) targets.push("keyPoints");
    else if (/decision/.test(onlyTarget)) targets.push("decisions");
    else if (/action/.test(onlyTarget)) targets.push("actionItems");
    else if (/summary/.test(onlyTarget)) targets.push("summary");
    else if (/topic/.test(onlyTarget)) targets.push("topics");
    else if (/speaker/.test(onlyTarget)) targets.push("speakerInsights");
    else targets.push("keyPoints");
  } else {
    if (/key\s*point/.test(lower)) targets.push("keyPoints");
    if (/decision/.test(lower)) targets.push("decisions");
    if (/action\s*item/.test(lower)) targets.push("actionItems");
    if (/summary/.test(lower)) targets.push("summary");
    if (/topic/.test(lower)) targets.push("topics");
    if (/speaker/.test(lower)) targets.push("speakerInsights");
    if (targets.length === 0) targets.push("keyPoints");
  }

  targets.forEach(field => {
    if (field === "summary") {
      if (typeof parsed.summary === "string" && parsed.summary.trim()) {
        parsed.summary = `**${parsed.summary.trim()}**`;
      }
    } else if (Array.isArray(parsed[field])) {
      parsed[field] = parsed[field].map(item =>
        typeof item === "string" && item.trim() ? `**${item.trim()}**` : item
      );
    }
  });

  console.log(`[Notes] Applied bold to: ${targets.join(", ")}`);
  return parsed;
}

async function generateSmartNotes(wordTimestamps, fullText = "", promptInstruction = "", onProgress = () => {}, outputLanguage = "auto") {
  if (!AZURE_OPENAI_KEY || !AZURE_OPENAI_ENDPOINT) {
    return ensureValidNotes(null, "Add AZURE_OPENAI_KEY and AZURE_OPENAI_ENDPOINT to .env.");
  }

  if (!promptInstruction?.trim()) {
    promptInstruction = "Generate meeting notes with key points, decisions made, and action items.";
  }

  if (!outputLanguage || outputLanguage.toLowerCase() === "auto") {
    try {
      onProgress(2, "Detecting language...");
      outputLanguage = await detectLanguage(fullText);
      console.log(`[Notes] Auto-detected language: ${outputLanguage}`);
    } catch (e) {
      console.warn("[Notes] Language detection failed, will let model infer:", e.message);
      outputLanguage = "auto";
    }
  }

  console.log(`[Notes] Using prompt: "${promptInstruction}" | Language: ${outputLanguage}`);

  try {
    const chunks = splitIntoChunks(wordTimestamps);
    if (chunks.length === 0) return ensureValidNotes(null, "No transcript data.");

    onProgress(10, `Analyzing ${chunks.length} transcript chunks...`);

    const settled = await Promise.allSettled(
      chunks.map((chunk, i) =>
        azureChat([
          {
            role: "system",
            content: `You are an expert analyst. The user's instruction is: "${promptInstruction}"
Extract ONLY what is relevant to the user's request. Be concise.
${languageInstruction(outputLanguage)}`
          },
          { role: "user", content: `Transcript chunk ${i + 1}:\n\n${chunk}` }
        ]).then(result => {
          onProgress(Math.round(10 + ((i + 1) / chunks.length) * 55), `Analyzed chunk ${i + 1} of ${chunks.length}...`);
          return result;
        })
      )
    );

    const summaries = [];
    let filteredCount = 0;

    settled.forEach((result, i) => {
      if (result.status === "fulfilled") {
        summaries.push(result.value);
      } else {
        console.error(`[Notes] Chunk ${i + 1} failed: ${result.reason?.message}`);
        if (result.reason?.isContentFiltered) filteredCount++;
        summaries.push(`[This section could not be analyzed${result.reason?.isContentFiltered ? " — flagged by content filter" : ""}.]`);
      }
    });

    if (summaries.every(s => s.startsWith("[This section"))) {
      throw new Error("All chunks failed — Azure OpenAI rejected every request.");
    }

    onProgress(70, "Merging analysis...");

    const combined = summaries.map((s, i) => `--- Part ${i + 1} ---\n${s}`).join("\n\n").slice(0, 8000);

    const boldInstruction = userRequestedBold(promptInstruction) ? `
BOLDING RULES — follow these exactly, no exceptions:
- Bold ONLY the single most important word or short phrase INSIDE each bullet point sentence.
- The bolded text must appear in the MIDDLE or END of the sentence — never at the very start.
- NEVER bold a label or heading (a word or phrase followed by a colon like "Audio File Formats:" or "Owner:").
- NEVER bold the first word or phrase of a bullet if it is followed by a colon.
- NEVER bold the entire sentence or bullet — only 2-5 words maximum.
- CORRECT example: "The system will accept audio files in **WAV, MP3, and M4A** formats."
- CORRECT example: "Server memory was reduced from **28 GB to 4.5 GB**, enabling affordable hardware."
- WRONG example: "**Audio File Formats:** The system will accept audio files." ← label bold, FORBIDDEN
- WRONG example: "**The system will accept audio files in WAV, MP3, M4A formats.**" ← whole sentence bold, FORBIDDEN` : "";

    const systemPrompt = `You are a professional notes generator.
The user's EXACT instruction is: "${promptInstruction}"
Follow the user's instruction EXACTLY.
${languageInstruction(outputLanguage)}
${boldInstruction}

You MUST respond with ONLY a valid JSON object — nothing else.
No explanation, no markdown fences, no preamble.
The JSON must have exactly these keys:
{
  "summary": "string",
  "keyPoints": ["string"],
  "decisions": ["string"],
  "actionItems": ["string"],
  "speakerInsights": ["string"],
  "topics": ["string"]
}

RULES:
- If user asks for "only key points" → put them in keyPoints, leave others as empty arrays/string
- If user asks for "only summary" → put it in summary, leave others as empty arrays/string
- If user asks for "only action items" → put them in actionItems, leave others as empty arrays/string
- Always put content in the RIGHT field
- All array items must be plain strings — never nested objects
- The JSON keys stay in English — only the VALUES are in ${outputLanguage || "the transcript's language"}
- Do NOT wrap the JSON in markdown code blocks`;

    const finalResponse = await azureChat([
      { role: "system", content: systemPrompt },
      { role: "user", content: `Analysis:\n\n${combined}\n\nTranscript sample:\n\n${fullText.slice(0, 1000)}` }
    ], 4000);

    console.log("[Notes] Raw finalResponse (first 300 chars):", finalResponse?.slice(0, 300));

    const parsed = safeParseJSON(finalResponse);

    if (!parsed) {
      console.warn("[Notes] Could not parse JSON from finalResponse. Using fallback.");
      return ensureValidNotes(null, finalResponse?.slice(0, 500) || "Notes could not be generated.");
    }

    let validated = ensureValidNotes(parsed);

    // If user requested bold, strip any label-style bolding the model applied
    // (e.g. "**Audio File Formats:**") before applying our own fallback logic.
    if (userRequestedBold(promptInstruction)) {
      validated = cleanLabelBoldFromNotes(validated);
      console.log("[Notes] Stripped label-style bold patterns.");
    }

    // If model produced no bold at all despite request, apply fallback
    validated = applyBoldFallback(validated, promptInstruction);

    if (filteredCount > 0) {
      validated.summary = `${validated.summary}\n\n(Note: ${filteredCount} of ${chunks.length} transcript section(s) could not be analyzed due to Azure's content filter.)`.trim();
    }

    onProgress(100, "Notes complete!");
    console.log("[Notes] ✅ Done.");
    return validated;

  } catch (error) {
    console.error("[Notes] Error:", error.message);
    throw error;
  }
}

async function translateNotes(notes, targetLanguage) {
  if (!targetLanguage?.trim()) throw new Error("Target language is required.");

  const payload = {
    summary: notes.summary || "",
    keyPoints: notes.keyPoints || [],
    decisions: notes.decisions || [],
    actionItems: notes.actionItems || [],
    speakerInsights: notes.speakerInsights || [],
    topics: notes.topics || [],
  };

  const response = await azureChat([
    {
      role: "system",
      content: `You are a professional translator. Translate ALL string values in the given JSON into ${targetLanguage}.
Rules:
- Keep the exact same JSON structure and keys.
- Translate every string naturally and accurately.
- Preserve any markdown formatting (e.g. **bold**) — translate the words, not the markdown symbols.
- If an array is empty, leave it empty.
- Output ONLY valid JSON, nothing else — no markdown fences, no explanation.`
    },
    { role: "user", content: JSON.stringify(payload) }
  ], 2000);

  const parsed = safeParseJSON(response);
  if (!parsed) throw new Error("Translation response could not be parsed as JSON.");
  return ensureValidNotes(parsed);
}

async function translateTranscript(wordTimestamps, targetLanguage) {
  if (!targetLanguage?.trim()) throw new Error("Target language is required.");
  if (!wordTimestamps || wordTimestamps.length === 0) return [];

  const blocks = [];
  let currentSpeaker = null;
  let currentBlock = null;

  wordTimestamps.forEach(w => {
    const id = w.speaker || "1";
    if (id !== currentSpeaker) {
      currentSpeaker = id;
      currentBlock = { speaker: id, startTime: w.startTime, text: w.word };
      blocks.push(currentBlock);
    } else {
      currentBlock.text += " " + w.word;
    }
  });

  const BATCH_SIZE = 20;
  const translatedBlocks = [];

  for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
    const batch = blocks.slice(i, i + BATCH_SIZE).map((b, idx) => ({
      id: i + idx,
      speaker: b.speaker,
      startTime: b.startTime,
      text: b.text
    }));

    const response = await azureChat([
      {
        role: "system",
        content: `You are a professional translator. Translate the "text" field of each object in the JSON array into ${targetLanguage}.
Rules:
- Keep ALL other fields (id, speaker, startTime) exactly the same.
- Translate ONLY the "text" field.
- Output ONLY a valid JSON array, nothing else.`
      },
      { role: "user", content: JSON.stringify(batch) }
    ], 2000);

    let parsed;
    try {
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : response);
    } catch (e) {
      console.error(`[translateTranscript] Batch ${i} parse failed, using originals:`, e.message);
      parsed = batch;
    }

    translatedBlocks.push(...parsed);
  }

  translatedBlocks.sort((a, b) => a.id - b.id);
  return translatedBlocks;
}

module.exports = { generateSmartNotes, translateNotes, translateTranscript };