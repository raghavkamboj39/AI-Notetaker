# AI Notetaker

An Electron app that transcribes and summarizes audio using Azure Speech + Azure OpenAI. Supports recording, file upload, Microsoft Loop integration, and paste text.

---

## Features

- 🎙️ Record audio directly in the app
- 📁 Upload audio/video files (mp3, mp4, wav, m4a, webm, etc.)
- 📋 Paste text directly for summarization
- 🔗 Microsoft Loop / OneDrive integration
- 🌐 Multi-language transcription and translation
- 🤖 AI-generated meeting notes, key points, action items, and decisions

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or higher
- npm v9 or higher
- Azure Speech Service key and region
- Azure OpenAI key, endpoint, and deployment

---

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/raghavkamboj39/AI-Notetaker.git
cd AI-Notetaker
```

### 2. Install dependencies

```bash
npm install
```

### 3. Create your `.env` file

Create a file called `.env` in the root of the project with the following:

```
AZURE_SPEECH_KEY=your_azure_speech_key
AZURE_SPEECH_REGION=your_azure_speech_region
AZURE_OPENAI_KEY=your_azure_openai_key
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_DEPLOYMENT=your_deployment_name
AZURE_STORAGE_ACCOUNT_KEY=your_storage_account_key
AZURE_STORAGE_CONNECTION_STRING=your_storage_connection_string
```

### 4. Run in development mode

```bash
npx electron .
```

---

## Building Installers

### Build for both Mac and Windows

```bash
npx electron-builder -mw
```

### Build for Mac only

```bash
npx electron-builder --mac
```

### Build for Windows only

```bash
npx electron-builder --win
```

> **Note for Windows builds on Mac:** Run this first to install the Windows ffmpeg binary:
> ```bash
> npm install @ffmpeg-installer/win32-x64 --save --force
> ```

### Output files (in `dist/` folder)

| File | Platform |
|------|----------|
| `AI Notetaker Setup 1.0.0.exe` | Windows |
| `AI Notetaker-1.0.0-arm64.dmg` | Mac (M1/M2) |
| `AI Notetaker-1.0.0.dmg` | Mac (Intel) |

---

## Installing the App

### Mac
1. Open the `.dmg` file from the `dist/` folder
2. Drag **AI Notetaker** into your **Applications** folder
3. Right-click the app → **Open** (first launch only, to bypass Gatekeeper)

### Windows
1. Run `AI Notetaker Setup 1.0.0.exe` from the `dist/` folder
2. Follow the installer steps
3. Launch **AI Notetaker** from the Start menu or desktop shortcut

---

## Tech Stack

- [Electron](https://www.electronjs.org/)
- [Azure Speech to Text](https://azure.microsoft.com/en-us/products/ai-services/speech-to-text)
- [Azure OpenAI](https://azure.microsoft.com/en-us/products/ai-services/openai-service)
- [Microsoft Graph API](https://learn.microsoft.com/en-us/graph/overview) (Loop/OneDrive integration)
- [ffmpeg](https://ffmpeg.org/) via `@ffmpeg-installer/ffmpeg`