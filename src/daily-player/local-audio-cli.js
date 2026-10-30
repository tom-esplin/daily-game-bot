import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';

const python = fileURLToPath(new URL(process.platform === 'win32'
  ? '../../local-audio/.venv/Scripts/python.exe' : '../../local-audio/.venv/bin/python', import.meta.url));
if (!existsSync(python)) {
  console.error('Create local-audio/.venv with a working Python 3.11 or 3.12 and install local-audio/requirements.txt. See README.md.');
  process.exitCode = 1;
} else {
  const logDirectory = fileURLToPath(new URL('../../data/local-audio', import.meta.url));
  mkdirSync(logDirectory, { recursive: true });
  const logPath = fileURLToPath(new URL('../../data/local-audio/startup.log', import.meta.url));
  const log = createWriteStream(logPath, { flags: 'w' });
  log.on('error', (error) => console.error(`Could not write listener log: ${error.message}`));
  log.write(`Local audio startup: ${new Date().toISOString()}\n`);
  console.log(`Listener startup log: ${logPath}`);
  const args = process.argv.slice(2);
  const child = spawn(python, ['-X', 'faulthandler', '-u', fileURLToPath(new URL('../../local-audio/server.py', import.meta.url)), ...args], {
    stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true,
  });
  let ready = false;
  let tail = '';
  let stopping = false;
  let spawnFailed = false;
  const capture = (output) => (chunk) => {
    output.write(chunk);
    log.write(chunk);
    tail = (tail + chunk.toString()).slice(-1024);
    if (tail.includes('Local listener ready')) ready = true;
  };
  child.stdout.on('data', capture(process.stdout));
  child.stderr.on('data', capture(process.stderr));
  child.on('error', (error) => {
    spawnFailed = true;
    console.error(`Could not start the local Python listener: ${error.message}`);
    log.write(`Could not start Python: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on('close', (code, signal) => {
    const exit = signal ? `signal ${signal}` : `exit code ${code} (0x${((code ?? 0) >>> 0).toString(16).toUpperCase().padStart(8, '0')})`;
    log.end(`\nPython stopped with ${exit}. Ready reached: ${ready}.\n`);
    if (stopping || spawnFailed) return;
    if (code !== 0 || signal || (!ready && !args.includes('--download-only'))) {
      console.error(`Local audio listener stopped with ${exit}${ready ? '' : ' before becoming ready'}.`);
      console.error(`Full startup output is saved in ${logPath}.`);
      process.exitCode = 1;
    }
  });
  process.once('SIGINT', () => { stopping = true; child.kill('SIGINT'); });
  process.once('SIGTERM', () => { stopping = true; child.kill('SIGTERM'); });
}
