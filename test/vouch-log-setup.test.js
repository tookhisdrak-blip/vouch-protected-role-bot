const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChannelType, Collection, PermissionFlagsBits } = require('discord.js');
const Database = require('better-sqlite3');
const { createDatabase } = require('../src/database');
const { setupVouchLogs } = require('../src/commands/admin');
const { categoryForEvent, logEvent } = require('../src/services/eventLogger');
const { handleMessageCreate } = require('../src/events/messageCreate');

function createSetupFixture(databasePath = ':memory:') {
  const db = createDatabase(databasePath);
  const guild = {
    id: 'guild-id',
    ownerId: 'owner-id',
    roles: { cache: new Collection() },
    channels: { cache: new Collection() },
    members: {
      me: { permissions: { has: (permission) => permission === PermissionFlagsBits.ManageChannels } }
    }
  };
  let nextChannelId = 1;
  const created = [];
  guild.channels.create = async (options) => {
    const channel = createChannel(`log-${nextChannelId++}`, options.name);
    created.push({ options, channel });
    guild.channels.cache.set(channel.id, channel);
    return channel;
  };
  const replies = [];
  const message = {
    guild,
    author: { id: guild.ownerId },
    content: '-vouchlogsetup',
    async reply(payload) {
      replies.push(payload);
      return payload;
    }
  };
  const client = { user: { id: 'bot-id' } };
  return { db, guild, message, client, created, replies };
}

function createChannel(id, name) {
  const channel = {
    id,
    name,
    type: ChannelType.GuildText,
    isTextBased: () => true,
    sent: [],
    async send(payload) {
      channel.sent.push(payload);
    },
    permissionOverwrites: {
      updates: [],
      async set(overwrites, reason) {
        this.updates.push({ overwrites, reason });
      }
    }
  };
  return channel;
}

test('Guild Owner setup creates private log channels, reuses them, and persists their IDs', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vouch-logs-'));
  const databasePath = path.join(directory, 'state.sqlite');
  const fixture = createSetupFixture(databasePath);
  t.after(() => {
    if (fixture.db.connection.open) fixture.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  fixture.db.ensureGuild(fixture.guild.id);
  await handleMessageCreate(fixture.message, fixture.client, fixture.db, '-');

  assert.equal(fixture.created.length, 4);
  assert.deepEqual(fixture.created.map(({ options }) => options.name), [
    'vouch-logs', 'ban-logs', 'main-logs', 'admin-logs'
  ]);
  for (const { options } of fixture.created) {
    const everyone = options.permissionOverwrites.find((overwrite) => overwrite.id === fixture.guild.id);
    const owner = options.permissionOverwrites.find((overwrite) => overwrite.id === fixture.guild.ownerId);
    const bot = options.permissionOverwrites.find((overwrite) => overwrite.id === fixture.client.user.id);
    assert.ok(everyone.deny.includes(PermissionFlagsBits.ViewChannel));
    assert.ok(owner.allow.includes(PermissionFlagsBits.ViewChannel));
    assert.ok(bot.allow.includes(PermissionFlagsBits.ViewChannel));
  }
  const configured = fixture.db.getLogChannels(fixture.guild.id);
  assert.equal(configured.length, 4);
  const persistedIds = Object.fromEntries(configured.map(({ category, channel_id: channelId }) => [category, channelId]));
  assert.ok(fixture.replies[0].embeds[0].data.description.includes('<#log-1>'));
  assert.equal(fixture.db.connection.prepare("SELECT COUNT(*) AS count FROM event_logs WHERE event_type = 'LOG CHANNELS CONFIGURED'").get().count, 1);

  fixture.db.close();
  fixture.db = createDatabase(databasePath);
  assert.deepEqual(Object.fromEntries(fixture.db.getLogChannels(fixture.guild.id)
    .map(({ category, channel_id: channelId }) => [category, channelId])), persistedIds);
  await handleMessageCreate(fixture.message, fixture.client, fixture.db, '-');
  assert.equal(fixture.created.length, 4, 'the second setup must not create duplicates');
  assert.equal(fixture.created[0].channel.permissionOverwrites.updates.length, 1);
});

test('setup adopts existing log channels that have not yet been saved in SQLite', async (t) => {
  const { db, guild, message, client, created } = createSetupFixture();
  t.after(() => db.close());
  db.ensureGuild(guild.id);
  for (const [index, name] of ['vouch-logs', 'ban-logs', 'main-logs', 'admin-logs'].entries()) {
    const channel = createChannel(`existing-${index}`, name);
    guild.channels.cache.set(channel.id, channel);
  }

  await handleMessageCreate(message, client, db, '-');

  assert.equal(created.length, 0);
  assert.equal(db.getLogChannels(guild.id).length, 4);
  assert.ok([...guild.channels.cache.values()].every((channel) => channel.permissionOverwrites.updates.length === 1));
});

test('only the actual Guild Owner may create the log channels', async (t) => {
  const { db, guild, message, client, created, replies } = createSetupFixture();
  t.after(() => db.close());
  db.ensureGuild(guild.id);
  db.addOwnerAllowed(guild.id, 'allowed-user', guild.ownerId);
  message.author.id = 'allowed-user';

  await handleMessageCreate(message, client, db, '-');

  assert.equal(created.length, 0);
  assert.match(replies[0].embeds[0].data.description, /Only the Guild Owner/);
});

test('setup explains the missing Manage Channels permission without starting channel creation', async (t) => {
  const { db, guild, message, client, created, replies } = createSetupFixture();
  t.after(() => db.close());
  guild.members.me.permissions.has = () => false;

  await setupVouchLogs(message, db, client);

  assert.equal(created.length, 0);
  assert.match(replies[0].embeds[0].data.description, /Manage Channels permission/);
});

test('log events use compact category embeds and persist reward details', async (t) => {
  const { db, guild } = createSetupFixture();
  t.after(() => db.close());
  db.ensureGuild(guild.id);
  const vouchChannel = createChannel('vouch-log-channel', 'vouch-logs');
  const banChannel = createChannel('ban-log-channel', 'ban-logs');
  guild.channels.cache.set(vouchChannel.id, vouchChannel);
  guild.channels.cache.set(banChannel.id, banChannel);
  db.setLogChannel(guild.id, 'vouch', vouchChannel.id);
  db.setLogChannel(guild.id, 'ban', banChannel.id);

  await logEvent(guild, db, {
    event_type: 'VOUCH GIVEN',
    executor_id: 'giver-id',
    affected_user_id: 'target-id',
    action_taken: 'Vouch recorded; configured roles assigned',
    punishment: null,
    reward: 'Assigned <@&reward-role>'
  });
  await logEvent(guild, db, {
    event_type: 'FORCE: FOREVER BAN CREATED',
    executor_id: 'admin-id',
    affected_user_id: 'banned-id',
    action_taken: 'Ban applied',
    punishment: null
  });

  assert.equal(vouchChannel.sent.length, 1);
  assert.equal(banChannel.sent.length, 1);
  const vouchEmbed = vouchChannel.sent[0].embeds[0].data;
  assert.equal(vouchEmbed.title, 'VOUCH GIVEN');
  assert.equal(vouchEmbed.fields.length, 5);
  assert.equal(vouchEmbed.fields.find(({ name }) => name === 'Who').value, '<@giver-id>');
  assert.equal(vouchEmbed.fields.find(({ name }) => name === 'Target').value, '<@target-id>');
  assert.equal(vouchEmbed.fields.find(({ name }) => name === 'Reward').value, 'Assigned <@&reward-role>');
  assert.deepEqual(vouchChannel.sent[0].allowedMentions.parse, []);
  assert.equal(db.connection.prepare("SELECT reward FROM event_logs WHERE event_type = 'VOUCH GIVEN'").get().reward, 'Assigned <@&reward-role>');
  assert.equal(categoryForEvent('VOUCH ROLE RESTORED'), 'vouch');
  assert.equal(categoryForEvent('ROLE LIMIT VIOLATION'), 'main');
  assert.equal(categoryForEvent('FAKE PERMISSION UPDATED'), 'admin');
  assert.equal(categoryForEvent('FORCE: FOREVER BAN REMOVED'), 'ban');
});

test('event-log reward migration preserves existing log history', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vouch-log-migration-'));
  const databasePath = path.join(directory, 'legacy.sqlite');
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE guild_settings (
      guild_id TEXT PRIMARY KEY, os_role_id TEXT, vouch_role_id TEXT, reward_role_id TEXT,
      stripstaff_role_id TEXT, log_channel_id TEXT, default_giver_limit INTEGER NOT NULL DEFAULT 2
    );
    CREATE TABLE event_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, event_type TEXT NOT NULL,
      executor_id TEXT, affected_user_id TEXT, role_id TEXT, reason TEXT, action_taken TEXT NOT NULL,
      punishment TEXT, created_at TEXT NOT NULL
    );
    INSERT INTO guild_settings (guild_id) VALUES ('legacy-guild');
    INSERT INTO event_logs (guild_id, event_type, action_taken, created_at)
      VALUES ('legacy-guild', 'OLD EVENT', 'History retained', '2026-09-29T00:00:00.000Z');
  `);
  legacy.close();

  const db = createDatabase(databasePath);
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(db.connection.prepare('SELECT action_taken FROM event_logs WHERE event_type = ?').get('OLD EVENT').action_taken, 'History retained');
  assert.ok(db.connection.pragma('table_info(event_logs)').some((column) => column.name === 'reward'));
});
