const fs = require("fs");
const path = require("path");
const axios = require("axios");
const FormData = require("form-data");
const { execSync } = require("child_process");
const { app: electronApp } = require("electron");

const dotenvPath = electronApp.isPackaged
  ? path.join(process.resourcesPath, ".env")
  : path.join(__dirname, ".env");
require("dotenv").config({ path: dotenvPath });

const AZURE_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_REGION = process.env.AZURE_SPEECH_REGION;
const AZURE_OPENAI_KEY = process.env.AZURE_OPENAI_KEY;
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o-mini";

/**
 * Resolve the ffmpeg binary path WITHOUT requiring @ffmpeg-installer/ffmpeg
 * in packaged builds.
 *
 * Why: @ffmpeg-installer/ffmpeg does its own existence check the moment
 * it's require()'d, using asar-relative paths. Inside an asar-packed app
 * those paths are always wrong (the binary actually lives in
 * app.asar.unpacked), so the package throws immediately — before any code
 * of ours that tries to fix up the path ever runs.
 *
 * Fix: in packaged builds, build the expected path ourselves, pointing
 * straight at app.asar.unpacked, and verify it exists with fs.existsSync.
 * Only fall back to require()'ing the package in dev mode, where there's
 * no asar involved and the package's own resolution works fine.
 */
function resolveFfmpegPath() {
  const binaryName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

  let platformPackage;
  if (process.platform === "win32") {
    platformPackage = "win32-x64";
  } else if (process.platform === "darwin") {
    platformPackage = process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  } else {
    platformPackage = `${process.platform}-${process.arch}`;
  }

  if (electronApp.isPackaged) {
    const unpackedPath = path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      "@ffmpeg-installer",
      platformPackage,
      binaryName
    );

    if (fs.existsSync(unpackedPath)) {
      console.log("[Transcribe] Using unpacked ffmpeg binary:", unpackedPath);
      return unpackedPath;
    }

    console.warn(
      "[Transcribe] Expected ffmpeg binary not found at:",
      unpackedPath,
      "— falling back to require() resolution."
    );
  }

  // Dev mode (not packaged), or packaged-but-unexpected-layout fallback.
  try {
    let p = require("@ffmpeg-installer/ffmpeg").path;
    if (p.includes("app.asar") && !p.includes("app.asar.unpacked")) {
      p = p.replace("app.asar", "app.asar.unpacked");
    }
    return p;
  } catch (e) {
    console.error("[Transcribe] Could not resolve ffmpeg path via require():", e.message);
    throw e;
  }
}
const ffmpegPath = resolveFfmpegPath();

const MAX_PARALLEL_CHUNKS = 5;
const CHUNK_THRESHOLD_SECS = 600;
const MAX_RETRIES = 2;

const LANGUAGE_TO_LOCALE = {
  "hindi": "hi-IN",
  "english": "en-US",
  "urdu": "ur-PK",
  "punjabi": "pa-IN",
  "tamil": "ta-IN",
  "telugu": "te-IN",
  "kannada": "kn-IN",
  "malayalam": "ml-IN",
  "marathi": "mr-IN",
  "bengali": "bn-IN",
  "gujarati": "gu-IN",
  "odia": "or-IN",
  "spanish": "es-ES",
  "french": "fr-FR",
  "german": "de-DE",
  "italian": "it-IT",
  "portuguese": "pt-BR",
  "russian": "ru-RU",
  "japanese": "ja-JP",
  "korean": "ko-KR",
  "chinese": "zh-CN",
  "arabic": "ar-SA",
  "turkish": "tr-TR",
  "dutch": "nl-NL",
  "polish": "pl-PL",
  "vietnamese": "vi-VN",
  "thai": "th-TH",
  "indonesian": "id-ID",
  "malay": "ms-MY",
  "swedish": "sv-SE",
  "norwegian": "nb-NO",
  "danish": "da-DK",
  "finnish": "fi-FI",
};

// Reverse lookup: locale code (e.g. "hi-IN") -> language name (e.g. "Hindi")
const LOCALE_TO_LANGUAGE = Object.fromEntries(
  Object.entries(LANGUAGE_TO_LOCALE).map(([name, locale]) => [
    locale,
    name.charAt(0).toUpperCase() + name.slice(1),
  ])
);

const DEFAULT_LOCALE = "en-US";

// Candidate locales Azure Speech will choose between.
// Keep this list to languages you actually expect in your audio.
const CANDIDATE_LOCALES = ["en-US", "hi-IN"];

async function detectLanguageFromText(sampleText) {
  if (!AZURE_OPENAI_KEY || !AZURE_OPENAI_ENDPOINT) {
    return { languageName: "English", locale: DEFAULT_LOCALE };
  }

  try {
    const endpoint = AZURE_OPENAI_ENDPOINT.endsWith("/") ? AZURE_OPENAI_ENDPOINT : AZURE_OPENAI_ENDPOINT + "/";
    const url = `${endpoint}openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=2024-12-01-preview`;

    const response = await axios.post(url, {
      messages: [
        {
          role: "system",
          content: "Identify the PRIMARY language of this text. Reply with ONLY the language name in English, one word. Examples: Hindi, English, Tamil, Urdu, Punjabi. If the text is mixed/Hinglish, reply with the dominant non-English language (e.g. Hindi). If the text is primarily English, reply with English."
        },
        { role: "user", content: sampleText.slice(0, 400) }
      ],
      max_tokens: 10,
      temperature: 0,
    }, {
      headers: {
        "api-key": AZURE_OPENAI_KEY,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    });

    const detected = response.data.choices[0].message.content.trim().toLowerCase();
    const locale = LANGUAGE_TO_LOCALE[detected] || DEFAULT_LOCALE;
    const languageName = detected.charAt(0).toUpperCase() + detected.slice(1);
    console.log(`[Transcribe] Detected language: "${languageName}" → locale: ${locale}`);
    return { languageName, locale };
  } catch (e) {
    console.warn("[Transcribe] Language detection failed, using default:", e.message);
    return { languageName: "English", locale: DEFAULT_LOCALE };
  }
}

async function translateWordTimestamps(wordTimestamps, targetLanguage) {
  if (!AZURE_OPENAI_KEY || !AZURE_OPENAI_ENDPOINT) return wordTimestamps;
  if (!wordTimestamps || wordTimestamps.length === 0) return wordTimestamps;

  const blocks = [];
  let currentSpeaker = null;
  let currentBlock = null;

  wordTimestamps.forEach(w => {
    const id = w.speaker || "1";
    if (id !== currentSpeaker) {
      currentSpeaker = id;
      currentBlock = { speaker: id, startTime: w.startTime, words: [w] };
      blocks.push(currentBlock);
    } else {
      currentBlock.words.push(w);
    }
  });

  console.log(`[Transcribe] Translating ${blocks.length} speaker blocks to ${targetLanguage}...`);

  const endpoint = AZURE_OPENAI_ENDPOINT.endsWith("/") ? AZURE_OPENAI_ENDPOINT : AZURE_OPENAI_ENDPOINT + "/";
  const url = `${endpoint}openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=2024-12-01-preview`;

  const BATCH_SIZE = 15;
  const translatedBlocks = [];

  for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
    const batch = blocks.slice(i, i + BATCH_SIZE).map((b, idx) => ({
      id: i + idx,
      speaker: b.speaker,
      startTime: b.startTime,
      text: b.words.map(w => w.word).join(" "),
    }));

    try {
      const response = await axios.post(url, {
        messages: [
          {
            role: "system",
            content: `You are a professional translator. The audio contains mixed/romanized speech (e.g. Hinglish).
Translate the "text" field of each object into clean, natural ${targetLanguage}.
Rules:
- Write in the proper native script (e.g. Devanagari for Hindi — NOT Roman transliteration).
- Keep id, speaker, startTime fields exactly the same — do not change them.
- Translate ONLY the "text" field of each object.
- Output ONLY a valid JSON array. No markdown fences, no explanation.`,
          },
          { role: "user", content: JSON.stringify(batch) }
        ],
        max_tokens: 2000,
        temperature: 0.1,
      }, {
        headers: {
          "api-key": AZURE_OPENAI_KEY,
          "Content-Type": "application/json",
        },
        timeout: 60000,
      });

      const raw = response.data.choices[0].message.content;
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
      translatedBlocks.push(...parsed);
    } catch (e) {
      console.error(`[Transcribe] Translation batch ${i} failed:`, e.message);
      batch.forEach(b => translatedBlocks.push(b));
    }
  }

  translatedBlocks.sort((a, b) => a.id - b.id);

  return translatedBlocks.map(b => ({
    word: b.text,
    speaker: b.speaker,
    startTime: b.startTime,
    duration: "0.00s",
  }));
}

function getAudioDuration(wavFilePath) {
  try {
    const result = execSync(`"${ffmpegPath}" -i "${wavFilePath}" 2>&1`).toString();
    const match = result.match(/Duration: (\d+):(\d+):(\d+)/);
    if (match) return parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]);
  } catch (e) {
    const result = e.stdout?.toString() || e.stderr?.toString() || "";
    const match = result.match(/Duration: (\d+):(\d+):(\d+)/);
    if (match) return parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]);
  }
  return 0;
}

function splitAudioIntoChunks(wavFilePath, chunkSecs = CHUNK_THRESHOLD_SECS) {
  const outputDir = path.dirname(wavFilePath);
  const baseName = path.basename(wavFilePath, ".wav");
  const duration = getAudioDuration(wavFilePath);
  console.log(`Audio duration: ${duration}s`);

  if (duration <= chunkSecs) {
    return [{ filePath: wavFilePath, startOffset: 0, isOriginal: true, duration }];
  }

  console.log(`Long recording — splitting into ${chunkSecs}s chunks for parallel processing...`);
  const chunks = [];
  let start = 0, index = 0;

  while (start < duration) {
    const chunkPath = path.join(outputDir, `${baseName}_chunk_${index}.wav`);
    execSync(
      `"${ffmpegPath}" -i "${wavFilePath}" -ss ${start} -t ${chunkSecs} -acodec pcm_s16le -ac 1 -ar 16000 -f wav "${chunkPath}" -y`,
      { stdio: "ignore" }
    );
    chunks.push({
      filePath: chunkPath,
      startOffset: start,
      isOriginal: false,
      duration: Math.min(chunkSecs, duration - start),
    });
    start += chunkSecs;
    index++;
  }

  console.log(`Split into ${chunks.length} chunks.`);
  return chunks;
}

async function fastTranscribeChunk(chunkPath) {
  const t0 = Date.now();

  const definition = {
    languageIdentification: {
      candidateLocales: CANDIDATE_LOCALES,
    },
    diarization: { enabled: true, maxSpeakers: 10 },
    profanityFilterMode: "Masked",
  };

  const form = new FormData();
  form.append("audio", fs.createReadStream(chunkPath));
  form.append("definition", JSON.stringify(definition));

  const url = `https://${AZURE_REGION}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15`;

  const response = await axios.post(url, form, {
    headers: {
      ...form.getHeaders(),
      "Ocp-Apim-Subscription-Key": AZURE_KEY,
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 15 * 60 * 1000,
  });

  console.log(`✅ Transcription done (⏱ ${((Date.now() - t0) / 1000).toFixed(1)}s) | Candidates: ${CANDIDATE_LOCALES.join(", ")}`);

  return response.data;
}

async function fastTranscribeChunkWithRetry(chunkPath, chunkIndex) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      return await fastTranscribeChunk(chunkPath);
    } catch (err) {
      lastErr = err;
      console.error(`⚠️ Chunk ${chunkIndex + 1} attempt ${attempt} failed: ${err.message}`);
      if (attempt <= MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }
  throw lastErr;
}

function mapResultToWords(resultData, startOffset) {
  const wordTimestamps = [];
  let fullText = "";

  if (resultData.combinedPhrases) {
    fullText = resultData.combinedPhrases.map(p => p.text).join(" ");
  }

  // Azure Speech reports which candidate locale it actually detected for
  // this chunk — either at the top level (resultData.locale) or per-phrase
  // (phrase.locale), depending on the API response shape. Grab whichever
  // is present so we don't have to re-detect the language afterward.
  let detectedLocale = resultData.locale || null;

  if (resultData.phrases) {
    resultData.phrases.forEach(phrase => {
      if (!detectedLocale && phrase.locale) detectedLocale = phrase.locale;
      const speakerId = String(phrase.speaker || 1);
      if (phrase.words) {
        phrase.words.forEach(w => {
          const startSec = (w.offsetMilliseconds || 0) / 1000 + startOffset;
          wordTimestamps.push({
            word: w.text,
            speaker: speakerId,
            startTime: startSec.toFixed(2) + "s",
            duration: w.durationMilliseconds ? (w.durationMilliseconds / 1000).toFixed(2) + "s" : "0.00s",
          });
        });
      } else {
        const startSec = (phrase.offsetMilliseconds || 0) / 1000 + startOffset;
        wordTimestamps.push({
          word: phrase.text,
          speaker: speakerId,
          startTime: startSec.toFixed(2) + "s",
          duration: phrase.durationMilliseconds ? (phrase.durationMilliseconds / 1000).toFixed(2) + "s" : "0.00s",
        });
      }
    });
  }

  const detectedLanguage = detectedLocale
    ? (LOCALE_TO_LANGUAGE[detectedLocale] || null)
    : null;

  return { fullText, wordTimestamps, detectedLocale, detectedLanguage };
}

async function processChunk(chunk, chunkIndex) {
  const chunkStart = Date.now();
  console.log(`\n🔄 Processing chunk ${chunkIndex + 1}...`);
  const resultData = await fastTranscribeChunkWithRetry(chunk.filePath, chunkIndex);
  const { fullText, wordTimestamps, detectedLocale, detectedLanguage } = mapResultToWords(resultData, chunk.startOffset);
  console.log(`🏁 Chunk ${chunkIndex + 1} total: ⏱ ${((Date.now() - chunkStart) / 1000).toFixed(1)}s${detectedLanguage ? ` | Azure detected: ${detectedLanguage} (${detectedLocale})` : ""}`);
  return { fullText, wordTimestamps, detectedLocale, detectedLanguage };
}

async function transcribeAudioFile(wavFilePath, onProgress = () => {}) {
  const pipelineStart = Date.now();
  const chunks = splitAudioIntoChunks(wavFilePath);
  const totalChunks = chunks.length;

  onProgress(0, totalChunks > 1 ? `Splitting audio into ${totalChunks} chunks...` : "Transcribing...");

  let allWords = [];
  let fullText = "";
  let completedChunks = 0;
  const failedChunks = [];

  // Tally how many chunks Azure detected as each language, so for
  // multi-chunk recordings we can use whichever language "won" overall
  // instead of just whatever the very first chunk happened to report.
  const localeVotes = {};

  for (let i = 0; i < chunks.length; i += MAX_PARALLEL_CHUNKS) {
    const batch = chunks.slice(i, i + MAX_PARALLEL_CHUNKS);

    onProgress(
      Math.round((completedChunks / totalChunks) * 50),
      `Transcribing chunks ${i + 1}–${Math.min(i + MAX_PARALLEL_CHUNKS, totalChunks)} of ${totalChunks}...`
    );

    const batchResults = await Promise.allSettled(
      batch.map((chunk, idx) => processChunk(chunk, i + idx))
    );

    batchResults.forEach((result, idx) => {
      const chunkNumber = i + idx + 1;
      if (result.status === "fulfilled") {
        fullText += result.value.fullText + " ";
        allWords.push(...result.value.wordTimestamps);
        if (result.value.detectedLocale) {
          localeVotes[result.value.detectedLocale] = (localeVotes[result.value.detectedLocale] || 0) + 1;
        }
      } else {
        console.error(`❌ Chunk ${chunkNumber} permanently failed: ${result.reason?.message}`);
        failedChunks.push(chunkNumber);
      }
    });

    batch.forEach(chunk => {
      if (!chunk.isOriginal && fs.existsSync(chunk.filePath)) fs.unlinkSync(chunk.filePath);
    });

    completedChunks += batch.length;
    onProgress(
      Math.round((completedChunks / totalChunks) * 50),
      `Transcribed ${completedChunks} of ${totalChunks} chunks...`
    );
  }

  allWords.sort((a, b) => parseFloat(a.startTime) - parseFloat(b.startTime));
  fullText = fullText.trim();

  if (failedChunks.length === totalChunks) {
    return {
      status: "Error",
      fullText: "",
      wordTimestamps: [],
      partialFailure: false,
      failedChunks,
      error: "All chunks failed to transcribe.",
    };
  }

  // ── Step 2: Use Azure's own detected language ──
  // Azure Speech already told us which candidate locale it picked for
  // each chunk (see mapResultToWords / localeVotes above). Use whichever
  // locale "won" across chunks instead of paying for a second GPT call
  // to re-guess the language from the transcribed text.
  onProgress(52, "Detecting language...");
  let detectedLanguage = "English";

  const localesSeen = Object.keys(localeVotes);
  if (localesSeen.length > 0) {
    const winningLocale = localesSeen.reduce((best, locale) =>
      localeVotes[locale] > localeVotes[best] ? locale : best
    );
    detectedLanguage = LOCALE_TO_LANGUAGE[winningLocale] || "English";
    console.log(`[Transcribe] Using Azure's own detection: ${detectedLanguage} (${winningLocale}) — votes: ${JSON.stringify(localeVotes)}`);
  } else {
    // Fallback: Azure didn't report a locale on any chunk (older API
    // response shape, or languageIdentification disabled). Re-detect
    // from the transcribed text as before.
    console.warn("[Transcribe] Azure did not report a detected locale — falling back to GPT-based detection.");
    try {
      const result = await detectLanguageFromText(fullText);
      detectedLanguage = result.languageName;
    } catch (e) {
      console.warn("[Transcribe] Language detection failed:", e.message);
    }
  }

  // ── Step 3: Only translate if non-English ──
  // Skip translation entirely for English audio — no need to round-trip
  // through GPT just to get back the same text.
  let translatedWords = allWords;
  if (detectedLanguage.toLowerCase() === "english") {
    console.log("[Transcribe] English detected — skipping translation step.");
    onProgress(90, "Finalizing...");
  } else {
    onProgress(58, `Translating transcript to ${detectedLanguage}...`);
    try {
      translatedWords = await translateWordTimestamps(allWords, detectedLanguage);
      console.log(`[Transcribe] ✅ Translation complete. ${translatedWords.length} blocks.`);
    } catch (e) {
      console.error("[Transcribe] Translation failed, using raw transcript:", e.message);
      translatedWords = allWords;
    }
  }

  const translatedFullText = translatedWords.map(w => w.word).join(" ");

  onProgress(100, "Done!");
  console.log(`🏁 Transcription pipeline total: ⏱ ${((Date.now() - pipelineStart) / 1000).toFixed(1)}s`);

  if (failedChunks.length > 0) {
    console.warn(`⚠️ ${failedChunks.length} of ${totalChunks} chunks failed: [${failedChunks.join(", ")}]`);
  }

  return {
    status: "Success",
    fullText: translatedFullText,
    wordTimestamps: translatedWords,
    detectedLanguage,
    partialFailure: failedChunks.length > 0,
    failedChunks,
  };
}

module.exports = { transcribeAudioFile, resolveFfmpegPath };