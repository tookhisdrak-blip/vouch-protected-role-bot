const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection } = require('discord.js');
const { after } = require('node:test');
const { createDatabase } = require('../src/database');
const dashboard = require('../src/commands/vouchCommands');
const { handlers, handleMessageCreate } = require('../src/events/messageCreate');
const { isFounder } = require('../src/services/permissions');

after(() => dashboard.clearAllPanels());

function createFixture(guildId = 'dashboard-guild') {
  const db = createDatabase(':memory:');
  db.ensureGuild(guildId);
  const guild = {
    id: guildId,
    ownerId: 'guild-owner',
    members: { cache: new Collection() }
  };
  guild.members.fetch = async (userId) => userId ? guild.members.cache.get(userId) || null : guild.members.cache;

  function addMember(id) {
    const member = {
      id,
      guild,
      user: { id, bot: false, username: id, tag: `${id}#0001` },
      roles: { cache: new Collection() }
    };
    guild.members.cache.set(id, member);
    return member;
  }

  return { db, guild, addMember };
}

async function openPanel(member, guild, db) {
  const sentMessages = [];
  const replies = [];
  let nextMessageId = sentMessages.length + 1;
  const channel = {
    id: `channel-${guild.id}`,
    async send(payload) {
      const sent = {
        id: `dashboard-${guild.id}-${nextMessageId++}`,
        channelId: this.id,
        payload,
        deleted: false,
        async delete() { this.deleted = true; },
        async edit(update) { this.payload = { ...this.payload, ...update }; return this; }
      };
      sentMessages.push(sent);
      return sent;
    }
  };
  const message = {
    guild,
    member,
    author: member.user,
    authorId: member.id,
    content: '-vouchcommands',
    channel,
    client: { guilds: { cache: new Collection([[guild.id, guild]]) } },
    async reply(payload) { replies.push(payload); return payload; }
  };
  await handleMessageCreate(message, message.client, db, '-');
  return { panel: sentMessages[0]?.payload, dashboardMessage: sentMessages[0], sentMessages, replies, client: message.client, channel };
}

function embedText(payload) {
  const data = payload.embeds[0].data;
  return [data.title, data.description, ...(data.fields || []).flatMap((field) => [field.name, field.value])].join('\n');
}

function shownCommands(embedOrPayload) {
  const data = embedOrPayload.embeds ? embedOrPayload.embeds[0].data : embedOrPayload;
  return (data.description || '').split('\n').map((line) => line.match(/^`([^`]+)` — /)?.[1]).filter(Boolean);
}

function categoryId(panel) {
  return panel.components[0].components[0].data.custom_id;
}

async function selectCategory(user, guild, client, panel, category, db) {
  let payload;
  let replyPayload;
  const panelId = categoryId(panel).split(':')[1];
  const state = dashboard.panels.get(panelId);
  const handled = await dashboard.handleInteraction({
    customId: categoryId(panel),
    client,
    user,
    message: state.message,
    channelId: state.channelId,
    values: [category],
    async reply(next) { replyPayload = next; },
    async update(next) { payload = next; }
  }, db);
  return { handled, payload, replyPayload };
}

function buttonId(payload, action) {
  const button = payload.components.flatMap((row) => row.components)
    .find((component) => component.data.custom_id?.endsWith(`:${action}`));
  assert.ok(button, `Expected ${action} button`);
  return button.data.custom_id;
}

async function clickButton(user, client, payload, action, db) {
  let updated;
  let replied;
  const customId = buttonId(payload, action);
  const state = dashboard.panels.get(customId.split(':')[1]);
  const handled = await dashboard.handleInteraction({
    customId,
    client,
    user,
    message: state.message,
    channelId: state.channelId,
    async update(next) { updated = next; },
    async reply(next) { replied = next; }
  }, db);
  return { handled, updated, replied };
}

test('`-vouchcommands` opens publicly in the originating channel with a dropdown and navigation controls', async (t) => {
  const { db, guild, addMember } = createFixture();
  t.after(() => db.close());
  const regular = addMember('regular');
  const { panel, replies } = await openPanel(regular, guild, db);

  assert.equal(handlers.has('vouchcommands'), true);
  assert.equal(panel.embeds[0].data.title, 'Vouch Management');
  assert.equal(panel.embeds[0].data.description, 'Click a category below to view its commands.');
  assert.equal(panel.embeds[0].data.fields, undefined, 'the home page lists no commands');
  assert.equal(panel.ephemeral, undefined);
  assert.equal(panel.allowedMentions.parse.length, 0);
  assert.equal(replies.length, 0, 'the dashboard itself is sent directly to the channel');
  assert.equal(regular.user.send, undefined, 'the dashboard must not be sent by DM');
  assert.equal(panel.components[0].components[0].data.placeholder, 'Select a category');
  const categoryOptions = panel.components[0].components[0].options.map((option) => option.data.value);
  assert.deepEqual(categoryOptions, ['info', 'limited', 'locks', 'all', 'permissions']);
  assert.equal(panel.components[0].components[0].data.custom_id, categoryId(panel));
  const homeLabels = panel.components.slice(1).flatMap((row) => row.components.map((component) => component.data.label));
  assert.deepEqual(homeLabels, ['Vouch Information', 'Limited Roles', 'Role Locks', 'All Commands', 'Your Permissions'], 'home shows only category buttons');
  const state = dashboard.panels.get(categoryId(panel).split(':')[1]);
  assert.equal(state.channelId, `channel-${guild.id}`);
  assert.equal(state.messageId, `dashboard-${guild.id}-1`);
  assert.equal(state.lastInteractionAt + dashboard.INACTIVITY_TIMEOUT_MS, state.expiresAt);
  assert.equal(panel.allowedMentions.parse.length, 0);
});

test('Any authorized channel member can navigate the public panel and resets its 5-minute timer', async (t) => {
  const { db, guild, addMember } = createFixture('multi-user-dashboard');
  t.after(() => db.close());
  const owner = addMember(guild.ownerId);
  const viewer = addMember('viewer');
  const { panel, client } = await openPanel(owner, guild, db);
  const panelId = categoryId(panel).split(':')[1];
  const state = dashboard.panels.get(panelId);
  const lastInteraction = state.lastInteractionAt;
  const realNow = Date.now;
  const simulatedNow = realNow() + 5000;
  let selected;
  Date.now = () => simulatedNow;
  try {
    selected = await selectCategory(viewer.user, guild, client, panel, 'info', db);
  } finally {
    Date.now = realNow;
  }

  assert.equal(selected.handled, true);
  assert.match(selected.payload.embeds[0].data.title, /Vouch Information/);
  assert.ok(state.lastInteractionAt > lastInteraction);
  assert.equal(state.lastInteractionAt, simulatedNow);
  assert.equal(state.expiresAt - state.lastInteractionAt, 5 * 60_000);
  assert.equal(state.messageId, selected.payload.components[0].components[0].data.custom_id ? state.messageId : null);
});

test('5 minutes of inactivity deletes only the dashboard and clears its timer state', async (t) => {
  const { db, guild, addMember } = createFixture('expiry-dashboard');
  t.after(() => db.close());
  const owner = addMember(guild.ownerId);
  const { panel, dashboardMessage } = await openPanel(owner, guild, db);
  const panelId = categoryId(panel).split(':')[1];
  const state = dashboard.panels.get(panelId);
  assert.equal(state.expiresAt - state.lastInteractionAt, dashboard.INACTIVITY_TIMEOUT_MS);
  assert.ok(state.timer);

  state.expiresAt = Date.now() - 1;
  assert.equal(await dashboard.expirePanel(panelId), true);

  assert.equal(dashboardMessage.deleted, true);
  assert.equal(state.timer, null);
  assert.equal(dashboard.panels.has(panelId), false);
});

test('Expiring one dashboard cannot delete another dashboard in a different channel', async (t) => {
  const firstFixture = createFixture('channel-one');
  const secondFixture = createFixture('channel-two');
  t.after(() => {
    firstFixture.db.close();
    secondFixture.db.close();
  });
  const firstOwner = firstFixture.addMember(firstFixture.guild.ownerId);
  const secondOwner = secondFixture.addMember(secondFixture.guild.ownerId);
  const firstPanel = await openPanel(firstOwner, firstFixture.guild, firstFixture.db);
  const secondPanel = await openPanel(secondOwner, secondFixture.guild, secondFixture.db);
  const firstId = categoryId(firstPanel.panel).split(':')[1];
  const secondId = categoryId(secondPanel.panel).split(':')[1];

  dashboard.panels.get(firstId).expiresAt = Date.now() - 1;
  assert.equal(await dashboard.expirePanel(firstId), true);

  assert.equal(firstPanel.dashboardMessage.deleted, true);
  assert.equal(secondPanel.dashboardMessage.deleted, false);
  assert.equal(dashboard.panels.has(firstId), false);
  assert.equal(dashboard.panels.has(secondId), true);
  await dashboard.expirePanel(secondId);
});

test('Category pages list only that category in compact one-line entries with simple navigation', async (t) => {
  const { db, guild, addMember } = createFixture('vouch-dashboard');
  t.after(() => db.close());
  const owner = addMember(guild.ownerId);
  const { panel, client } = await openPanel(owner, guild, db);
  const ownerCategories = panel.components[0].components[0].options.map((option) => option.data.value);
  assert.deepEqual(ownerCategories, ['giving', 'info', 'givers', 'roles', 'limited', 'locks', 'access', 'blacklist', 'admin', 'force', 'forever', 'all', 'permissions']);
  const homeButtons = panel.components.slice(1).flatMap((row) => row.components);
  assert.equal(homeButtons.length, ownerCategories.length, 'home has one button per category and no navigation row');
  assert.equal(panel.components.length, 4);

  const selected = await selectCategory(owner.user, guild, client, panel, 'giving', db);
  assert.equal(selected.handled, true);
  const page = selected.payload.embeds[0].data;
  assert.equal(page.title, 'Giving & Removing');
  assert.equal(page.description, '`-vouch give @user [reason]` — Give a user a vouch\n`-vouch take @user [reason]` — Remove a vouch\n`-vouch admin take @user [reason]` — Remove any user\'s vouch');
  assert.equal(page.fields, undefined, 'no large per-command fields');
  assert.match(page.footer.text, /^Page 1\/1 \| 3 commands \| Closes after 5 minutes of inactivity$/);
  assert.doesNotMatch(page.description, /Access:/);
  assert.equal(selected.payload.components[0].components[0].data.placeholder, 'Select a category', 'dropdown stays available');
  assert.equal(selected.payload.components.length, 2, 'dropdown and the navigation row only');
  const navLabels = selected.payload.components[1].components.map((button) => button.data.label);
  assert.deepEqual(navLabels, ['Home', 'Back', 'Previous', 'Next']);
  for (const component of selected.payload.components[1].components) {
    assert.equal(component.data.emoji, undefined, 'buttons do not use emojis');
  }

  const givers = await selectCategory(owner.user, guild, client, selected.payload, 'givers', db);
  assert.equal(givers.payload.embeds[0].data.title, 'Giver Management');
  assert.match(embedText(givers.payload), /-vouch addgiver @user/);
  assert.match(embedText(givers.payload), /-vouch limit remove @user/);
  assert.doesNotMatch(embedText(givers.payload), /-vouch give @user/, 'only the selected category is shown');
  assert.ok(shownCommands(givers.payload).length <= dashboard.PAGE_SIZE);
  for (const line of givers.payload.embeds[0].data.description.split('\n')) {
    assert.ok(line.length <= 90, `compact line: ${line}`);
  }
  assert.equal(db.getVouches(guild.id).length, 0, 'dashboard controls must never execute commands');
});

test('every primary command has a short one-line description', () => {
  for (const entry of dashboard.primaryCommands()) {
    assert.ok(dashboard.shortDescription(entry).length <= 60, `${entry.command} description is short`);
    assert.doesNotMatch(dashboard.shortDescription(entry), /\n/);
  }
});
test('Force Management lists registered commands and renders alias information without duplicate entries', async (t) => {
  const { db, guild, addMember } = createFixture('force-dashboard');
  t.after(() => db.close());
  const founder = addMember('dashboard-founder');
  const prior = process.env.FORCE_FOUNDER_IDS;
  process.env.FORCE_FOUNDER_IDS = founder.id;
  try {
    const { panel, client } = await openPanel(founder, guild, db);
    const selected = await selectCategory(founder.user, guild, client, panel, 'force', db);
    const secondPage = (await clickButton(founder.user, client, selected.payload, 'next', db)).updated;
    assert.equal(secondPage.embeds[0].data.title, 'Force Management');
    assert.match(secondPage.embeds[0].data.footer.text, /^Page 2\/2 /);
    const description = `${embedText(selected.payload)}\n${embedText(secondPage)}`;
    assert.match(description, /-forcenickname @user/);
    assert.match(description, /-forcerolestrip @user @role/);
    assert.match(description, /-rolestrip @role-name\/id/);
    assert.match(description, /\(alias `-forcestrip`\)/);
    const commandNames = [...shownCommands(selected.payload), ...shownCommands(secondPage)];
    assert.equal(commandNames.some((name) => name.startsWith('-forcestrip')), false, 'aliases are not listed as duplicate entries');
    assert.equal(new Set(commandNames).size, commandNames.length);
  } finally {
    if (prior === undefined) delete process.env.FORCE_FOUNDER_IDS;
    else process.env.FORCE_FOUNDER_IDS = prior;
  }
});

test('Forever Bans is visible and renderable only for fake ban_members holders (Guild Owner automatically)', async (t) => {
  const { db, guild, addMember } = createFixture('forever-dashboard');
  t.after(() => db.close());
  const owner = addMember(guild.ownerId);
  const founder = addMember('forever-founder');
  const holder = addMember('forever-holder');
  db.addFakePermission(guild.id, 'user', holder.id, 'ban_members', owner.id);
  assert.ok(dashboard.categoriesFor(holder, db).includes('forever'));
  assert.deepEqual(dashboard.getEntries('forever', holder, db).map((entry) => entry.command), ['-foreverban @user [reason]', '-unforeverban @user', '-foreverbanlist [page]']);
  const prior = process.env.FORCE_FOUNDER_IDS;
  process.env.FORCE_FOUNDER_IDS = founder.id;
  try {
    const ownerPanel = await openPanel(owner, guild, db);
    const ownerOptions = ownerPanel.panel.components[0].components[0].options.map((option) => option.data.value);
    assert.ok(ownerOptions.includes('forever'));
    const ownerView = await selectCategory(owner.user, guild, ownerPanel.client, ownerPanel.panel, 'forever', db);
    assert.match(embedText(ownerView.payload), /-foreverban @user/);

    const founderPanel = await openPanel(founder, guild, db);
    const founderOptions = founderPanel.panel.components[0].components[0].options.map((option) => option.data.value);
    assert.equal(founderOptions.includes('forever'), false);
    const denied = await selectCategory(founder.user, guild, founderPanel.client, founderPanel.panel, 'forever', db);
    assert.equal(denied.replyPayload.ephemeral, true);
    assert.match(denied.replyPayload.embeds[0].data.description, /not authorized/);
    assert.equal(denied.handled, true);
  } finally {
    if (prior === undefined) delete process.env.FORCE_FOUNDER_IDS;
    else process.env.FORCE_FOUNDER_IDS = prior;
  }
});

test('All Commands is paginated and Previous/Next buttons navigate without executing commands', async (t) => {
  const { db, guild, addMember } = createFixture('all-dashboard');
  t.after(() => db.close());
  const owner = addMember(guild.ownerId);
  const { panel, client } = await openPanel(owner, guild, db);
  const all = await selectCategory(owner.user, guild, client, panel, 'all', db);
  assert.match(all.payload.embeds[0].data.footer.text, /^Page 1\//);
  assert.ok(all.payload.components[1]);
  const nextResult = await clickButton(owner.user, client, all.payload, 'next', db);
  const secondPage = nextResult.updated;
  assert.match(secondPage.embeds[0].data.footer.text, /^Page 2\//);
  const previousResult = await clickButton(owner.user, client, secondPage, 'previous', db);
  const firstPageAgain = previousResult.updated;
  assert.match(firstPageAgain.embeds[0].data.footer.text, /^Page 1\//);
  assert.equal(db.getVouches(guild.id).length, 0);
});

test('Back and Home buttons navigate through category history', async (t) => {
  const { db, guild, addMember } = createFixture('back-dashboard');
  t.after(() => db.close());
  const owner = addMember(guild.ownerId);
  const { panel, client } = await openPanel(owner, guild, db);
  const vouch = await selectCategory(owner.user, guild, client, panel, 'giving', db);
  const force = await selectCategory(owner.user, guild, client, vouch.payload, 'force', db);
  assert.match(force.payload.embeds[0].data.title, /Force Management/);

  const backResult = await clickButton(owner.user, client, force.payload, 'back', db);
  const backPayload = backResult.updated;
  assert.match(backPayload.embeds[0].data.title, /Giving & Removing/);

  const homeResult = await clickButton(owner.user, client, backPayload, 'home', db);
  const homePayload = homeResult.updated;
  assert.equal(homePayload.embeds[0].data.title, 'Vouch Management');
  assert.equal(homePayload.components[0].components[0].data.placeholder, 'Select a category');
});

test('Permissions category reports current access without exposing unauthorized command data', async (t) => {
  const { db, guild, addMember } = createFixture('permissions-dashboard');
  t.after(() => db.close());
  const regular = addMember('regular');
  const { panel, client } = await openPanel(regular, guild, db);
  const selected = await selectCategory(regular.user, guild, client, panel, 'permissions', db);
  assert.match(selected.payload.embeds[0].data.description, /Regular member/);
  assert.match(selected.payload.embeds[0].data.description, /need the fake ban_members permission/);
  assert.doesNotMatch(selected.payload.embeds[0].data.description, /-foreverban @user/);
});

test('Unauthorized users cannot interact with another user panel or force an unauthorized dropdown selection', async (t) => {
  const { db, guild, addMember } = createFixture('unauthorized-dashboard');
  t.after(() => db.close());
  const owner = addMember(guild.ownerId);
  const attacker = addMember('attacker');
  const { panel, client, replies } = await openPanel(owner, guild, db);
  const customId = categoryId(panel);
  let unauthorizedReplies = 0;
  let panelUpdates = 0;

  await dashboard.handleInteraction({
    customId,
    client,
    user: attacker.user,
    values: ['forever'],
    async reply(payload) { unauthorizedReplies += 1; assert.equal(payload.ephemeral, true); },
    async update() { panelUpdates += 1; }
  }, db);
  assert.equal(unauthorizedReplies, 1);
  assert.equal(panelUpdates, 0);

  let buttonReply;
  await dashboard.handleInteraction({
    customId: buttonId(panel, 'forever'),
    client,
    user: attacker.user,
    message: dashboard.panels.get(customId.split(':')[1]).message,
    channelId: `channel-${guild.id}`,
    async reply(payload) { buttonReply = payload; },
    async update() { panelUpdates += 1; }
  }, db);
  assert.equal(buttonReply.ephemeral, true);
  assert.equal(panelUpdates, 0);

  const regularPanel = await openPanel(attacker, guild, db);
  let forbiddenReply;
  await dashboard.handleInteraction({
    customId: categoryId(regularPanel.panel),
    client,
    user: attacker.user,
    values: ['forever'],
    async reply(payload) { forbiddenReply = payload; },
    async update() { panelUpdates += 1; }
  }, db);
  assert.equal(forbiddenReply.ephemeral, true);
  assert.equal(panelUpdates, 0);
  assert.equal(replies.length, 0);
});

test('Expired dashboards and invalid component actions receive clean ephemeral errors', async (t) => {
  const { db, guild, addMember } = createFixture('expired-dashboard');
  t.after(() => db.close());
  const owner = addMember(guild.ownerId);
  const { panel, client } = await openPanel(owner, guild, db);
  const id = panel.components[0].components[0].data.custom_id.split(':')[1];
  const state = dashboard.panels.get(id);
  state.expiresAt = Date.now() - 1;
  let expiredReply;
  await dashboard.handleInteraction({
    customId: categoryId(panel),
    client,
    user: owner.user,
    values: ['all'],
    async reply(payload) { expiredReply = payload; }
  }, db);
  assert.equal(expiredReply.ephemeral, true);
  assert.equal(dashboard.panels.has(id), false);
});

test('Dashboard discovers commands from the current prefix registry and does not invent routes', (t) => {
  const { db, guild, addMember } = createFixture('registry-dashboard');
  t.after(() => db.close());
  const owner = addMember(guild.ownerId);
  const registeredRoots = new Set([...handlers.keys()]);
  const discovered = dashboard.registeredCatalog();
  assert.ok(discovered.length > 0);
  for (const entry of discovered) {
    const root = entry.command.slice(1).trim().split(/\s+/)[0].toLowerCase();
    assert.ok(registeredRoots.has(root), `${entry.command} must map to a registered root`);
  }
  handlers.set('forcefuturecommand', () => null);
  try {
    const discoveredNewRoot = dashboard.registeredCatalog().find((entry) => entry.command === '-forcefuturecommand');
    assert.ok(discoveredNewRoot);
    assert.equal(discoveredNewRoot.permission, 'force');
    assert.ok(dashboard.getEntries('force', owner, db).some((entry) => entry.command === '-forcefuturecommand'));
  } finally {
    handlers.delete('forcefuturecommand');
  }
  assert.ok(dashboard.categoriesFor(owner, db).includes('forever'));
  assert.equal(isFounder(owner), false);
});

test('`-vouchhelp` opens the same category dashboard, supports category/page shortcuts, and works from edited messages', async (t) => {
  const { db, guild, addMember } = createFixture('vouchhelp-dashboard');
  t.after(() => db.close());
  const owner = addMember(guild.ownerId);
  const { handleMessageUpdate } = require('../src/events/messageCreate');
  const sent = [];
  const replies = [];
  const client = { guilds: { cache: new Collection([[guild.id, guild]]) } };
  const channel = {
    id: `channel-${guild.id}`,
    async send(payload) {
      const message = { id: `help-${sent.length + 1}`, payload, async delete() {}, async edit() { return this; } };
      sent.push(message);
      return message;
    }
  };
  const makeHelpMessage = (content) => ({
    guild, member: owner, author: owner.user, content, channel, client,
    async reply(payload) { replies.push(payload); return payload; }
  });

  assert.equal(handlers.has('vouchhelp'), true);
  await handleMessageCreate(makeHelpMessage('-vouchhelp'), client, db, '-');
  assert.equal(sent[0].payload.embeds[0].data.title, 'Vouch Management');
  assert.equal(sent[0].payload.components[0].components[0].data.placeholder, 'Select a category');
  assert.ok(buttonId(sent[0].payload, 'limited'));

  await handleMessageCreate(makeHelpMessage('-vouchhelp limited'), client, db, '-');
  assert.equal(sent[1].payload.embeds[0].data.title, 'Limited Roles');
  assert.match(sent[1].payload.embeds[0].data.footer.text, /^Page 1\/1 /);
  assert.ok(shownCommands(sent[1].payload).includes('-setlimit @role|ROLE_ID number'));

  await handleMessageUpdate({ content: 'hello' }, makeHelpMessage('-vouchhelp 2'), client, db, '-');
  assert.equal(sent[2].payload.embeds[0].data.title, 'All Commands');
  assert.match(sent[2].payload.embeds[0].data.footer.text, /^Page 2\/\d+ /);
  const state = dashboard.panels.get(buttonId(sent[2].payload, 'next').split(':')[1]);
  assert.equal(state.commandName, 'vouchhelp');
  let updated;
  await dashboard.handleInteraction({
    customId: buttonId(sent[2].payload, 'previous'),
    client,
    user: owner.user,
    message: state.message,
    channelId: state.channelId,
    async update(next) { updated = next; },
    async reply() { assert.fail('navigation should update the panel'); }
  }, db);
  assert.match(updated.embeds[0].data.footer.text, /^Page 1\//);

  await handleMessageCreate(makeHelpMessage('-vouchhelp nonsense'), client, db, '-');
  assert.match(replies.at(-1).embeds[0].data.description, /Use a valid category bro/);
  await handleMessageCreate(makeHelpMessage('-vouchhelp 0'), client, db, '-');
  assert.match(replies.at(-1).embeds[0].data.description, /positive page number bro/);
  assert.equal(sent.length, 3);
});

test('Help catalog exactly matches the registered handlers and every -vouch/-vouchblacklist/force subcommand', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { catalog } = require('../src/commands/help');
  const source = (file) => fs.readFileSync(path.join(__dirname, '..', 'src', 'commands', file), 'utf8');
  const commands = catalog.map((entry) => entry.command);
  assert.equal(new Set(commands).size, commands.length, 'no catalog command is listed twice');
  const primary = dashboard.primaryCommands();
  assert.equal(new Set(primary.map((entry) => entry.command)).size, primary.length);
  for (const entry of catalog.filter((item) => item.aliasOf)) {
    assert.ok(catalog.some((item) => item.command === entry.aliasOf && !item.aliasOf), `${entry.command} aliases a real primary command`);
  }

  const roots = new Set(catalog.map((entry) => entry.command.slice(1).split(/\s+/)[0].toLowerCase()));
  assert.deepEqual([...roots].sort(), [...handlers.keys()].sort(), 'every registered root is catalogued and no fake root exists');
  assert.equal(dashboard.registeredCatalog().some((entry) => /not yet configured/.test(entry.summary)), false, 'no registered command relies on fallback metadata');

  const vouchCases = [...source('vouch.js').matchAll(/case '([a-z]+)':/g)].map((match) => match[1]).sort();
  const vouchCatalogued = [...new Set(commands.filter((command) => command.startsWith('-vouch ')).map((command) => command.split(/\s+/)[1]))].sort();
  assert.deepEqual(vouchCatalogued, vouchCases, '-vouch subcommands in help match vouch.js exactly');
  const blacklistActions = [...source('admin.js').matchAll(/action\?\.toLowerCase\(\) === '([a-z]+)'/g)].map((match) => match[1]).sort();
  const blacklistCatalogued = commands.filter((command) => command.startsWith('-vouchblacklist ')).map((command) => command.split(/\s+/)[1]).sort();
  assert.deepEqual(blacklistCatalogued, blacklistActions);
  const forceRoots = [...new Set([...source('forceManagement.js').matchAll(/command === '([a-z]+)'/g)].map((match) => match[1]))].sort();
  const forceCatalogued = [...roots].filter((root) => forceRoots.includes(root)).sort();
  assert.deepEqual(forceCatalogued, forceRoots, 'every force-management command is catalogued');

  for (const required of [
    '-setlimit @role|ROLE_ID number', '-limitedroles', '-vouch setrole @role', '-vouch unsetrole', '-vouch addgiver @user',
    '-vouch removegiver @user', '-vouch limit [number]', '-vouch limit @user [number]', '-vouch limit remove @user',
    '-vouch wipeall', '-vouch setreward @role', '-vouch give @user [reason]'
  ]) {
    assert.ok(primary.some((entry) => entry.command === required), `${required} is shown as a primary dashboard command`);
  }
});

test('Displayed access labels match the real command permission gates', async (t) => {
  const { db, guild, addMember } = createFixture('permission-audit');
  t.after(() => db.close());
  guild.roles = { cache: new Collection() };
  guild.channels = { cache: new Collection() };
  const { catalog, allowed } = require('../src/commands/help');
  const os = addMember('200000000000000010');
  const regular = addMember('200000000000000011');
  addMember(guild.ownerId);
  db.addOsUser(guild.id, os.id);
  const client = { guilds: { cache: new Collection([[guild.id, guild]]) } };
  const fill = (command) => command.split(/\s+/).map((token) => {
    if (token.startsWith('-')) return token;
    if (token === '@user') return '<@200000000000000099>';
    if (token.startsWith('@role')) return '<@&300000000000000099>';
    if (token === '#channel') return '<#400000000000000099>';
    if (/number/.test(token)) return '3';
    if (token === 'ROLE_ID') return '300000000000000099';
    return token.replace(/^\[|\]$/g, '').replace(/\|.*$/, '');
  }).join(' ');
  const denials = {
    owner: /Only the Guild Owner/,
    realowner: /Only the Guild Owner/,
    os: /Only (the Guild Owner(?:, Owner Allow users,)? or OS|OS or the Guild Owner)/,
    admin: /Only Vouch Admins, OS, or the Guild Owner/,
    force: /Only OS or the Guild Owner/
  };
  const actors = { owner: os, realowner: os, os: regular, admin: regular, force: regular };

  for (const entry of catalog.filter((item) => denials[item.permission])) {
    const actor = actors[entry.permission];
    const replies = [];
    await handleMessageCreate({
      guild, member: actor, author: actor.user, content: fill(entry.command), client,
      async reply(payload) { replies.push(payload); return payload; }
    }, client, db, '-');
    assert.equal(replies.length, 1, `${entry.command} replied once`);
    assert.match(replies[0].embeds[0].data.description, denials[entry.permission], `${entry.command} is really ${entry.permission}-restricted`);
    assert.equal(allowed(entry, actor, db), false, `${entry.command} is hidden from users the code rejects`);
    const shownTo = (viewer) => {
      const lines = [];
      const pages = Math.max(1, Math.ceil(dashboard.getEntries('all', viewer, db).length / dashboard.PAGE_SIZE));
      for (let page = 1; page <= pages; page += 1) {
        lines.push(...dashboard.renderPage({ category: 'all', page, history: [], id: 'audit' }, viewer, db).data.description.split('\n'));
      }
      return lines;
    };
    const ownerLines = shownTo(guild.members.cache.get(guild.ownerId));
    const target = entry.aliasOf || entry.command;
    assert.ok(ownerLines.some((line) => line.startsWith(`\`${target}\``)), `${entry.command} is shown to the Guild Owner`);
    assert.equal(shownTo(actor).some((line) => line.startsWith(`\`${target}\``)), false, `${entry.command} is not shown to a user the code rejects`);
  }
  assert.equal(db.getSettings(guild.id).vouch_role_id, null, 'denied commands changed no configuration');

  const giveReplies = [];
  await handleMessageCreate({
    guild, member: regular, author: regular.user, content: '-vouch give <@200000000000000010>', client,
    async reply(payload) { giveReplies.push(payload); return payload; }
  }, client, db, '-');
  assert.match(giveReplies[0].embeds[0].data.description, /not authorized to give vouches/);
  const give = catalog.find((entry) => entry.command.startsWith('-vouch give'));
  const take = catalog.find((entry) => entry.command.startsWith('-vouch take'));
  assert.equal(allowed(give, regular, db), false);
  assert.equal(allowed(give, os, db), true, 'OS can give vouches (default allowance 5)');
  assert.equal(allowed(take, regular, db), false);
  db.addVouch(guild.id, '200000000000000077', regular.id, 'former giver', new Date().toISOString());
  assert.equal(allowed(take, regular, db), true, 'a former giver with active vouches can still see take');
  assert.equal(allowed(give, regular, db), false);
});

test('Dashboard command and page counts match the commands actually shown for every audience', async (t) => {
  const { db, guild, addMember } = createFixture('count-audit');
  t.after(() => db.close());
  const owner = addMember(guild.ownerId);
  const os = addMember('count-os');
  const regular = addMember('count-regular');
  db.addOsUser(guild.id, os.id);
  for (const member of [owner, os, regular]) {
    let total = 0;
    for (const key of dashboard.categoriesFor(member, db).filter((category) => category !== 'permissions')) {
      const pageState = { id: 'count', category: key, page: 1, history: [] };
      const first = dashboard.renderPage(pageState, member, db).data;
      const [, pageCount, advertised] = first.footer.text.match(/^Page 1\/(\d+) \| (\d+) commands?/).map(Number);
      assert.equal(pageCount, Math.max(1, Math.ceil(advertised / dashboard.PAGE_SIZE)));
      let shown = [];
      for (let page = 1; page <= pageCount; page += 1) {
        pageState.page = page;
        const pageCommands = shownCommands(dashboard.renderPage(pageState, member, db).data);
        assert.ok(pageCommands.length <= dashboard.PAGE_SIZE, 'at most five commands per page');
        shown = shown.concat(pageCommands);
      }
      assert.equal(shown.length, advertised, `${key} count matches the commands shown`);
      assert.equal(new Set(shown).size, shown.length, `${key} shows no duplicates`);
      if (key !== 'all') total += shown.length;
      else assert.equal(shown.length, total, 'All Commands contains exactly every category command');
    }
  }
  const help = dashboard.dashboardPayload({ id: 'a', category: 'giving', page: 1, history: [] }, owner, db);
  assert.deepEqual(help.embeds[0].data.description, dashboard.renderPage({ id: 'b', category: 'giving', page: 1, history: [] }, owner, db).data.description,
    '-vouchhelp and -vouchcommands render from the same registry');
});
