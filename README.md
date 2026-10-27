# Daily games Discord bot

A Node.js bot that records daily game results pasted into a Discord text channel. It includes Krillion, Maptap, Codenames Daily, and Music Timeliner, per-game and overall leaderboards, user score lookups, and commands to add games without editing code. Scores live in a local SQLite database.

## Setup

Requires Node.js 24 or newer.

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications). On its Bot page, enable **Message Content Intent** and obtain a bot token. Discord requires this intent to read ordinary shared messages: [official documentation](https://docs.discord.com/developers/events/gateway#message-content-intent).
2. Install the app into your server using the `bot` and `applications.commands` scopes. Give the bot **View Channel**, **Read Message History**, **Send Messages**, and **Embed Links** in the relevant channels.
3. Copy `.env.example` to `.env`. Enter the bot token, application ID, and server ID. Enable Developer Mode in Discord to copy server IDs. Keep `.env` private.
4. From this directory, run:

   ```powershell
   npm install
   npm run register
   npm start
   ```

5. In your server, run `/track channel:#daily-games`. Repeat for every channel you want to track. This requires **Manage Server** permission and automatically adds Krillion, Maptap, Codenames Daily, and Music Timeliner.
6. Paste a result into any tracked channel, then run `/leaderboard` or `/score game:krillion`.

The bot must remain running to collect new posts. Registration installs this project's commands into the server named by `DISCORD_GUILD_ID`; repeat registration for each server where you install the bot. Running registration replaces this application's server command list.

## Commands

| Command | Purpose |
| --- | --- |
| `/track channel` | Add a tracked channel without replacing others; requires Manage Server |
| `/untrack channel` | Stop tracking a channel and retain recorded scores; requires Manage Server |
| `/channels [page]` | List tracked channels, 20 per page; requires Manage Server |
| `/leaderboard [game] [page] [period]` | Monthly totals by default; choose All Time; interactive menus and 5 players per page |
| `/score game [user] [puzzle]` | Last 10 results, or one puzzle; defaults to your user |
| `/game list` | List games, templates, and score direction |
| `/game add key name template direction` | Add a game; requires Manage Server |
| `/game disable game` | Pause collection and hide that game's scores; requires Manage Server |
| `/game enable game` | Resume collection and restore stored scores; requires Manage Server |
| `/backfill [limit] [channel]` | Import 1–10,000 messages per tracked channel, default 100; optionally select one channel; requires Manage Server |

Replies are private to the person who runs the command. Tracking is configured separately for each server; scores never cross server boundaries.

A server can track any number of text channels with no bot-imposed channel limit. Use `/track` to add each one, `/channels` to list them, and `/untrack` to stop collecting new posts from one. All channels contribute to the same server leaderboards. Existing single-channel settings migrate automatically on restart.

Use `/backfill limit:10000` to scan up to 10,000 messages **per tracked channel**. To import only one, use `/backfill channel:#daily-games limit:10000`. Channels are scanned sequentially in batches of at most 100 messages, with progress updates every 1,000 messages and between channels. Each channel stops at the requested limit or the beginning of its history. Unavailable channels are reported while other channels continue. Reimporting existing messages updates scores without duplicating them. A player's result for the same game and puzzle counts once across all channels; the newest source post wins. One backfill can run per server at a time; keep the bot running until it finishes. Re-register commands after updating to add `/untrack`, `/channels`, and the backfill channel option.

The leaderboard defaults to **Monthly**, adding together all scores posted during the current calendar month. Choose **All Time** from the period dropdown to total scores from every recorded month. Both views work for Overall and individual games. You can also run `/leaderboard period:alltime` or `/leaderboard game:maptapp period:monthly`.

The card shows each player as a separate block: their medal/rank and name, then indented lines for total points, the number of results (such as `97 games`), and average points per game. The average is the displayed total divided by that player's game count in the selected period. Overall cards add scores converted to 0–100 per result; per-game cards add native scores. Individual results are available through `/score`. The game dropdown, period dropdown, Previous/Next, and Refresh update the same private reply. Changing a game or period resets to page 1. The footer shows the month or All Time, page, player count, and update time. Only the person who opened the leaderboard can use its controls. If a game is disabled while the card is open, the next interaction returns to Overall; if a page disappears, it moves to the last available page. Discord may expire old private replies; run `/leaderboard` again when needed.

Monthly boundaries use the original Discord message posting timestamp in `America/Denver`, configured in `src/leaderboard-period.js`. This also applies to games that include a puzzle date: the posting date decides leaderboard membership. Backfill uses the original timestamp, and edits do not move a message to the current month. The view switches automatically when a new calendar month begins; Refresh loads the current month's standings. Changing the time-zone setting requires a restart. Re-register commands once to add the `period` option, then restart the bot. Existing stored scores can be totaled immediately, without a new backfill for this leaderboard change.

## Adding games

Templates contain exactly one `{puzzle}` and one `{score}` token. Replace the changing puzzle number or date with `{puzzle}` and the changing score with `{score}`. Scores may be signed or decimal numbers. Puzzles may be nonnegative integers, ISO dates such as `2026-10-20`, day-month-year dates such as `22.10.2026`, or English month dates such as `October 20` or `October 20, 2026`.

All other characters are literal, matching ignores letter case, and trailing text on each line (such as emojis) is allowed. Use the literal characters `\n` for a line break in a Discord command. An optional `{skip}` token on its own line between other template lines skips zero or more lines of results.

Krillion is preconfigured as:

```text
Krillion #{puzzle}\n{score}
```

It matches:

```text
Krillion #100 🦐
340

🫧🐟🫧🦑🏮🏮🦑
```

To add numeric Wordle results:

```text
/game add key:wordle name:Wordle template:Wordle {puzzle} {score}/6 direction:lower
```

Maptap is included automatically with the key `maptapp` and higher scores ranked first. Restart to add it to an existing tracked server, then run `/backfill` to import earlier posts. Existing games with that key and their enabled/disabled settings are preserved. Its built-in template reads the date and final score, skipping the individual results:

```text
www.maptap.gg {puzzle}\n{skip}\nFinal score: {score}
```

This template records `434` from the example below and skips the individual scores:

```text
www.maptap.gg October 26

94 97 60 32 9

Final score: 434
```

Date puzzles are stored as `YYYY-MM-DD`. When the share omits the year, the bot uses the date closest to the original message's UTC timestamp, considering the preceding, current, and following year. This keeps historical imports stable across restarts and avoids merging different years. A share posted many months after its puzzle can have an ambiguous year; use a template matching an explicit year when available. Query a dated puzzle with `/score game:maptapp puzzle:2026-10-20`.

Then run `/backfill` if you want to import existing posts. This version supports 25 games per server. Each message can contribute one result per matching game. Failure symbols such as Wordle `X/6`, times such as `1:23`, other nonnumeric puzzle IDs, and scores requiring calculations need future parser extensions. Failed results are currently ignored. Templates can be checked locally with the parser tests; editing an existing game's template is not yet exposed as a command.

## Codenames Daily

Codenames has a built-in parser because its score must be calculated from four rounds. It uses the game key `codenames` and is added automatically to existing tracked servers when the bot restarts, as well as new servers when `/track` runs. No `/game add` command is needed. Existing custom games with the same key are preserved.

The bot reads the `CODENAMES DAILY` heading, the `day.month.year` date, and four clue/result lines. Blank lines, the optional "Can you beat this?" footer, and the game's share link are supported. The publisher's [share example](https://www.czechgames.com/news/popular-daily-challenges-from-the-codenames-app-come-to-your-browser) uses `✅` for correct guesses and `❌` for an incorrect guess.

```text
CODENAMES DAILY

22.10.2026

ROMEO 2 ✅✅
POWERFUL 3 ✅✅✅
MEDIEVAL 4 ✅✅✅✅
SOUND 3 ✅✅✅
```

The configured scoring rule is:

```text
floor(
  30 × (correct guesses in round 1 / target words in round 1)
  + 30 × (correct guesses in round 2 / target words in round 2)
  + 30 × (correct guesses in round 3 / target words in round 3)
  + 10 × (correct guesses in round 4 / target words in round 4)
)
```

The example earns `floor(30 + 30 + 30 + 10) = 100`. Each of the first three rounds independently earns up to 30 points, regardless of how many target words it contains. The fourth independently adds up to 10 bonus points, with the complete score capped at 100. Only the final total is rounded down to an integer. Two perfect main rounds with zero in the other rounds earn 60. Correct guesses before a `❌` earn partial credit, and remaining unguessed target words earn none. The bot requires all four round results and ignores incomplete or malformed shares.

Run `/backfill` to import older Codenames shares, or recalculate previously imported shares after a scoring change. Use `/score game:codenames puzzle:22.10.2026` or `/leaderboard game:codenames`. Score lookups show the calculated integer score, with a maximum of 100. `/game disable game:codenames` pauses it without deleting saved scores. Old stored results retain their previous scoring until their source messages are reimported; backfill the relevant messages after updating.

## Music Timeliner

Music Timeliner is included automatically with the game key `musictimeliner`. Restart the bot to add it to existing tracked servers; `/game add` is not needed. Existing custom games with that key are preserved.

The parser reads the puzzle number and green/red result squares, with 12.5 points per green square and zero per red square. Only the final total is rounded down to an integer: three green squares earn `floor(37.5) = 37`, and eight earn the maximum score of 100. Results with more than eight squares are rejected. It supports actual Unicode emojis (`🟩` and `🟥`) and literal Discord aliases (`:green_square:` and `:red_square:`), including results spread across multiple lines. The website link is optional.

```text
Music Timeliner #29

🟩🟩🟥🟩🟥🟩🟩🟩

https://musictimeliner.com/
```

This example records a score of `75` for puzzle `29` (six green squares × 12.5). A result containing only red squares records `0`; a title and link without any squares records nothing. Results must include the square characters in the Discord message text.

After restarting, run `/backfill` to import existing shares or recalculate scores saved under the previous scoring rule, `/leaderboard game:musictimeliner` for standings, or `/score game:musictimeliner puzzle:29` for your result. Music Timeliner contributes equally to the overall leaderboard, using its score out of 100.

## Ranking rules

Per-game leaderboards rank players by their total recorded score within the selected period, with higher or lower totals winning according to the game's configured direction. These boards and `/score` keep Krillion and Maptap's native scoring units. Each Codenames and Music Timeliner result scores out of 100. Totals can exceed a single game's maximum.

The overall leaderboard converts each result to a score between 0 and 100 using a fixed game range:

```text
Higher is better: 100 × (score − minimum) / (maximum − minimum)
Lower is better:  100 × (maximum − score) / (maximum − minimum)
```

Each converted result is clamped to 0–100, then all converted results in the selected period are added together. For example, Krillion 350/700 contributes 50, Maptap 434/1000 contributes 43.4, Music Timeliner 75 contributes 75, and Codenames 100 contributes 100: the overall total is 268.4. Another perfect Krillion result adds 100 to reach 368.4; the Krillion-only total would be 350 + 700 = 1050. Each game result can contribute up to 100 overall points, so playing more daily puzzles adds more points. The accumulated total is not capped at 100. Other players' submissions do not change a player's points.

Score ranges are configured only in `src/scoring-config.js`. Built-in ranges are Krillion 0–700, Maptap 0–1000, and Codenames/Music Timeliner 0–100. Wordle is configured as 1–6. Maptap's [official scoring FAQ](https://maptap.gg/faq) explains its 1,000-point total. The Krillion daily scale is configured for seven 100-point rounds. Games without an entry in the code default to 0–100. For a game where lower scores win, the minimum maps to 100 and the maximum maps to 0. Use `/game list` to inspect ranges, or edit the code, for example:

```javascript
export const GAME_SCORE_RANGES = {
  krillion: [0, 700],
  maptapp: [0, 1000],
  maptap: [0, 1000],
  codenames: [0, 100],
  musictimeliner: [0, 100],
  wordle: [1, 6],
};
```

Restart the bot after editing score ranges; existing raw scores are converted using the new ranges without backfill. Previously saved database ranges are ignored in favor of the code settings. Run `npm run register` once to remove the old scale subcommand and range options from Discord, then restart. The Codenames round-scoring change requires `/backfill` to recalculate stored results using the original round data; the latest 10,000 messages can be scanned with `/backfill limit:10000`.

Unplayed games add no points. Participation counts the daily results included in the selected period, across all enabled games for Overall or within the selected game. Repeated posts still count only once per player, game, and puzzle. Tied totals share ranks. Both Krillion and any added games use their configured higher/lower direction; confirm the correct rule when adding a game.

## Storage and corrections

- Discord user IDs identify players even after a username change. The submitting username is also stored, and commands display Discord user mentions.
- Only one result per player, game, and puzzle counts. If multiple messages exist, the newest posted message wins; editing an older post does not move it ahead of a newer post.
- Reimporting a message is safe. Message edits replace its parsed results; removing the recognizable result removes its score. Deleting the winning message restores an earlier matching post if one is stored.
- Message edits and deletions are processed while connected. `/backfill` refreshes existing posts but cannot discover posts deleted while the bot was offline; those require a future reconciliation feature.
- Disabled games retain their saved scores. Re-enable and backfill to import posts shared while disabled.
- Adding a tracked channel keeps all existing channels. Untracking retains scores already recorded; subsequent posts and edits from that channel are ignored. Backfill scans all currently tracked channels unless one is selected explicitly.
- Data defaults to `data/scores.sqlite`; set `DATABASE_PATH` to change it. Stop the bot before copying the database for a simple consistent backup. Retain the database across redeployments.

## Development

```powershell
npm test
```

The tests exercise parsing, real SQLite persistence and correction behavior, server isolation, and equal game weighting without connecting to Discord. Live Discord behavior requires a configured token and server.

Source modules: `src/parser.js` reads share templates; `src/codenames.js` parses and scores Codenames results; `src/musictimeliner.js` counts Music Timeliner result squares; `src/store.js` persists submissions; `src/rankings.js` calculates standings; `src/commands.js` defines slash commands; `src/handlers.js` handles requests; `src/index.js` handles Discord events. SQLite uses [Node's built-in SQLite API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html).
