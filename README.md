# 7H SIAM Telegram AI Bot — Copilot Edition

Telegram auto-responder with **Microsoft Copilot** as the primary AI (no API key needed), Gemini & OpenRouter as fallbacks.

---

## ✨ Features
- **Microsoft Copilot** integration (free, no key required)
- Gemini / OpenRouter fallback
- Custom Q&A pairs per phone number
- Offline mode with custom message
- Firebase Realtime DB for persistent config
- React dashboard UI

---

## 🚀 Deploy to Render via GitHub

### Step 1 — Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit — 7H SIAM Copilot Bot"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### Step 2 — Create Render Web Service

1. Go to https://render.com → New → Web Service
2. Connect your GitHub repo
3. Render auto-detects render.yaml — confirm:
   - Build Command: npm install && npm run build
   - Start Command: npm run start
4. Add Environment Variables (optional fallback AIs):
   - OPENROUTER_API_KEY
   - GEMINI_API_KEY
5. Click Deploy

> Copilot is default and needs NO API key.

---

## 🏃 Run Locally

```bash
npm install
npm run dev
```
Open: http://localhost:3000

---

## ⚙️ AI Provider Priority

| Priority | Provider              | Key Required |
|----------|-----------------------|-------------|
| 1st      | Microsoft Copilot     | No          |
| 2nd      | OpenRouter            | Yes         |
| 3rd      | Gemini Native         | Yes         |

Switch providers from Dashboard → AI Config panel.

---

## 📁 New Files Added

- copilot.ts    — Microsoft Copilot WebSocket client (unchanged logic from original Python)
- render.yaml   — Render deployment config
