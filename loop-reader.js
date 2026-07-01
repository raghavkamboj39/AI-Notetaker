const { PublicClientApplication } = require("@azure/msal-node");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const zlib = require("zlib");
const { app } = require("electron");

const CLIENT_ID = "3d968b76-2b53-47dd-8ccc-ebb2a2d8f30a";
const AUTHORITY = "https://login.microsoftonline.com/common";
const SCOPES = ["Files.Read", "Files.Read.All", "User.Read"];
const TOKEN_CACHE_PATH = path.join(app.getPath("userData"), "msal-token-cache.json");

function getCachePlugin() {
  return {
    beforeCacheAccess: async (cacheContext) => {
      if (fs.existsSync(TOKEN_CACHE_PATH)) {
        cacheContext.tokenCache.deserialize(fs.readFileSync(TOKEN_CACHE_PATH, "utf8"));
      }
    },
    afterCacheAccess: async (cacheContext) => {
      if (cacheContext.cacheHasChanged) {
        fs.writeFileSync(TOKEN_CACHE_PATH, cacheContext.tokenCache.serialize());
      }
    },
  };
}

function createMsalApp() {
  return new PublicClientApplication({
    auth: { clientId: CLIENT_ID, authority: AUTHORITY },
    cache: { cachePlugin: getCachePlugin() },
  });
}

async function getTokenSilentOrNull() {
  try {
    const msalApp = createMsalApp();
    const accounts = await msalApp.getTokenCache().getAllAccounts();
    if (accounts.length === 0) return null;
    const result = await msalApp.acquireTokenSilent({ scopes: SCOPES, account: accounts[0] });
    return { token: result.accessToken, username: accounts[0].username };
  } catch (e) {
    return null;
  }
}

function startDeviceCodeFlow(onDeviceCode, onSuccess, onError) {
  const msalApp = createMsalApp();
  msalApp.acquireTokenByDeviceCode({
    scopes: SCOPES,
    deviceCodeCallback: (response) => {
      onDeviceCode({
        userCode: response.userCode,
        verificationUri: response.verificationUri,
        message: response.message,
      });
    },
  }).then(result => {
    if (result) onSuccess({ token: result.accessToken, username: result.account?.username });
  }).catch(onError);
}

async function signOut() {
  try {
    if (fs.existsSync(TOKEN_CACHE_PATH)) fs.unlinkSync(TOKEN_CACHE_PATH);
    return true;
  } catch (e) {
    return false;
  }
}

async function listLoopFiles(token) {
  const response = await axios.get(
    "https://graph.microsoft.com/v1.0/me/drive/root/search(q='.loop')?$select=id,name,lastModifiedDateTime,size,webUrl&$top=50",
    { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
  );
  return (response.data.value || []).filter(f => f.name.endsWith(".loop"));
}

async function readLoopFileContent(token, itemId, fileName) {
  const contentRes = await axios.get(
    `https://graph.microsoft.com/v1.0/me/drive/items/${itemId}/content`,
    {
      headers: { Authorization: `Bearer ${token}` },
      responseType: "arraybuffer",
      timeout: 30000,
      maxRedirects: 5,
    }
  );
  const buffer = Buffer.from(contentRes.data);
  return extractTextFromLoopBuffer(buffer, fileName);
}

/**
 * Extract readable text from a Microsoft Loop (.loop) file.
 *
 * Loop files use the Fluid Framework binary format (Microsoft Prague/Prague 0.2.1).
 * Document content is stored as gzip-compressed streams of Fluid ops (operations).
 * Each op may contain SharedString text segments encoded as escaped JSON strings
 * with the pattern: \"text\":\"<actual content>\".
 *
 * Strategy:
 * 1. Scan the buffer for all gzip magic bytes (0x1f 0x8b).
 * 2. Decompress each stream found.
 * 3. Within each decompressed blob, extract all escaped \"text\":\"...\" values.
 * 4. Filter to meaningful human-readable segments (min 3 words, mostly alpha).
 * 5. Deduplicate and join.
 */
function extractTextFromLoopBuffer(buffer, fileName) {
  const segments = [];

  // Find every gzip stream in the buffer
  for (let i = 0; i < buffer.length - 2; i++) {
    if (buffer[i] !== 0x1f || buffer[i + 1] !== 0x8b) continue;

    try {
      // Decompress up to 512KB per stream to avoid memory issues
      const slice = buffer.slice(i, Math.min(i + 600000, buffer.length));
      let decompressed;
      try {
        decompressed = zlib.gunzipSync(slice);
      } catch {
        // Partial stream at end of file — skip
        continue;
      }

      if (decompressed.length < 20) continue;

      const text = decompressed.toString("utf8");

      // Extract escaped text segments: \"text\":\"<content>\"
      // These appear inside doubly-escaped JSON ops (\\\"text\\\":\\\"...\\\")
      const PATTERNS = [
        /\\\\\"text\\\\\":\\\\\"((?:[^\\\\]|\\\\(?!\\\\))*?)(?=\\\\\")/g,
        /\\\"text\\\":\\\"((?:[^\\\\]|\\.)*?)(?=\\\")/g,
        /"text":"((?:[^"\\]|\\.)*?)"/g,
      ];

      for (const pattern of PATTERNS) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
          const raw = match[1]
            .replace(/\\\\n/g, "\n")
            .replace(/\\\\t/g, " ")
            .replace(/\\\\"/g, '"')
            .replace(/\\\\/g, "")
            .replace(/\\n/g, "\n")
            .replace(/\\t/g, " ")
            .replace(/\\"/g, '"')
            .trim();

          if (raw.length >= 4 && isMeaningful(raw)) {
            segments.push(raw);
          }
        }
      }
    } catch {
      // Silently skip bad streams
    }
  }

  // Deduplicate while preserving insertion order
  const seen = new Set();
  const unique = segments.filter(s => {
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });

  // Strip the boilerplate disclaimer Loop always injects
  const BOILERPLATE = new Set([
    "AI-generated content in notes may be incorrect.",
    "Learn more",
  ]);
  const content = unique.filter(s => !BOILERPLATE.has(s));

  if (!content.length) {
    return (
      `[Loop file: ${fileName}]\n\n` +
      `Could not extract text from this Loop file. ` +
      `Please paste the content manually using the Paste text tab.`
    );
  }

  return `[From Loop: ${fileName}]\n\n${content.join("\n")}`;
}

/**
 * Returns true if a string looks like human-readable natural language.
 * Requires at least 3 words that start with a letter and mostly alphabetic content.
 */
function isMeaningful(s) {
  const words = s.split(/\s+/).filter(w => /^[A-Za-z\u0900-\u097F\u0600-\u06FF]/.test(w));
  if (words.length < 2) return false;
  const alpha = (s.match(/[A-Za-z\u0900-\u097F\u0600-\u06FF\s]/g) || []).length;
  return alpha / s.length > 0.5;
}

/**
 * Extract text from a .loop file already on disk (used for zip uploads).
 */
function extractTextFromLoopFile(filePath, fileName) {
  try {
    const buffer = fs.readFileSync(filePath);
    return extractTextFromLoopBuffer(buffer, fileName);
  } catch (e) {
    return `[Loop file: ${fileName}]\n\nFailed to read file: ${e.message}`;
  }
}

module.exports = {
  getTokenSilentOrNull,
  startDeviceCodeFlow,
  signOut,
  listLoopFiles,
  readLoopFileContent,
  extractTextFromLoopBuffer,
  extractTextFromLoopFile,
};