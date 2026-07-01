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

/**
 * ── REQUIREMENT DECOMPOSITION ──────────────────────────────────────────
 *
 * Root cause of "some instructions get dropped": when a user bundles
 * multiple distinct asks into one sentence ("make key points bold, speak
 * like a pirate, start every sentence with a fruit name"), the model
 * treats the whole thing as one fuzzy vibe rather than a checklist of
 * independent, individually-verifiable requirements. It tends to fully
 * satisfy whichever requirement is easiest/most salient (tone/persona,
 * since that's a single global stylistic choice) and silently drop
 * requirements that require per-sentence or per-item discipline
 * (formatting every bullet, starting every sentence a certain way),
 * because those require sustained attention across the whole output
 * rather than a single decision made once.
 *
 * Fix: instead of handing the model one flat instruction string, we
 * have it FIRST explicitly enumerate the user's instruction into a
 * checklist of distinct, independently-checkable requirements before
 * generating anything. This checklist is then carried through BOTH the
 * per-chunk pass and the final merge pass, and the generation prompt at
 * each stage explicitly tells the model: every single item in this
 * checklist must be true of the ENTIRE output, not just somewhere in it.
 */
async function decomposeInstruction(promptInstruction) {
  // If the instruction looks simple (short, no obvious separators), skip
  // the extra API call — decomposition only matters when there's more than
  // one distinct ask.
  const looksCompound = /[.,;]| and | also | make sure | start each | every | each /i.test(promptInstruction) && promptInstruction.length > 40;
  if (!looksCompound) {
    return [promptInstruction.trim()];
  }

  try {
    const response = await azureChat([
      {
        role: "system",
        content: `Break the following user instruction into a numbered list of distinct, independent requirements. Each requirement should be one specific, checkable rule.

Rules for decomposing:
- Separate content requirements (what to include: key points, decisions, action items, summary) from STYLE/FORMAT requirements (tone, persona, formatting like bold, sentence structure rules, capitalization, language).
- Each style/format requirement gets its own line, phrased as a strict, literal, checkable rule — not vague.
- If a requirement applies to "every sentence" or "every item" or "each bullet", explicitly say "EVERY" in the rule so it's clear it's not optional for some items.
- Output ONLY a numbered list, one requirement per line. No preamble, no explanation.

Example input: "Generate meeting notes with key points and action items. Make the key points bold. Speak like a pirate. Make sure to start each sentence with a fruit name."
Example output:
1. Include key points in the notes.
2. Include action items in the notes.
3. EVERY key point bullet must be wrapped in markdown **bold** — not just the first one, ALL of them.
4. The writing voice/persona throughout must be a pirate (pirate vocabulary, contractions like "ye", "arr", etc.) in every sentence.
5. EVERY single sentence in the output, with no exceptions, must begin with the name of a fruit (e.g. "Apple, the team decided..." / "Mango, the next step is...").`
      },
      { role: "user", content: promptInstruction }
    ], 500);

    const lines = response
      .split("\n")
      .map(l => l.replace(/^\d+[.)]\s*/, "").trim())
      .filter(l => l.length > 0);

    return lines.length > 0 ? lines : [promptInstruction.trim()];
  } catch (e) {
    console.warn("[Notes] Instruction decomposition failed, using raw instruction:", e.message);
    return [promptInstruction.trim()];
  }
}

function formatChecklist(requirements) {
  return requirements.map((r, i) => `${i + 1}. ${r}`).join("\n");
}

/**
 * Shared clause telling the model that EVERY item in the checklist is
 * mandatory and must be true of the ENTIRE output — not satisfied once
 * and then abandoned. This is the enforcement layer on top of the
 * checklist itself.
 */
const CHECKLIST_ENFORCEMENT_CLAUSE =
  `The numbered checklist above contains EVERY requirement from the user — both WHAT content to include and HOW to format/style it. ALL of them are mandatory, with equal priority. None is optional, none is "best effort", none can be dropped for the sake of another.

Before you finish, mentally re-check your own output against EVERY single numbered item. If any item says "EVERY sentence" or "EVERY bullet" or "EVERY item", that means literally all of them, all the way through your response — not just the first one or two as a token gesture.

Markdown syntax (e.g. **bold**, *italic*) inside a JSON string value is valid and does not break the JSON — use it freely when a checklist item requires it.`;

async function summarizeChunk(chunk, index, requirements, outputLanguage) {
  const checklist = formatChecklist(requirements);
  return await azureChat([
    {
      role: "system",
      content: `You are an expert analyst. The user's requirements, decomposed into a checklist:
${checklist}

Extract ONLY what is relevant to the content requirements above. Be concise.
${CHECKLIST_ENFORCEMENT_CLAUSE}
${languageInstruction(outputLanguage)}`
    },
    { role: "user", content: `Transcript chunk ${index + 1}:\n\n${chunk}` }
  ]);
}

function safeParseJSON(raw) {
  if (!raw || typeof raw !== "string") return null;

  try {
    return JSON.parse(raw);
  } catch (e) {}

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

/**
 * Detects whether the user's prompt asked for bold/emphasized/highlighted
 * text anywhere in their instruction. Used as a trigger for the
 * programmatic fallback below — this is a last-resort safety net for
 * bold specifically, since it's mechanically easy to verify and fix
 * after the fact (unlike persona/voice or sentence-start rules, which
 * can't be patched programmatically without rewriting the text).
 */
function userRequestedBold(promptInstruction) {
  if (!promptInstruction) return false;
  return /\b(bold|highlight(ed)?|emphasi[sz]e[d]?)\b/i.test(promptInstruction);
}

function applyBoldFallback(parsed, promptInstruction) {
  if (!userRequestedBold(promptInstruction)) return parsed;

  const arrayFields = ["keyPoints", "decisions", "actionItems", "speakerInsights", "topics"];
  const anyArrayAlreadyBold = arrayFields.some(field =>
    Array.isArray(parsed[field]) && parsed[field].some(item => typeof item === "string" && item.includes("**"))
  );
  const summaryAlreadyBold = typeof parsed.summary === "string" && parsed.summary.includes("**");

  if (anyArrayAlreadyBold || summaryAlreadyBold) return parsed;

  const lower = promptInstruction.toLowerCase();
  const targets = [];
  if (lower.includes("key point")) targets.push("keyPoints");
  if (lower.includes("decision")) targets.push("decisions");
  if (lower.includes("action item") || lower.includes("action")) targets.push("actionItems");
  if (lower.includes("summary")) targets.push("summary");
  if (lower.includes("topic")) targets.push("topics");
  if (targets.length === 0) targets.push("keyPoints");

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

  console.log(`[Notes] Applied bold fallback to: ${targets.join(", ")} (model did not apply it despite request)`);
  return parsed;
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

/**
 * Second-pass verification specifically for sentence-level structural
 * rules (e.g. "every sentence must start with X") that can't be fixed
 * programmatically the way bold can. Rather than trying to patch the
 * text after the fact (which risks mangling grammar), we ask the model
 * to self-audit and REGENERATE if it broke the rule. This costs one
 * extra API call but only fires when the checklist contains a
 * per-sentence/per-item structural rule, and only escalates to a
 * second generation if the first one provably failed.
 */
function hasPerItemStructuralRule(requirements) {
  return requirements.some(r => /\bEVERY\b.*(sentence|bullet|item)/i.test(r) || /start (each|every)/i.test(r));
}

async function verifyAndFixStructuralRules(parsed, requirements, outputLanguage) {
  const structuralRules = requirements.filter(r =>
    /\bEVERY\b.*(sentence|bullet|item)/i.test(r) || /start (each|every)/i.test(r)
  );
  if (structuralRules.length === 0) return parsed;

  const checklist = formatChecklist(structuralRules);
  const arrayFields = ["keyPoints", "decisions", "actionItems", "speakerInsights", "topics"];

  const fieldsToCheck = {};
  arrayFields.forEach(f => { if (Array.isArray(parsed[f]) && parsed[f].length) fieldsToCheck[f] = parsed[f]; });
  if (typeof parsed.summary === "string" && parsed.summary.trim()) fieldsToCheck.summary = parsed.summary;

  if (Object.keys(fieldsToCheck).length === 0) return parsed;

  try {
    const response = await azureChat([
      {
        role: "system",
        content: `You will be given a JSON object containing notes text. Re-write EVERY string value so it strictly satisfies ALL of these structural rules, with zero exceptions:
${checklist}

Rules:
- Preserve the original meaning and any existing markdown formatting (e.g. **bold**) exactly — only adjust sentence structure/wording to satisfy the rules above.
- Keep the exact same JSON keys and structure as the input.
- Array items stay as an array of strings, same length.
- ${languageInstruction(outputLanguage)}
- Output ONLY the corrected JSON object, nothing else — no explanation, no markdown fences around the JSON.`
      },
      { role: "user", content: JSON.stringify(fieldsToCheck) }
    ], 3000);

    const fixed = safeParseJSON(response);
    if (!fixed) {
      console.warn("[Notes] Structural rule verification pass returned unparseable JSON, keeping original.");
      return parsed;
    }

    Object.keys(fieldsToCheck).forEach(field => {
      if (fixed[field] !== undefined) parsed[field] = fixed[field];
    });

    console.log("[Notes] Applied structural rule verification pass for:", structuralRules.join(" | "));
    return parsed;
  } catch (e) {
    console.warn("[Notes] Structural rule verification pass failed, keeping original output:", e.message);
    return parsed;
  }
}

async function mergeAndFinalize(summaries, fullText, requirements, outputLanguage) {
  const combined = summaries.map((s, i) => `--- Part ${i + 1} ---\n${s}`).join("\n\n").slice(0, 8000);
  const checklist = formatChecklist(requirements);

  const systemPrompt = `You are a professional notes generator.
The user's requirements, decomposed into a checklist:
${checklist}

${CHECKLIST_ENFORCEMENT_CLAUSE}
${languageInstruction(outputLanguage)}

You MUST respond with ONLY a valid JSON object — nothing else.
No explanation, no markdown fences around the JSON itself, no preamble.
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
- If the checklist says content should ONLY go in one field (e.g. "only key points"), put it there and leave others as empty arrays/string
- Always put content in the RIGHT field
- All array items must be plain strings — never nested objects
- A string value MAY itself contain markdown formatting (e.g. **bold**, *italic*) if the checklist requires it — this does NOT break the JSON, it's just text inside a string
- The JSON keys stay in English — only the VALUES are in ${outputLanguage || "the transcript's language"}
- Do NOT wrap the ENTIRE JSON object in markdown code fences — but markdown INSIDE individual string values is fine and expected if required`;

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

  // Bold-specific deterministic fallback
  const flatInstruction = requirements.join(" ");
  validated = applyBoldFallback(validated, flatInstruction);

  // Per-sentence structural rule verification pass (e.g. "every sentence
  // starts with a fruit name") — only runs if such a rule exists in the
  // checklist, and only costs an extra API call in that case.
  if (hasPerItemStructuralRule(requirements)) {
    validated = await verifyAndFixStructuralRules(validated, requirements, outputLanguage);
  }

  return validated;
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
    onProgress(4, "Reading your instructions...");
    const requirements = await decomposeInstruction(promptInstruction);
    console.log("[Notes] Decomposed checklist:\n" + formatChecklist(requirements));

    const chunks = splitIntoChunks(wordTimestamps);
    if (chunks.length === 0) return ensureValidNotes(null, "No transcript data.");

    onProgress(10, `Analyzing ${chunks.length} transcript chunks...`);

    const settled = await Promise.allSettled(
      chunks.map((chunk, i) =>
        summarizeChunk(chunk, i, requirements, outputLanguage).then(result => {
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
      throw new Error("All chunks failed — Azure OpenAI rejected every request. Check deployment name and content policy.");
    }

    onProgress(70, "Merging analysis...");
    const notes = await mergeAndFinalize(summaries, fullText, requirements, outputLanguage);

    if (filteredCount > 0) {
      notes.summary = `${notes.summary}\n\n(Note: ${filteredCount} of ${chunks.length} transcript section(s) could not be analyzed due to Azure's content filter.)`.trim();
    }

    onProgress(100, "Notes complete!");
    console.log("[Notes] ✅ Done.");
    return notes;
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
- Keep the exact same JSON structure and keys (summary, keyPoints, decisions, actionItems, speakerInsights, topics).
- Translate every string naturally and accurately — do not summarize, shorten, or add content.
- Preserve any markdown formatting (e.g. **bold**) already present in the text — translate the words, not the markdown symbols.
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
- Keep ALL other fields (id, speaker, startTime) exactly the same — do not change them.
- Translate ONLY the "text" field of each object.
- Preserve the meaning and tone accurately.
- Output ONLY a valid JSON array, nothing else — no markdown fences, no explanation.`
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