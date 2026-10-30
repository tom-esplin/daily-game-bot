import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DAILY_PLAYER } from './daily-player-config.js';
import { DailyPlayerModel } from './daily-player-model.js';
import { playDailyGame } from './daily-browser.js';
import { createRunLogger } from './daily-player-log.js';

let runLog;

async function main() {
  const args = process.argv.slice(2);
  const allowed = new Set(['--preflight', '--dry-run', '--inspect', '--headed', '--game', '--list-models']);
  const keys = Object.keys(DAILY_PLAYER.games);
  let gameKey;
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i])) throw new Error(`Unknown argument: ${args[i]}`);
    if (args[i] === '--game') {
      gameKey = args[++i];
      if (!keys.includes(gameKey)) throw new Error(`Choose --game ${keys.join('|')}.`);
    }
  }
  const inspect = args.includes('--inspect');
  if (!inspect && !args.includes('--preflight') && !args.includes('--dry-run') && !args.includes('--list-models')) {
    console.log('Usage: npm run daily -- --preflight [--game krillion]\n       npm run daily -- --list-models\n       npm run daily -- --inspect --game krillion [--headed]\n       npm run daily -- --dry-run --game krillion [--headed]\nDry runs use temporary browser profiles, never log into Discord, and never write competitive scores.');
    return;
  }
  if ((inspect || args.includes('--dry-run')) && !gameKey) throw new Error('Choose exactly one game with --game.');
  const directory = resolve(DAILY_PLAYER.dataDirectory, 'dry-runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${gameKey || 'preflight'}`);
  runLog = createRunLogger(directory);
  runLog(`Run log: ${runLog.path}`);
  runLog(`Performance review: ${runLog.reviewPath}`);
  runLog(`Mode: ${inspect ? 'inspect' : args.includes('--dry-run') ? 'dry-run' : args.includes('--list-models') ? 'list-models' : 'preflight'}; game=${gameKey || 'all'}; audio backend=${DAILY_PLAYER.audioBackend || 'openai'}`);
  runLog.record('run_started', { gameKey: gameKey || null, model: DAILY_PLAYER.model,
    reasoningEffort: DAILY_PLAYER.reasoningEffort, audioBackend: DAILY_PLAYER.audioBackend || 'openai' });
  const usage = [];
  const model = inspect ? null : new DailyPlayerModel(DAILY_PLAYER, { onUsage: (record) => {
    usage.push(record);
    runLog.record('model_usage', record);
  }, log: runLog });
  if (args.includes('--list-models')) {
    if (!model) throw new Error('Use --list-models separately from --inspect.');
    const models = await model.listAudioModels(AbortSignal.timeout(30000));
    console.log(models.length ? models.join('\n') : 'No audio-named models are available to this key/project.');
    console.log('Listing confirms model visibility only; choose one documented to accept audio input through Chat Completions.');
    return;
  }
  if (model) {
    const audio = !gameKey || gameKey === 'musictimeliner';
    await model.preflight(AbortSignal.timeout(30000), { audio });
    runLog(audio ? `Gameplay model and ${DAILY_PLAYER.audioBackend || 'openai'} audio listener are accessible.`
      : 'The configured gameplay model is accessible; this game does not require audio.');
  }
  if (!inspect && !args.includes('--dry-run')) return;
  const result = await playDailyGame(gameKey, DAILY_PLAYER, model, { dryRun: true, inspect, headed: args.includes('--headed'), log: runLog, debugDirectory: directory });
  await mkdir(directory, { recursive: true });
  if (result.screenshot) { await writeFile(resolve(directory, 'screen.png'), result.screenshot); delete result.screenshot; }
  await writeFile(resolve(directory, 'result.json'), JSON.stringify({ ...result, usage }, null, 2));
  const modelCalls = {};
  for (const record of usage) modelCalls[record.model] = (modelCalls[record.model] || 0) + 1;
  runLog.record('run_summary', { gameKey, puzzle: result.puzzle ?? null, score: result.score ?? null, modelCalls });
  runLog(`${inspect ? 'Inspection' : 'Dry run'} saved to ${directory}. No Discord posts or competitive scores were created.`);
}

main().catch((error) => {
  if (runLog) {
    runLog.record('run_failed', { error: error.message });
    runLog(`Run failed: ${error.message}`);
  }
  else console.error(error.message);
  process.exitCode = 1;
});
