import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseDailyResult, visibleCodenamesShare } from './daily-results.js';
import { withProgress } from './daily-player-log.js';

// This script observes only player-visible sharing and rendered audio. It never reads app state.
export function installPlayerCapture() {
  const captured = { share: '', audio: null, media: null };
  Object.defineProperty(window, '__dailyPlayerCapture', { value: captured });
  if (navigator.clipboard) {
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (text) => {
      captured.share = String(text).slice(0, 5000);
    } });
  }
  Object.defineProperty(navigator, 'share', { configurable: true, value: async (data) => {
    captured.share = [data.title, data.text, data.url].filter(Boolean).join('\n').slice(0, 5000);
  } });
  // Also observe older games' copy-event / execCommand sharing paths.
  document.addEventListener('copy', (event) => {
    setTimeout(() => {
      const text = event.clipboardData?.getData('text/plain');
      if (text) captured.share = text.slice(0, 5000);
    }, 0);
  });
  const execCommand = document.execCommand?.bind(document);
  if (execCommand) document.execCommand = (command, ...args) => {
    if (command.toLowerCase() === 'copy') {
      const active = document.activeElement;
      const selected = window.getSelection()?.toString() || (typeof active?.value === 'string'
        ? active.value.slice(active.selectionStart ?? 0, active.selectionEnd ?? active.value.length) : '');
      if (selected) captured.share = selected.slice(0, 5000);
    }
    return execCommand(command, ...args);
  };
  let cleanup = () => {};
  const handledEvents = new WeakSet();
  const playing = (event) => {
    if (handledEvents.has(event)) return;
    handledEvents.add(event);
    const media = event.target;
    if (!(media instanceof HTMLMediaElement)) return;
    cleanup();
    captured.media = media;
    const audio = { samples: [], sampleRate: 0, error: null, source: media.currentSrc,
      startTime: media.currentTime, startedAt: Date.now() };
    captured.audio = audio;
    let context;
    let processor;
    let stream;
    let stopped = false;
    cleanup = () => {
      stopped = true;
      if (processor) processor.disconnect();
      // Do not stop cloned media tracks: that could interrupt the game's playback.
      if (context) void context.close();
    };
    void (async () => {
      try {
        const capture = media.captureStream || media.mozCaptureStream;
        if (!capture) throw new Error('Browser does not support media captureStream.');
        stream = capture.call(media);
        for (let attempt = 0; !stream.getAudioTracks().length && attempt < 20; attempt++) {
          await new Promise((done) => setTimeout(done, 100));
        }
        if (stopped) return;
        if (!stream.getAudioTracks().length) throw new Error('The playable clip has no capturable audio track.');
        context = new AudioContext();
        await context.resume();
        if (stopped) { await context.close(); return; }
        audio.sampleRate = context.sampleRate;
        const source = context.createMediaStreamSource(stream);
        processor = context.createScriptProcessor(4096, 2, 1);
        processor.onaudioprocess = ({ inputBuffer }) => {
          if (audio.samples.length >= audio.sampleRate * 12) return;
          const channels = Array.from({ length: inputBuffer.numberOfChannels }, (_, i) => inputBuffer.getChannelData(i));
          for (let i = 0; i < inputBuffer.length && audio.samples.length < audio.sampleRate * 12; i++) {
            audio.samples.push(channels.reduce((sum, channel) => sum + channel[i], 0) / channels.length);
          }
        };
        const muted = context.createGain();
        muted.gain.value = 0;
        source.connect(processor); processor.connect(muted); muted.connect(context.destination);
      } catch (error) { audio.error = error.message; }
    })();
  };
  document.addEventListener('playing', playing, true);
  // new Audio() elements need not be attached to the DOM, so document events alone miss them.
  const observed = new WeakSet();
  const originalPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    if (!observed.has(this)) { this.addEventListener('playing', playing); observed.add(this); }
    return originalPlay.apply(this, args);
  };
}

export function encodeWav(samples, sampleRate) {
  if (!Array.isArray(samples) || !samples.length || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000
      || samples.length > sampleRate * 12 || samples.some((value) => !Number.isFinite(value))) {
    throw new Error('Invalid captured audio.');
  }
  const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
  if (rms < 0.00001) throw new Error('The captured audio is silent.');
  const wav = Buffer.alloc(44 + samples.length * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, index) => wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), 44 + index * 2));
  return wav;
}

const width = 1024;
const height = 768;
const keys = new Set(['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

export async function capturePlayableAudio(page, observedAudio = new Map(), log) {
  await withProgress(log, 'Wait for six seconds of playable audio (15s timeout)', () => page.waitForFunction(() => {
    const audio = window.__dailyPlayerCapture?.audio;
    return audio && ((audio.sampleRate && audio.samples.length >= audio.sampleRate * 6)
      || (audio.error && Date.now() - audio.startedAt >= 6000));
  }, null, { timeout: 15000 }));
  const audio = await withProgress(log, 'Read captured audio samples', () => page.evaluate(() => window.__dailyPlayerCapture.audio));
  if (!audio.error) {
    log?.(`Audio captured: ${audio.samples.length} samples at ${audio.sampleRate} Hz`);
    return encodeWav(audio.samples, audio.sampleRate);
  }
  log?.('Media stream capture unavailable; trying the played audio response');
  // Cross-origin media may play normally while captureStream is unavailable. Decode only the
  // exact audio response requested for the played element; never inspect a track/metadata API.
  const encoded = await withProgress(log, 'Read played audio response', () => observedAudio.get(audio.source));
  if (!encoded) throw new Error(`Audio capture failed: ${audio.error}`);
  const decoded = await withProgress(log, 'Decode played audio to PCM', () => page.evaluate(async ({ base64, source, startTime }) => {
    const media = window.__dailyPlayerCapture.media;
    if (media?.currentSrc !== source) throw new Error('The playable clip changed before capture completed.');
    const seconds = media ? Math.min(12, Math.max(0, media.currentTime - startTime)) : 0;
    if (seconds < 1) throw new Error('The clip has not played long enough to capture.');
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const context = new OfflineAudioContext(1, 1, 48000);
    const buffer = await context.decodeAudioData(bytes.buffer);
    const start = Math.floor(startTime * buffer.sampleRate);
    const end = Math.min(buffer.length, start + Math.floor(seconds * buffer.sampleRate));
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    const samples = [];
    for (let i = start; i < end; i++) samples.push(channels.reduce((sum, channel) => sum + channel[i], 0) / channels.length);
    return { samples, sampleRate: buffer.sampleRate };
  }, { base64: encoded.toString('base64'), source: audio.source, startTime: audio.startTime }));
  log?.(`Audio decoded: ${decoded.samples.length} samples at ${decoded.sampleRate} Hz`);
  return encodeWav(decoded.samples, decoded.sampleRate);
}

export async function performGameAction(page, action, { gameKey, model, signal, chargeCall, observedAudio, log, step }) {
  const point = (x, y) => {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= width || y < 0 || y >= height) {
      throw new Error('Action coordinates are outside the viewport.');
    }
  };
  switch (action.action) {
    case 'click': point(action.x, action.y); await page.mouse.click(action.x, action.y); break;
    case 'drag':
      point(action.x, action.y); point(action.toX, action.toY);
      await page.mouse.move(action.x, action.y); await page.mouse.down();
      try { await page.mouse.move(action.toX, action.toY, { steps: 24 }); }
      finally { await page.mouse.up(); }
      break;
    case 'type':
      if (typeof action.text !== 'string' || action.text.length > 150 || /[\r\n]/.test(action.text)) throw new Error('Invalid answer text.');
      await page.keyboard.insertText(action.text); break;
    case 'key':
      if (!keys.has(action.text)) throw new Error('Unsupported key.');
      await page.keyboard.press(action.text); break;
    case 'scroll':
      if (![action.x, action.y].every((value) => Number.isInteger(value) && Math.abs(value) <= 768)) throw new Error('Invalid scroll distance.');
      await page.mouse.wheel(action.x, action.y); break;
    case 'wait': await page.waitForTimeout(750); break;
    case 'listen': {
      if (gameKey !== 'musictimeliner') throw new Error('Listening is only available for Music Timeliner.');
      const wav = await capturePlayableAudio(page, observedAudio, log);
      chargeCall();
      log?.(`Send ${wav.length} WAV bytes to the audio listener`);
      return `Audio observations: ${await model.listen(wav, signal, { step })}`;
    }
    case 'done': break;
    default: throw new Error('Unknown gameplay action.');
  }
  return 'Action completed.';
}

export async function playDailyGame(gameKey, settings, model, {
  dryRun = false, inspect = false, headed = false, signal: parentSignal,
  onProgress = () => {}, browserType, log, debugDirectory,
} = {}) {
  const game = settings.games[gameKey];
  if (!game) throw new Error('Unknown daily game.');
  log?.(`Start ${gameKey}; browser=${headed || !game.headless ? 'headed' : 'headless'}; call limit=${settings.maxCalls}; time limit=${settings.maxRuntimeMs / 1000}s`);
  log?.record?.('game_started', { gameKey, model: settings.model, audioBackend: settings.audioBackend || 'openai',
    audioModel: settings.audioBackend === 'local' ? settings.localAudioModel : settings.audioModel });
  // Lazy loading leaves the score tracker usable even before browser dependencies are installed.
  if (!browserType) {
    try { browserType = (await withProgress(log, 'Load Playwright runtime', () => import('../../browser-runtime/node_modules/playwright/index.mjs'))).chromium; }
    catch { throw new Error('Install the browser runtime with npm run daily:setup, then npm run daily:browser.'); }
  }
  const temporary = dryRun || inspect ? await mkdtemp(join(tmpdir(), 'daily-player-')) : null;
  const profile = temporary ?? resolve(settings.dataDirectory, 'profiles', gameKey);
  await mkdir(profile, { recursive: true });
  const timeout = AbortSignal.timeout(settings.maxRuntimeMs);
  const signal = parentSignal ? AbortSignal.any([timeout, parentSignal]) : timeout;
  let context;
  let calls = 0;
  const chargeCall = () => {
    signal.throwIfAborted();
    if (++calls > settings.maxCalls) throw new Error('Game model-call limit reached.');
  };
  try {
    context = await withProgress(log, 'Launch Chromium (30s timeout)', () => browserType.launchPersistentContext(profile, {
      channel: 'chromium', headless: headed ? false : game.headless,
      viewport: { width, height }, timezoneId: settings.timeZone,
      locale: 'en-US', acceptDownloads: false, timeout: 30000,
    }));
    // The abort listener terminates browser waits as well as API calls.
    const abort = () => { void context.close().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      await withProgress(log, 'Install native share and audio capture', () => context.addInitScript(installPlayerCapture));
      const origin = new URL(game.url).origin;
      await context.route('**/*', async (route) => {
        const request = route.request();
        if (request.isNavigationRequest() && request.frame() === context.pages()[0]?.mainFrame()
          && new URL(request.url()).origin !== origin) await route.abort();
        else await route.continue();
      });
      context.on('page', (popup) => { if (popup !== context.pages()[0]) void popup.close(); });
      const page = context.pages()[0] || await context.newPage();
      page.on('crash', () => log?.('Browser page crashed'));
      page.on('pageerror', (error) => log?.(`Game JavaScript error (${error.name || 'Error'}); message omitted from log`));
      const observedAudio = new Map();
      page.on('response', (response) => {
        const contentType = response.headers()['content-type'] || '';
        if (!contentType.startsWith('audio/') || observedAudio.size >= 16) return;
        log?.(`Observed audio response ${observedAudio.size + 1}; caching bytes without logging source metadata`);
        observedAudio.set(response.url(), response.body().then((body) => body.length <= 10 * 1024 * 1024 ? body : null).catch(() => null));
      });
      page.setDefaultTimeout(10000);
      await withProgress(log, `Load ${gameKey} page (45s timeout)`, () => page.goto(game.url, { waitUntil: 'domcontentloaded', timeout: 45000 }));
      log?.('Page DOM loaded; allowing 1.5s for initial rendering');
      await page.waitForTimeout(1500);
      if (inspect) return { gameKey, title: await page.title(), visibleText: (await page.locator('body').innerText()).slice(0, 16000), screenshot: await page.screenshot() };
      const history = [];
      let step = 0;
      let previousShare = '';
      let feedback = 'Start the daily game. Do not play practice, archive or hard mode.';
      while (true) {
        signal.throwIfAborted();
        let share = await withProgress(log, 'Check native share output', () => page.evaluate(() => window.__dailyPlayerCapture?.share || ''));
        let result = parseDailyResult(gameKey, share);
        if (share && share !== previousShare) {
          log?.record?.('native_share_candidate', { source: 'intercepted-copy', shareText: share.slice(0, 5000), accepted: Boolean(result) });
          previousShare = share;
        }
        if (!result && gameKey === 'codenames') {
          const visibleShare = visibleCodenamesShare(await page.locator('body').innerText());
          if (visibleShare) {
            share = visibleShare;
            result = parseDailyResult(gameKey, share);
            log?.('Read valid result from the game\'s visible native share popup');
            log?.record?.('native_share_candidate', { source: 'visible-native-share-popup', shareText: share, accepted: true });
          }
        }
        if (result) {
          log?.(`Valid native result captured: puzzle=${result.puzzle}, score=${result.score}, model calls=${calls}`);
          log?.record?.('game_result', { gameKey, ...result, shareText: share, calls, steps: step });
          return { gameKey, ...result, shareText: share, calls };
        }
        chargeCall();
        step++;
        const screenshot = await withProgress(log, 'Capture game screenshot', () => page.screenshot());
        const screenshotName = `step-${String(step).padStart(3, '0')}.png`;
        if (debugDirectory) {
          await writeFile(join(debugDirectory, screenshotName), screenshot);
          await writeFile(join(debugDirectory, 'latest-screen.png'), screenshot);
        }
        const visibleText = await withProgress(log, 'Read visible game text', () => page.locator('body').innerText());
        log?.record?.('observation', { step, afterActionStep: step > 1 ? step - 1 : null,
          screenshot: debugDirectory ? screenshotName : null, visibleText: visibleText.slice(0, 16000) });
        log?.(`Observation ready: ${screenshot.length} screenshot bytes; ${visibleText.length} visible text characters (content omitted)`);
        const decisionStarted = Date.now();
        const action = await withProgress(log, `Gameplay decision ${calls}/${settings.maxCalls}`, () => model.decide({ gameKey, screenshot,
          visibleText, history: history.slice(-24), feedback, signal }));
        log?.(`Model selected ${action.action}${action.action === 'type' ? ` (${typeof action.text === 'string' ? action.text.length : 0} characters; text omitted)` : ''}`);
        const recordedAction = { action: action.action, x: action.x, y: action.y, toX: action.toX, toY: action.toY,
          text: typeof action.text === 'string' ? action.text.slice(0, 150) : null };
        log?.record?.('decision', { step, model: settings.model, action: recordedAction,
          decisionSummary: action.decisionSummary || null, confidence: action.confidence || null,
          durationMs: Date.now() - decisionStarted });
        if (action.decisionSummary) log?.(`Decision summary [${action.confidence || 'unspecified'} confidence]: ${action.decisionSummary}`);
        if (action.action === 'done') throw new Error('Game finished without a valid native share result.');
        try {
          feedback = await withProgress(log, `Execute ${action.action}`, () => performGameAction(page, action, { gameKey, model, signal, chargeCall, observedAudio, log, step }));
          log?.record?.('action_result', { step, action: action.action, status: 'executed', feedback });
        } catch (error) {
          log?.record?.('action_result', { step, action: action.action, status: 'failed', error: error.message });
          // Capture failures are technical errors, not an invitation to guess without listening.
          if (action.action === 'listen' || signal.aborted) throw error;
          feedback = `Action failed: ${error.message.slice(0, 200)}`;
          log?.(`Action ${action.action} failed; feedback will be sent to the gameplay model`);
        }
        history.push({ action, feedback });
        await onProgress({ calls });
        await page.waitForTimeout(200);
      }
    } finally { signal.removeEventListener('abort', abort); }
  } finally {
    if (context) await withProgress(log, 'Close browser', () => context.close()).catch(() => {});
    if (temporary) await withProgress(log, 'Remove temporary browser profile', () => rm(temporary, { recursive: true, force: true }));
  }
}
