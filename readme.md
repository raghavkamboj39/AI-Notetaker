# AI Notetaker

An Electron app that transcribes and summarizes audio using Azure Speech + Azure OpenAI.

## Prerequisites
- Node.js v18+
- npm v9+
- Azure Speech Service key and region
- Azure OpenAI key, endpoint, and deployment name

## Setup

1. Clone the repo
   git clone https://github.com/raghavkamboj39/AI-Notetaker.git
   cd AI-Notetaker

2. Install dependencies
   npm install

3. Create a .env file in the root folder
   AZURE_SPEECH_KEY=your_key
   AZURE_SPEECH_REGION=eastus
   AZURE_OPENAI_KEY=your_key
   AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
   AZURE_OPENAI_DEPLOYMENT=gpt-4o-mini

4. Run in development
   npx electron .

## Building Installers

Mac + Windows:
   npx electron-builder -mw

Windows only (run this first if building on Mac):
   npm install @ffmpeg-installer/win32-x64 --save --force
   npx electron-builder --win

Mac only:
   npx electron-builder --mac

## Installing

### Mac
1. Open the .dmg file from the dist/ folder
2. Drag AI Notetaker into Applications
3. Right-click the app and click Open on first launch

### Windows
1. Run AI Notetaker Setup 1.0.0.exe from the dist/ folder
2. Follow the installer steps
3. Launch from Start menu or desktop shortcut