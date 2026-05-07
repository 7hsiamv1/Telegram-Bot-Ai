import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { GoogleGenAI } from '@google/genai';
import { EventEmitter } from 'events';
import dotenv from 'dotenv';
import { CopilotClient } from './copilot.js';

dotenv.config();

process.on('uncaughtException', (err) => {
  console.error('CRITICAL: Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
});

const app = express();
app.use(express.json());

const PORT = 3000;
const logEmitter = new EventEmitter();

// In-memory storage for clients and sessions
interface BotSession {
  client: TelegramClient;
  phoneNumber: string;
  apiId: number;
  apiHash: string;
  isActive: boolean;
  isOffline?: boolean;
  offlineMessage?: string;
  rateLimitUntil?: number;
}

const activeBots: Map<string, BotSession> = new Map();
const pendingClients: Map<string, { client: TelegramClient, phoneCodeHash: string }> = new Map();

interface QAPair {
  id: string;
  phoneNumber: string;
  question: string;
  answer: string;
}

const FIREBASE_DB_URL = 'https://telegram-ai-2026-default-rtdb.firebaseio.com';

interface BotConfig {
  phoneNumber: string;
  apiId: number;
  apiHash: string;
  sessionString: string;
  isActive: boolean;
  isOffline: boolean;
  offlineMessage?: string;
}

let botConfigs: Map<string, BotConfig> = new Map();
let customQA: QAPair[] = [];

interface AiConfig {
  provider: 'gemini' | 'openrouter' | 'copilot';
  geminiKey: string;
  openRouterKey: string;
}

let aiConfig: AiConfig = {
  provider: 'copilot',
  geminiKey: '',
  openRouterKey: process.env.OPENROUTER_API_KEY || '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'
};

async function loadFirebaseData() {
  try {
    const qaRes = await fetch(`${FIREBASE_DB_URL}/customQA.json?t=${Date.now()}`, { cache: 'no-store' });
    const qaData = await qaRes.json();
    if (qaData) {
      customQA = Array.isArray(qaData) ? qaData : Object.values(qaData);
    }
    
    const configRes = await fetch(`${FIREBASE_DB_URL}/botConfigs.json?t=${Date.now()}`, { cache: 'no-store' });
    const configData = await configRes.json();
    if (configData) {
      const records = Object.values(configData) as BotConfig[];
      for (const config of records) {
        botConfigs.set(config.phoneNumber, config);
        restartBot(config);
      }
    }
    
    const aiConfRes = await fetch(`${FIREBASE_DB_URL}/aiConfig.json?t=${Date.now()}`, { cache: 'no-store' });
    const aiConfData = await aiConfRes.json();
    if (aiConfData) {
      aiConfig = { ...aiConfig, ...aiConfData };
    }
  } catch (err) {
    console.error('Failed to load data from Firebase:', err);
  }
}

async function saveQAData() {
  try {
    await fetch(`${FIREBASE_DB_URL}/customQA.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(customQA)
    });
  } catch (e) {
    console.error('Failed to save QA data to Firebase', e);
  }
}

async function saveBotConfigs() {
  try {
    const configArr = Array.from(botConfigs.values());
    await fetch(`${FIREBASE_DB_URL}/botConfigs.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(configArr)
    });
  } catch (e) {
    console.error('Failed to save bot configs to Firebase', e);
  }
}

async function saveAiConfig() {
  try {
    await fetch(`${FIREBASE_DB_URL}/aiConfig.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(aiConfig)
    });
  } catch (e) {
    console.error('Failed to save AI config to Firebase', e);
  }
}

async function restartBot(config: BotConfig) {
  try {
    const client = new TelegramClient(new StringSession(config.sessionString), config.apiId, config.apiHash, {
      connectionRetries: 100000,
      requestRetries: 5,
    });
    
    await client.connect();
    
    activeBots.set(config.phoneNumber, {
      client,
      phoneNumber: config.phoneNumber,
      apiId: config.apiId,
      apiHash: config.apiHash,
      isActive: config.isActive,
      isOffline: config.isOffline,
      offlineMessage: config.offlineMessage
    });
    
    broadcastLog('success', `Restored session for ${config.phoneNumber}`);
    installEventHandler(config.phoneNumber, client);
  } catch(err) {
    console.error(`Failed to restore session for ${config.phoneNumber}`, err);
  }
}

// Ensure startup data fetch
loadFirebaseData();

// Helper to log to SSE
function broadcastLog(type: 'info' | 'success' | 'error', message: string) {
  const logEntry = {
    timestamp: new Date().toLocaleTimeString(),
    type,
    message
  };
  logEmitter.emit('log', logEntry);
  console.log(`[${type.toUpperCase()}] ${message}`);
}

// Background poller to sync configs across multiple Cloud Run instances
setInterval(async () => {
  try {
    const aiConfRes = await fetch(`${FIREBASE_DB_URL}/aiConfig.json?t=${Date.now()}`, { cache: 'no-store' });
    const aiConfData = await aiConfRes.json();
    if (aiConfData) aiConfig = { ...aiConfig, ...aiConfData };

    const configRes = await fetch(`${FIREBASE_DB_URL}/botConfigs.json?t=${Date.now()}`, { cache: 'no-store' });
    const configData = await configRes.json();
    if (configData) {
      const records = Object.values(configData) as BotConfig[];
      for (const config of records) {
        const localBot = activeBots.get(config.phoneNumber);
        const localConfig = botConfigs.get(config.phoneNumber);
        if (localBot && localConfig) {
          localBot.isOffline = config.isOffline;
          localBot.isActive = config.isActive;
          localBot.offlineMessage = config.offlineMessage;
          localConfig.isOffline = config.isOffline;
          localConfig.isActive = config.isActive;
          localConfig.offlineMessage = config.offlineMessage;
        }
      }
    }
  } catch (err) {
    // Ignore fetch errors during polling
  }
}, 5000);

// AI Client Setup
import OpenAI from 'openai';

// Copilot singleton — one session shared across all requests
let copilotInstance: CopilotClient | null = null;
let copilotInitializing = false;

async function getCopilotClient(): Promise<CopilotClient> {
  if (copilotInstance) return copilotInstance;
  if (copilotInitializing) {
    // Wait until it finishes
    await new Promise<void>((res) => {
      const interval = setInterval(() => {
        if (!copilotInitializing) { clearInterval(interval); res(); }
      }, 100);
    });
    return copilotInstance!;
  }
  copilotInitializing = true;
  const c = new CopilotClient();
  await c.init();
  copilotInstance = c;
  copilotInitializing = false;
  broadcastLog('info', 'Copilot session initialized');
  return copilotInstance;
}

const SYSTEM_PROMPT = `You are an AI assistant replying on behalf of 7H SIAM. 
You must reply like a human in Bengali or English.
Strict Rules:
- If asked about name (e.g., 'তোমার নাম কী'), reply '7H SIAM'.
- If asked who created you (e.g., 'তোমাকে তৈরি করেছে কে'), reply '7H SIAM আমাকে তৈরি করেছে'.
- If asked when you were created (e.g., 'তোমাকে কবে তৈরি করা হয়েছে'), reply '21 April 2026 এ আমাকে 7H SIAM তৈরি করেছে'.
- If asked where is Siam (e.g., 'siam কই', '7H SIAM কই', 'সিয়াম কই'), reply 'আমার ডেভলপার মানে 7H SIAM বর্তমানে অফলাইনে আছেন, তাই এখন আমি তার পরিবর্তে সবকিছু সামলাচ্ছি।'
- Keep replies concise and helpful.`;

async function getAiReply(text: string, customQA: QAPair[] = []) {
  try {
    let prompt = SYSTEM_PROMPT;
    if (customQA.length > 0) {
      const normalizedText = text.trim().toLowerCase();
      for (const qa of customQA) {
        const qText = qa.question.trim().toLowerCase();
        if (qText && (normalizedText === qText || (qText.length > 5 && normalizedText.includes(qText)))) {
          return qa.answer; // fast-path for matching QA
        }
      }

      prompt += '\n\nAdditionally, you must strictly follow these custom Q&A pairs. If the user asks something matching or similar to a question below, reply with the exact answer provided:\n';
      customQA.forEach((qa, index) => {
        prompt += `${index + 1}. Q: "${qa.question}" -> A: "${qa.answer}"\n`;
      });
    }

    const callOpenRouter = async () => {
      const orAI = new OpenAI({
        apiKey: aiConfig.openRouterKey || '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',
        baseURL: 'https://openrouter.ai/api/v1',
      });
      const response = await orAI.chat.completions.create({
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: prompt + '\nNote: Reply as short and concise as possible for ultra-fast response time. Maximum 1-2 sentences unless specifically asked for details.' },
          { role: 'user', content: text }
        ],
        max_tokens: 150,
        temperature: 0.7
      });
      return response.choices[0]?.message?.content || 'Sorry, I am busy right now.';
    };

    const callGeminiNative = async () => {
      if (!aiConfig.geminiKey) throw new Error('Gemini API Key is missing.');
      const gGenAI = new GoogleGenAI({ apiKey: aiConfig.geminiKey });
      const response = await gGenAI.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: text,
        config: {
          systemInstruction: prompt + '\nNote: Reply as short and concise as possible for ultra-fast response time. Maximum 1-2 sentences unless specifically asked for details.',
          temperature: 0.7,
          maxOutputTokens: 150
        }
      });
      return response.text || 'Sorry, I am busy right now.';
    };

    const callCopilot = async () => {
      const client = await getCopilotClient();
      const fullPrompt = `${prompt}\n\nUser: ${text}`;
      const result = await client.ask(fullPrompt);
      return result.text || 'Sorry, I am busy right now.';
    };

    try {
      if (aiConfig.provider === 'copilot') {
        return await callCopilot();
      } else if (aiConfig.provider === 'gemini') {
        return await callGeminiNative();
      } else {
        return await callOpenRouter();
      }
    } catch (primaryError: any) {
      broadcastLog('error', `Primary AI failed (${aiConfig.provider}): ${primaryError.message}. Trying fallback...`);
      try {
        if (aiConfig.provider === 'copilot' || aiConfig.provider === 'gemini') {
          return await callOpenRouter();
        } else {
          return await callGeminiNative();
        }
      } catch (fallbackError: any) {
        broadcastLog('error', `Fallback AI also failed: ${fallbackError.message}`);
        throw fallbackError;
      }
    }
  } catch (error) {
    broadcastLog('error', `AI Error: ${error instanceof Error ? error.message : String(error)}`);
    return 'আমি এখন একটু ব্যস্ত আছ, দয়া করে একটু পর মেসেজ দিন। (AI Error)';
  }
}


// API Routes
app.get('/api/keepalive', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.post('/api/bot/send-code', async (req, res) => {
  const { apiId, apiHash, phoneNumber } = req.body;
  
  if (!apiId || !apiHash || !phoneNumber) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const client = new TelegramClient(new StringSession(''), Number(apiId), apiHash, {
      connectionRetries: 100000,
      requestRetries: 5,
    });

    await client.connect();
    const result = await client.sendCode(
      { apiId: Number(apiId), apiHash },
      phoneNumber
    );

    pendingClients.set(phoneNumber, { client, phoneCodeHash: result.phoneCodeHash });
    broadcastLog('info', `OTP code sent to ${phoneNumber}`);
    res.json({ success: true, phoneCodeHash: result.phoneCodeHash });
  } catch (error) {
    broadcastLog('error', `Failed to send code: ${error instanceof Error ? error.message : String(error)}`);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Internal Server Error' });
  }
});

app.post('/api/bot/verify', async (req, res) => {
  const { phoneNumber, code, apiId, apiHash } = req.body;
  const pending = pendingClients.get(phoneNumber);

  if (!pending) {
    return res.status(400).json({ error: 'No pending connection for this phone number' });
  }

  const { client, phoneCodeHash } = pending;

  try {
    const result = await client.invoke(new Api.auth.SignIn({
      phoneNumber,
      phoneCodeHash,
      phoneCode: code
    }));

    if (result instanceof Api.auth.AuthorizationSignUpRequired) {
      throw new Error('SIGNUP_REQUIRED: Account does not exist yet.');
    }

    const sessionString = client.session.save() as unknown as string;
    startBot(phoneNumber, client, apiId, apiHash, sessionString);
    pendingClients.delete(phoneNumber);
    
    broadcastLog('success', `Login successful for ${phoneNumber}`);
    res.json({ success: true, session: sessionString });
  } catch (error: any) {
    if (error.errorMessage === 'SESSION_PASSWORD_NEEDED' || (error.message && error.message.includes('SESSION_PASSWORD_NEEDED'))) {
      return res.status(200).json({ requiresPassword: true });
    }
    broadcastLog('error', `Verification failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bot/password', async (req, res) => {
  const { phoneNumber, password, apiId, apiHash } = req.body;
  const pending = pendingClients.get(phoneNumber);

  if (!pending) {
    return res.status(400).json({ error: 'No pending connection for this phone number' });
  }

  const { client } = pending;

  try {
    await client.signInWithPassword(
      { apiId: Number(apiId), apiHash },
      {
        password: async () => password,
        onError: (err: any) => { throw err; }
      }
    );

    const sessionString = client.session.save() as unknown as string;
    startBot(phoneNumber, client, apiId, apiHash, sessionString);
    pendingClients.delete(phoneNumber);
    
    broadcastLog('success', `2FA Login successful for ${phoneNumber}`);
    res.json({ success: true, session: sessionString });
  } catch (error: any) {
    broadcastLog('error', `2FA failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/bot/status', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  console.log('GET /api/bot/status called');
  const bots = Array.from(activeBots.entries()).map(([phone, bot]) => ({
    phoneNumber: phone,
    isActive: bot.isActive,
    isOffline: bot.isOffline,
    offlineMessage: bot.offlineMessage
  }));
  res.json({ bots });
});

app.get('/api/bot/ai-config', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ aiConfig });
});

app.post('/api/bot/ai-config', (req, res) => {
  const { provider, geminiKey, openRouterKey } = req.body;
  if (provider) aiConfig.provider = provider;
  if (geminiKey !== undefined) aiConfig.geminiKey = geminiKey;
  if (openRouterKey !== undefined) aiConfig.openRouterKey = openRouterKey;
  saveAiConfig();
  broadcastLog('info', `AI Configuration updated (Provider: ${aiConfig.provider})`);
  res.json({ success: true, aiConfig });
});

app.post('/api/bot/toggle-offline', (req, res) => {
  const { phoneNumber, isOffline } = req.body;
  const bot = activeBots.get(phoneNumber);
  const config = botConfigs.get(phoneNumber);
  if (bot && config) {
    bot.isOffline = isOffline;
    config.isOffline = isOffline;
    saveBotConfigs();
    broadcastLog('info', `Offline mode set to ${isOffline ? 'ON' : 'OFF'} for ${phoneNumber}`);
    res.json({ success: true, isOffline });
  } else {
    res.status(404).json({ error: 'Bot not found' });
  }
});

app.post('/api/bot/update-offline-message', (req, res) => {
  const { phoneNumber, message } = req.body;
  const bot = activeBots.get(phoneNumber);
  const config = botConfigs.get(phoneNumber);
  if (bot && config) {
    bot.offlineMessage = message;
    config.offlineMessage = message;
    saveBotConfigs();
    broadcastLog('info', `Offline message updated for ${phoneNumber}`);
    res.json({ success: true, offlineMessage: message });
  } else {
    res.status(404).json({ error: 'Bot not found' });
  }
});

app.post('/api/bot/stop', async (req, res) => {
  const { phoneNumber } = req.body;
  const bot = activeBots.get(phoneNumber);

  if (bot) {
    await bot.client.disconnect();
    activeBots.delete(phoneNumber);
    botConfigs.delete(phoneNumber);
    saveBotConfigs();
    broadcastLog('info', `Bot stopped for ${phoneNumber}`);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Bot not found' });
  }
});

app.post('/api/bot/toggle', (req, res) => {
  const { phoneNumber, isActive } = req.body;
  const bot = activeBots.get(phoneNumber);
  const config = botConfigs.get(phoneNumber);

  if (bot && config) {
    // If client passes an explicit boolean, use it. Otherwise, fallback to toggle behavior
    const targetState = typeof isActive === 'boolean' ? isActive : !bot.isActive;
    bot.isActive = targetState;
    config.isActive = targetState;
    saveBotConfigs();
    broadcastLog('info', `Bot for ${phoneNumber} is now ${targetState ? 'RUNNING' : 'PAUSED'}`);
    res.json({ success: true, isActive: targetState });
  } else {
    res.status(404).json({ error: 'Bot not found' });
  }
});

app.get('/api/bot/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable buffering for Nginx

  const onLog = (log: any) => {
    res.write(`data: ${JSON.stringify(log)}\n\n`);
  };

  logEmitter.on('log', onLog);

  // Heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 10000);

  req.on('close', () => {
    clearInterval(heartbeat);
    logEmitter.off('log', onLog);
  });
});

// QA Endpoints
app.get('/api/bot/qa', (req, res) => {
  res.json({ success: true, qa: customQA });
});

app.post('/api/bot/qa', (req, res) => {
  const { question, answer, phoneNumber } = req.body;
  if (!question || !answer || !phoneNumber) {
    return res.status(400).json({ error: 'Question, answer, and phoneNumber are required' });
  }
  const newQa = { id: Date.now().toString(), phoneNumber, question, answer };
  customQA.push(newQa);
  saveQAData();
  broadcastLog('info', `Added custom QA for ${phoneNumber}: "${question}"`);
  res.json({ success: true, qa: customQA });
});

app.delete('/api/bot/qa/:id', (req, res) => {
  const { id } = req.params;
  const initialLength = customQA.length;
  customQA = customQA.filter(q => q.id !== id);
  if (customQA.length < initialLength) {
    saveQAData();
    broadcastLog('info', `Deleted custom QA pair`);
    res.json({ success: true, qa: customQA });
  } else {
    res.status(404).json({ error: 'QA pair not found' });
  }
});

function installEventHandler(phoneNumber: string, client: TelegramClient) {
  client.addEventHandler(async (event: any) => {
    // Check if the bot for this phone number is currently active
    const botSession = activeBots.get(phoneNumber);
    if (!botSession || !botSession.isActive) {
      return;
    }

    try {
      const message = event.message;
      if (!message || message.isOut || !message.message) {
        return;
      }

      const isPrivate = message.peerId.className === 'PeerUser';
      const isMention = message.mentioned;

      // To prevent severe rate-limiting and spam, only auto-reply in Private Chats (Inbox)
      // or if explicitly mentioned in a group.
      if (!isPrivate && !isMention) {
        return;
      }

      if (botSession.rateLimitUntil && Date.now() < botSession.rateLimitUntil) {
        return; // Bot is currently under a global FloodWait rate limit
      }

      if (!botSession.isOffline && botSession.isActive) {
        // Mark as read immediately and show typing indicator
        client.markAsRead(message.peerId).catch(() => {});
        client.invoke(new Api.messages.SetTyping({
          peer: message.peerId,
          action: new Api.SendMessageTypingAction()
        })).catch(() => {});
      }

      let replyPromise: Promise<string | null>;
      if (botSession.isOffline) {
        if (!isPrivate) {
          return; // Only reply to private DMs in offline mode
        }
        replyPromise = Promise.resolve(botSession.offlineMessage || `💤আসসালামু আলাইকুম 💥\n✅দয়া করে আপনার মূল্যবান মেসেজটি লিখে রাখুন, আমি অনলাইনে আসলে কথা বলব 🔥\n-Auto Ai🤖\n7H SIAM Owners এখন OFF লাইনে আছে\nলাইনে আসলে মেসেজ করুন`);
      } else {
        const botQA = customQA.filter(q => q.phoneNumber === botSession.phoneNumber);
        replyPromise = getAiReply(message.message, botQA);
      }

      replyPromise.then(async (reply) => {
        if (!reply || !botSession.isActive) return;
        try {
          // Attempt to reply as fast as possible
          await client.sendMessage(message.peerId, { message: reply, replyTo: message.id });
          broadcastLog('success', `Replied sent successfully`);
        } catch (sendError: any) {
          const errMsg = sendError.message || String(sendError);
          if (errMsg.includes('A wait of')) {
            const waitMatch = errMsg.match(/A wait of (\d+) seconds/);
            const waitSeconds = waitMatch ? parseInt(waitMatch[1], 10) : 60;
            botSession.rateLimitUntil = Date.now() + (waitSeconds * 1000);
            broadcastLog('error', `Rate limited: ${errMsg}. Bot pausing for ${waitSeconds}s.`);
          } else if (errMsg.includes('CHAT_ADMIN_REQUIRED')) {
            broadcastLog('error', `Permission denied (Admin required)`);
          } else {
            broadcastLog('error', `Failed to reply: ${errMsg}`);
          }
        }
      }).catch(err => {
        broadcastLog('error', `AI processing error: ${err.message}`);
      });
      
      // Async log the incoming message to avoid blocking the reply
      message.getSender().then(sender => {
        const senderName = sender?.firstName || 'User';
        broadcastLog('info', `Message from ${senderName}: ${message.message.substring(0, 50)}...`);
      }).catch(() => {});
    } catch (handlerError) {
      broadcastLog('error', `Handler Error: ${handlerError instanceof Error ? handlerError.message : String(handlerError)}`);
    }
  }, new NewMessage({}));
}

function startBot(phoneNumber: string, client: TelegramClient, apiId: number, apiHash: string, sessionString: string) {
  // Clear any existing client for this number to prevent orphaned clients
  const existingBot = activeBots.get(phoneNumber);
  if (existingBot) {
    existingBot.client.disconnect()
      .catch(err => console.error(`Failed to disconnect old client for ${phoneNumber}`, err));
  }

  activeBots.set(phoneNumber, {
    client,
    phoneNumber,
    apiId,
    apiHash,
    isActive: true,
    isOffline: false
  });

  botConfigs.set(phoneNumber, {
    phoneNumber,
    apiId,
    apiHash,
    sessionString,
    isActive: true,
    isOffline: false
  });
  saveBotConfigs();

  broadcastLog('info', `Auto-responder active for ${phoneNumber}`);
  installEventHandler(phoneNumber, client);
}

// Vite and Server setup
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
    broadcastLog('info', '7H SIAM Bot Dashboard Started');
  });
}

// Global Error Handlers to prevent crashes
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION at:', promise, 'reason:', reason);
});

startServer();
