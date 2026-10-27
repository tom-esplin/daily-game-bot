import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { compileTemplate, parseSubmission } from './parser.js';
import { CODENAMES_GAME, parseCodenames } from './codenames.js';
import { MUSIC_TIMELINER_GAME, parseMusicTimeliner } from './musictimeliner.js';
import { scoreRange } from './rankings.js';

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
    if (!message.guildId || message.author?.bot || !this.isTracked(message.guildId, message.channelId)) return 0;
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
  submissions(guildId) {
    // Preserve source messages, but count only the newest post for each player/puzzle.
    return this.db.prepare(`
      SELECT * FROM (
        SELECT s.*, ROW_NUMBER() OVER (
          PARTITION BY s.guild_id, s.game_key, s.puzzle, s.user_id
          ORDER BY s.created_at DESC, length(s.message_id) DESC, s.message_id DESC
        ) AS position
        FROM submissions s JOIN games g ON s.guild_id=g.guild_id AND s.game_key=g.key
        WHERE s.guild_id=? AND g.enabled=1
      ) WHERE position=1
    `).all(guildId);
  }
}
