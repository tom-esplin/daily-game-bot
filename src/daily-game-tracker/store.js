import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { compileTemplate, parseSubmission } from './parser.js';
import { CODENAMES_GAME, parseCodenames } from './codenames.js';
import { MUSIC_TIMELINER_GAME, parseMusicTimeliner } from './musictimeliner.js';
import { scoreRange } from './rankings.js';
import { AI_PLAYER_NAME, aiResultContent, resultEmbedsSuppressed } from '../daily-player/player-identity.js';
import { parseDailyResult } from '../daily-player/daily-results.js';

const builtInParsers = { codenames: parseCodenames, musictimeliner: parseMusicTimeliner };

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS settings (
        guild_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tracked_channels (
        guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
        PRIMARY KEY(guild_id, channel_id)
      );
      CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS ai_players (user_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS ai_daily_runs (
        date TEXT NOT NULL, game_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        puzzle TEXT, result_json TEXT, error TEXT,
        PRIMARY KEY(date, game_key)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ai_daily_puzzle ON ai_daily_runs(game_key,puzzle) WHERE puzzle IS NOT NULL;
      CREATE TABLE IF NOT EXISTS ai_usage (
        date TEXT NOT NULL, game_key TEXT NOT NULL, model TEXT NOT NULL,
        created_at INTEGER NOT NULL, usage_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ai_deliveries (
        guild_id TEXT NOT NULL, game_key TEXT NOT NULL, puzzle TEXT NOT NULL,
        user_id TEXT NOT NULL, channel_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        result_json TEXT NOT NULL, message_id TEXT,
        PRIMARY KEY(guild_id,game_key,puzzle)
      );
      CREATE TABLE IF NOT EXISTS ai_celebrations (
        guild_id TEXT NOT NULL, month TEXT NOT NULL, created_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL, channel_id TEXT, message_id TEXT,
        PRIMARY KEY(guild_id,month)
      );
      CREATE TABLE IF NOT EXISTS monthly_announcements (
        guild_id TEXT NOT NULL, month TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','sent','empty')),
        payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        channel_id TEXT, message_id TEXT,
        PRIMARY KEY(guild_id, month)
      );
      CREATE TABLE IF NOT EXISTS games (
        guild_id TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL,
        template TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('higher','lower')),
        enabled INTEGER NOT NULL DEFAULT 1,
        parser TEXT NOT NULL DEFAULT 'template',
        PRIMARY KEY(guild_id, key)
      );
      CREATE TABLE IF NOT EXISTS submissions (
        guild_id TEXT NOT NULL, game_key TEXT NOT NULL, puzzle TEXT NOT NULL,
        user_id TEXT NOT NULL, username TEXT NOT NULL,
        score REAL NOT NULL, message_id TEXT NOT NULL, channel_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(guild_id, message_id, game_key),
        FOREIGN KEY(guild_id, game_key) REFERENCES games(guild_id, key)
      );
      CREATE INDEX IF NOT EXISTS submissions_lookup
        ON submissions(guild_id, game_key, user_id, puzzle);
    `);
    this.db.prepare('UPDATE submissions SET username=? WHERE user_id IN (SELECT user_id FROM ai_players) AND username<>?')
      .run(AI_PLAYER_NAME, AI_PLAYER_NAME);
    if (!this.db.prepare('PRAGMA table_info(games)').all().some((column) => column.name === 'parser')) {
      this.db.exec("ALTER TABLE games ADD COLUMN parser TEXT NOT NULL DEFAULT 'template'");
    }
    if (!this.db.prepare('SELECT 1 FROM app_migrations WHERE name=?').get('multi-channel-tracking-v1')) {
      this.db.exec('BEGIN');
      try {
        this.db.exec('INSERT OR IGNORE INTO tracked_channels SELECT guild_id, channel_id FROM settings');
        this.db.prepare('INSERT INTO app_migrations VALUES (?)').run('multi-channel-tracking-v1');
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    for (const setting of this.db.prepare('SELECT DISTINCT guild_id FROM tracked_channels').all()) {
      this.addBuiltInGames(setting.guild_id);
    }
  }

  close() { this.db.close(); }
  channels(guildId) {
    return this.db.prepare('SELECT channel_id FROM tracked_channels WHERE guild_id=? ORDER BY channel_id').all(guildId)
      .map((row) => row.channel_id);
  }
  isTracked(guildId, channelId) {
    return Boolean(this.db.prepare('SELECT 1 FROM tracked_channels WHERE guild_id=? AND channel_id=?').get(guildId, channelId));
  }
  track(guildId, channelId) {
    const result = this.db.prepare('INSERT OR IGNORE INTO tracked_channels VALUES (?, ?)').run(guildId, channelId);
    this.addBuiltInGames(guildId);
    return result.changes > 0;
  }
  untrack(guildId, channelId) {
    return this.db.prepare('DELETE FROM tracked_channels WHERE guild_id=? AND channel_id=?').run(guildId, channelId).changes > 0;
  }
  addBuiltInGames(guildId) {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO games
      (guild_id, key, name, template, direction, enabled, parser) VALUES (?, ?, ?, ?, ?, 1, ?)`);
    insert.run(guildId, 'krillion', 'Krillion', 'Krillion #{puzzle}\n{score}', 'higher', 'template');
    insert.run(guildId, 'maptapp', 'Maptap', 'www.maptap.gg {puzzle}\n{skip}\nFinal score: {score}', 'higher', 'template');
    for (const game of [CODENAMES_GAME, MUSIC_TIMELINER_GAME]) {
      insert.run(guildId, game.key, game.name, game.template, game.direction, game.parser);
    }
  }
  games(guildId, enabledOnly = false) {
    return this.db.prepare(`SELECT * FROM games WHERE guild_id = ? ${enabledOnly ? 'AND enabled = 1' : ''} ORDER BY key`).all(guildId)
      .map((game) => {
        const { min, max } = scoreRange({ key: game.key });
        return { ...game, score_min: min, score_max: max };
      });
  }
  game(guildId, key) { return this.games(guildId).find((game) => game.key === key); }
  addGame(guildId, { key, name, template, direction }) {
    if (!/^[a-z0-9-]{1,32}$/.test(key)) throw new Error('Game key must use 1–32 lowercase letters, numbers, or hyphens.');
    if (!name.trim() || name.length > 60) throw new Error('Game name must contain 1–60 characters.');
    if (!['higher', 'lower'].includes(direction)) throw new Error('Choose higher or lower for score direction.');
    compileTemplate(template);
    if (this.game(guildId, key)) throw new Error('That game key already exists.');
    this.db.prepare(`INSERT INTO games (guild_id, key, name, template, direction, enabled)
      VALUES (?, ?, ?, ?, ?, 1)`).run(guildId, key, name.trim(), template, direction);
  }
  setEnabled(guildId, key, enabled) {
    if (!this.game(guildId, key)) throw new Error('Unknown game. Use /game list to see game keys.');
    this.db.prepare('UPDATE games SET enabled = ? WHERE guild_id = ? AND key = ?').run(enabled ? 1 : 0, guildId, key);
  }
  removeMessage(guildId, messageId) {
    this.db.prepare('DELETE FROM submissions WHERE guild_id = ? AND message_id = ?').run(guildId, messageId);
  }
  ingest(message) {
    if (!message.guildId || !this.isTracked(message.guildId, message.channelId)) return 0;
    if (message.author?.bot) return this.recoverAIResult(message);
    const parsed = this.games(message.guildId, true).flatMap((game) => {
      const builtInParser = builtInParsers[game.parser];
      const result = builtInParser ? builtInParser(message.content)
        : parseSubmission(message.content, game.template, message.createdTimestamp);
      return result ? [{ game, ...result }] : [];
    });
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`DELETE FROM submissions WHERE guild_id=? AND message_id=?
        AND game_key IN (SELECT key FROM games WHERE guild_id=? AND enabled=1)`)
        .run(message.guildId, message.id, message.guildId);
      const insert = this.db.prepare('INSERT INTO submissions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const result of parsed) {
        insert.run(message.guildId, result.game.key, result.puzzle, message.author.id,
          message.author.username, result.score, message.id, message.channelId, message.createdTimestamp);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return parsed.length;
  }
  isAIPlayer(userId) {
    return Boolean(this.db.prepare('SELECT 1 FROM ai_players WHERE user_id=?').get(userId));
  }
  registerAIPlayer(userId) {
    this.db.prepare('INSERT OR IGNORE INTO ai_players VALUES (?)').run(userId);
  }
  dailyRun(date, gameKey) {
    return this.db.prepare('SELECT * FROM ai_daily_runs WHERE date=? AND game_key=?').get(date, gameKey);
  }
  claimDailyRun(date, gameKey, now, maxRuntimeMs) {
    // An interrupted attempt is never replayed. A stale run is marked failed after its time limit.
    this.expireDailyRuns(now, maxRuntimeMs);
    return this.db.prepare(`INSERT OR IGNORE INTO ai_daily_runs(date,game_key,status,created_at,updated_at)
      SELECT ?,?,'running',?,? WHERE NOT EXISTS (SELECT 1 FROM ai_daily_runs WHERE game_key=? AND status='running')`)
      .run(date, gameKey, now, now, gameKey).changes > 0;
  }
  expireDailyRuns(now, maxRuntimeMs) {
    this.db.prepare("UPDATE ai_daily_runs SET status='failed',error='Interrupted attempt; inspect its browser profile before trying another day.' WHERE status='running' AND updated_at<?")
      .run(now - maxRuntimeMs - 60000);
  }
  touchDailyRun(date, gameKey, now) {
    this.db.prepare("UPDATE ai_daily_runs SET updated_at=? WHERE date=? AND game_key=? AND status='running'").run(now, date, gameKey);
  }
  finishDailyRun(date, gameKey, result, now) {
    const parsed = parseDailyResult(gameKey, result.shareText, now);
    if (!parsed || parsed.puzzle !== result.puzzle || parsed.score !== result.score) throw new Error('Invalid AI result.');
    this.db.prepare("UPDATE ai_daily_runs SET status='completed',updated_at=?,puzzle=?,result_json=? WHERE date=? AND game_key=? AND status='running'")
      .run(now, parsed.puzzle, JSON.stringify(result), date, gameKey);
  }
  failDailyRun(date, gameKey, error, now) {
    this.db.prepare("UPDATE ai_daily_runs SET status='failed',updated_at=?,error=? WHERE date=? AND game_key=? AND status='running'")
      .run(now, error.slice(0, 500), date, gameKey);
  }
  recordAIUsage(date, gameKey, { model, usage }, now = Date.now()) {
    this.db.prepare('INSERT INTO ai_usage VALUES (?,?,?,?,?)').run(date, gameKey, model, now, JSON.stringify(usage));
  }
  completedDailyRuns() {
    return this.db.prepare("SELECT * FROM ai_daily_runs WHERE status='completed' ORDER BY date,game_key").all();
  }
  queueAIDelivery(guildId, channelId, userId, result, now) {
    const game = this.game(guildId, result.gameKey);
    if (!game?.enabled || !this.isTracked(guildId, channelId)) throw new Error('AI results require an enabled game and a tracked destination channel.');
    const parsed = parseDailyResult(result.gameKey, result.shareText, now);
    if (!parsed || parsed.puzzle !== result.puzzle || parsed.score !== result.score) throw new Error('Invalid AI delivery result.');
    this.registerAIPlayer(userId);
    this.db.prepare('INSERT OR IGNORE INTO ai_deliveries VALUES (?,?,?,?,?,?,?,NULL)')
      .run(guildId, result.gameKey, result.puzzle, userId, channelId, now, JSON.stringify(result));
  }
  pendingAIDeliveries() {
    return this.db.prepare('SELECT * FROM ai_deliveries WHERE message_id IS NULL ORDER BY created_at').all();
  }
  completeAIDelivery(job, message) {
    if (message.author?.id !== job.user_id || message.channelId !== job.channel_id || message.guildId !== job.guild_id) throw new Error('AI delivery author/channel mismatch.');
    const result = JSON.parse(job.result_json);
    const parsed = parseDailyResult(job.game_key, message.content, message.createdTimestamp);
    if (!parsed || parsed.puzzle !== result.puzzle || parsed.score !== result.score) throw new Error('AI delivery score mismatch.');
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE ai_deliveries SET message_id=? WHERE guild_id=? AND game_key=? AND puzzle=?')
        .run(message.id, job.guild_id, job.game_key, job.puzzle);
      this.db.prepare('INSERT OR REPLACE INTO submissions VALUES (?,?,?,?,?,?,?,?,?)').run(job.guild_id, job.game_key,
        result.puzzle, job.user_id, AI_PLAYER_NAME, result.score, message.id, job.channel_id, message.createdTimestamp);
      if (!message.embeds?.length && resultEmbedsSuppressed(message)
        && message.content === aiResultContent(result.shareText)) {
        this.finishAIBannerCleanup({ ...job, message_id: message.id });
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  pendingAIBannerCleanup(userId) {
    return this.db.prepare(`SELECT * FROM ai_deliveries d WHERE user_id=? AND message_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM app_migrations m WHERE m.name='ai-result-format-v2:' || d.guild_id || ':' || d.message_id)`)
      .all(userId);
  }
  finishAIBannerCleanup(job) {
    this.db.prepare('INSERT OR IGNORE INTO app_migrations VALUES (?)')
      .run(`ai-result-format-v2:${job.guild_id}:${job.message_id}`);
  }
  recoverAIResult(message) {
    const job = this.db.prepare('SELECT * FROM ai_deliveries WHERE guild_id=? AND channel_id=? AND user_id=? AND message_id=?')
      .get(message.guildId, message.channelId, message.author.id, message.id);
    if (!job || !this.game(message.guildId, job.game_key)?.enabled) return 0;
    this.completeAIDelivery(job, message);
    return 1;
  }
  celebration(guildId, month) {
    return this.db.prepare('SELECT * FROM ai_celebrations WHERE guild_id=? AND month=?').get(guildId, month);
  }
  queueCelebration(guildId, month, payload, now) {
    this.db.prepare('INSERT OR IGNORE INTO ai_celebrations VALUES (?,?,?,?,NULL,NULL)')
      .run(guildId, month, now, JSON.stringify(payload));
  }
  pendingCelebrations(guildId) {
    return this.db.prepare("SELECT * FROM ai_celebrations WHERE guild_id=? AND message_id IS NULL AND payload_json!='null'").all(guildId);
  }
  finishCelebration(guildId, month, channelId, messageId) {
    this.db.prepare('UPDATE ai_celebrations SET channel_id=?,message_id=? WHERE guild_id=? AND month=?').run(channelId, messageId, guildId, month);
  }
  setCelebrationChannel(guildId, month, channelId) {
    this.db.prepare('UPDATE ai_celebrations SET channel_id=? WHERE guild_id=? AND month=?').run(channelId, guildId, month);
  }
  monthlyAnnouncement(guildId, month) {
    return this.db.prepare('SELECT * FROM monthly_announcements WHERE guild_id=? AND month=?').get(guildId, month);
  }
  pendingMonthlyAnnouncements(guildId) {
    return this.db.prepare("SELECT * FROM monthly_announcements WHERE guild_id=? AND status='pending' ORDER BY month").all(guildId);
  }
  createMonthlyAnnouncement(guildId, month, payload, createdAt) {
    const result = this.db.prepare(`INSERT OR IGNORE INTO monthly_announcements
      (guild_id, month, status, payload_json, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(guildId, month, payload ? 'pending' : 'empty', JSON.stringify(payload), createdAt);
    return { created: result.changes > 0, record: this.monthlyAnnouncement(guildId, month) };
  }
  setMonthlyAnnouncementChannel(guildId, month, channelId) {
    this.db.prepare("UPDATE monthly_announcements SET channel_id=? WHERE guild_id=? AND month=? AND status='pending'").run(channelId, guildId, month);
  }
  finishMonthlyAnnouncement(guildId, month, channelId, messageId) {
    this.db.prepare(`UPDATE monthly_announcements SET status='sent', channel_id=?, message_id=?
      WHERE guild_id=? AND month=?`).run(channelId, messageId, guildId, month);
  }
  submissions(guildId, { beforeTimestamp } = {}) {
    if (beforeTimestamp !== undefined && !Number.isSafeInteger(beforeTimestamp)) throw new Error('Invalid score cutoff timestamp.');
    // Preserve source messages, but count only the newest post for each player/puzzle.
    return this.db.prepare(`
      SELECT * FROM (
        SELECT s.*, ROW_NUMBER() OVER (
          PARTITION BY s.guild_id, s.game_key, s.puzzle, s.user_id
          ORDER BY s.created_at DESC, length(s.message_id) DESC, s.message_id DESC
        ) AS position
        FROM submissions s JOIN games g ON s.guild_id=g.guild_id AND s.game_key=g.key
        WHERE s.guild_id=? AND g.enabled=1 ${beforeTimestamp === undefined ? '' : 'AND s.created_at<=?'}
      ) WHERE position=1
    `).all(...(beforeTimestamp === undefined ? [guildId] : [guildId, beforeTimestamp]));
  }
}
