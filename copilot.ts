import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';
import WebSocket from 'ws';

export class CopilotClient {
  private session: { cookies: Record<string, string> };
  private clientId: string;
  private conversationId: string | null = null;
  private cookieHeader: string = '';

  constructor() {
    this.session = { cookies: {} };
    this.clientId = uuidv4();
  }

  async init() {
    await this._startConversation();
  }

  private async _startConversation() {
    const url = 'https://copilot.microsoft.com/c/api/start';

    const payload = {
      timeZone: 'Asia/Kolkata',
      startNewConversation: true,
      teenSupportEnabled: true,
      correctPersonalizationSetting: true,
      deferredDataUseCapable: true
    };

    const headers: Record<string, string> = {
      'User-Agent': 'CopilotNative/30.0.440421003-prod (Android 11; Google; sdk_gphone_arm64)',
      'Content-Type': 'application/json',
      'X-Search-UILang': 'en-US'
    };

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    // Collect set-cookie headers
    const rawCookies = res.headers.raw()['set-cookie'] || [];
    for (const c of rawCookies) {
      const [pair] = c.split(';');
      const [k, v] = pair.split('=');
      if (k && v) this.session.cookies[k.trim()] = v.trim();
    }
    this.cookieHeader = Object.entries(this.session.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

    const data = (await res.json()) as any;
    this.conversationId = data.currentConversationId;
  }

  ask(message: string): Promise<{ text: string; message_id: string | null }> {
    return new Promise((resolve, reject) => {
      const wsUrl = `wss://copilot.microsoft.com/c/api/chat?api-version=2&clientSessionId=${this.clientId}`;

      const result: { text: string; message_id: string | null } = {
        text: '',
        message_id: null
      };

      const ws = new WebSocket(wsUrl, {
        headers: {
          Cookie: this.cookieHeader,
          'User-Agent': 'CopilotNative/30.0.440421003-prod (Android 11; Google; sdk_gphone_arm64)',
          'X-Search-UILang': 'en-US'
        }
      });

      ws.on('open', () => {
        const options = {
          event: 'setOptions',
          supportedCards: [
            'createCalendarEvent', 'consentV2', 'finance', 'flashcard',
            'image', 'local', 'personalArtifacts', 'quiz', 'recipe',
            'safetyHelpline', 'sports', 'tapToReveal', 'video', 'navigation'
          ],
          supportedActions: [],
          supportedFeatures: [
            'composer-prefill-conversation-action',
            'composer-send-conversation-action-v2',
            'short-conversation-action',
            'session-duration-nudge'
          ]
        };

        ws.send(JSON.stringify(options));
        ws.send(JSON.stringify(options));

        ws.send(JSON.stringify({
          event: 'send',
          content: [{ type: 'text', text: message }],
          conversationId: this.conversationId
        }));
      });

      ws.on('message', (raw: WebSocket.RawData) => {
        try {
          const data = JSON.parse(raw.toString()) as any;

          if (data.event === 'startMessage') {
            result.message_id = data.messageId;
          } else if (data.event === 'appendText') {
            if (data.messageId === result.message_id) {
              result.text += data.text || '';
            }
          } else if (data.event === 'done') {
            ws.close();
            resolve(result);
          }
        } catch (_) {}
      });

      ws.on('error', (err) => {
        reject(err);
      });

      ws.on('close', () => {
        if (!result.text) resolve(result);
      });
    });
  }
}
