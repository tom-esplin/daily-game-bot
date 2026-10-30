import { withProgress } from './daily-player-log.js';

export class LocalAudioListener {
  constructor(settings, { fetchImpl = fetch, log } = {}) {
    const url = new URL(settings.localAudioUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('The local audio URL must be an HTTP loopback address without credentials or a path.');
    }
    this.url = url.origin;
    this.model = settings.localAudioModel;
    this.fetch = fetchImpl;
    this.log = log;
  }

  async request(path, options, signal) {
    return withProgress(this.log, `Local audio ${path}`, async () => {
      let response;
      try {
        response = await this.fetch(`${this.url}${path}`, { ...options, signal });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error('Local audio listener unavailable. Set up local-audio/.venv and start npm run daily:audio. See README.md.');
      }
      if (!response.ok) throw new Error(`Local audio listener failed (HTTP ${response.status}). Check its terminal for diagnostics.`);
      this.log?.(`Local audio HTTP ${response.status}; reading response body`);
      return response.json();
    });
  }

  async preflight(signal) {
    const result = await this.request('/health', {}, signal);
    if (result.status !== 'ready' || result.model !== this.model) throw new Error('Local audio listener is not ready with the configured model.');
  }

  async listen(wav, signal) {
    const result = await this.request('/listen', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: wav.toString('base64') }),
    }, signal);
    if (result.model !== this.model || typeof result.text !== 'string' || !result.text.trim()) {
      throw new Error('Local audio listener returned an invalid assessment.');
    }
    return { text: result.text.slice(0, 4000), usage: result.usage ?? {} };
  }
}
