// Enable a game only after its dry run succeeds on the machine hosting the bot.
export const DAILY_PLAYER = {
  enabled: true,
  timeZone: 'America/Denver',
  hour: 11,
  minute: 0,
  checkIntervalMs: 30000,
  model: 'gpt-6.1-sol',
  reasoningEffort: 'medium',
  audioBackend: process.env.DAILY_AUDIO_BACKEND || 'local', // 'local' or 'openai'
  audioModel: process.env.OPENAI_AUDIO_MODEL || 'gpt-audio-1.5',
  localAudioUrl: 'http://127.0.0.1:8765',
  localAudioModel: 'Qwen/Qwen2-Audio-7B-Instruct',
  maxCalls: 60,
  maxRuntimeMs: 15 * 60 * 1000,
  dataDirectory: './data/daily-player',
  // 'SERVER_ID': { dailyChannelId: 'CHANNEL_ID', codenamesChannelId: 'CHANNEL_ID' }
  servers: {
    '1059897243089506304': {
      dailyChannelId: '1379569840913911836',
      codenamesChannelId: '1493333678657372240',
      // Confirm names live; if an inferred ID differs, resolve a unique matching tracked channel.
      validateChannelNames: true,
    },
  },
  games: {
    krillion: { enabled: true, verified: true, headless: true, url: 'https://krillion.io/' },
    codenames: { enabled: true, verified: true, headless: true, url: 'https://codenames.game/daily/en' },
    maptapp: { enabled: true, verified: true, headless: true, url: 'https://maptap.gg/' },
    musictimeliner: { enabled: true, verified: true, headless: true, url: 'https://www.musictimeliner.com/' },
  },
};
