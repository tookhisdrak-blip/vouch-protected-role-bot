const { randomUUID } = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder
} = require('discord.js');
const { COLORS, failure, argumentFailure } = require('../utils/embeds');
const {
  isGuildOwner, isOwnerAllowed, hasOwnerAccess, isOs, isVouchAdmin, isFounder, isForceManager
} = require('../services/permissions');
const { catalog, allowed } = require('./help');
const { hasFakePermission } = require('../services/fakePermissions');

const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
const PAGE_SIZE = 5;
const MAX_CATEGORY_BUTTONS = 15;
const panels = new Map();
const FORCE_CATEGORIES = new Set(['Management', 'Force Nicknames', 'Force Role Strips', 'Global Role Strips', 'Force Management']);

// Dashboard categories group the catalog's fine-grained categories into navigable sections.
const CATEGORIES = [
  { key: 'giving', label: 'Giving & Removing', title: 'Giving & Removing Vouches', description: 'Give an active vouch, or remove a vouch you are responsible for.', sources: ['Vouch', 'Take Vouch'] },
  { key: 'info', label: 'Vouch Information', title: 'Vouch Information', description: 'Check vouch status, browse active vouches, and open help.', sources: ['Vouch Information'] },
  { key: 'givers', label: 'Giver Management', title: 'Giver Management', description: 'Authorize givers and control how many people each giver can vouch for.', sources: ['Giver Management'] },
  { key: 'roles', label: 'Vouch & Reward Roles', title: 'Vouch & Reward Roles', description: 'Configure the protected vouch role and the automatic reward role.', sources: ['Vouch Roles', 'Reward Roles'] },
  { key: 'limited', label: 'Limited Roles', title: 'Limited Roles', description: 'Cap how many members can hold a role. Separate from vouch limits.', sources: ['Limited Roles'] },
  { key: 'locks', label: 'Role Locks', title: 'Role Locks', description: 'Control which roles may manually add or remove configured roles.', sources: ['Role Locks'] },
  { key: 'access', label: 'Access Levels', title: 'Access Levels', description: 'Grant or remove Vouch Admin, Owner Allow, and fake permissions.', sources: ['Access Levels', 'Fake Permissions'] },
  { key: 'blacklist', label: 'Blacklist', title: 'Vouch Blacklist', description: 'Block members from receiving vouches.', sources: ['Blacklist'] },
  { key: 'admin', label: 'Administration', title: 'Vouch Administration', description: 'STRIPSTAFF role, OS access, event logs, and full vouch resets.', sources: ['Vouch Administration'] },
  { key: 'force', label: 'Force Management', title: 'Force Management', description: 'Forced nicknames, member role strips, and global role strips.', sources: [...FORCE_CATEGORIES] },
  { key: 'forever', label: 'Forever Bans', title: 'Forever Bans', description: 'Permanent account-ID ban records. Needs fake ban_members; OS and Guild Owner have it.', sources: ['Forever Bans'] },
  { key: 'all', label: 'All Commands', title: 'All Commands', description: 'Every command you can use, in category order.' },
  { key: 'permissions', label: 'Your Permissions', title: 'Your Permissions', description: 'What your current access allows.' }
];
const CATEGORY_BY_KEY = new Map(CATEGORIES.map((category) => [category.key, category]));
const CATEGORY_INFO = Object.fromEntries(CATEGORIES.map((category) => [category.key, category]));
const SHORT_DESCRIPTIONS = {
  '-vouch give @user [reason]': 'Give a user a vouch',
  '-vouch take @user [reason]': 'Remove a vouch',
  '-vouch admin take @user [reason]': 'Remove any user\'s vouch',
  '-vouch admin allow @user': 'Make a user a Vouch Admin',
  '-vouch admin remove @user': 'Remove a Vouch Admin',
  '-vouch owner allow @user': 'Give a user full owner access',
  '-vouch owner remove @user': 'Remove a user\'s owner access',
  '-vouch check [@user]': 'View vouch and allowance info',
  '-vouch list [page]': 'Browse active vouches',
  '-vouchhelp [category|page]': 'Open this help dashboard',
  '-vouchcommands': 'Open this command dashboard',
  '-vouch addgiver @user': 'Authorize a vouch giver',
  '-vouch removegiver @user': 'Remove a vouch giver',
  '-vouch limit [number]': 'Set the default vouch limit',
  '-vouch limit @user [number]': 'Set a user\'s vouch limit',
  '-vouch limit remove @user': 'Reset a user\'s vouch limit',
  '-vouch setrole @role': 'Set the vouch-required role',
  '-vouch unsetrole': 'Unset the vouch role',
  '-vouch setreward @role': 'Set the vouch reward role',
  '-setlimit @role|ROLE_ID number': 'Set a role\'s max member count',
  '-limitedroles': 'Show limited roles and live counts',
  '-lockrole @role to @role, @role': 'Create or update a role lock',
  '-unlockrole @role': 'Remove a role lock',
  '-lockroles': 'Show configured role locks',
  '-vouchblacklist add @user': 'Block a user from receiving vouches',
  '-vouchblacklist remove @user': 'Unblock a user',
  '-vouchblacklist list [page]': 'View the blacklist',
  '-setrole stripstaff @role': 'Optional legacy STRIPSTAFF role',
  '-setrole os @role': 'Set the OS role',
  '-setrole os @user': 'Grant OS to a user',
  '-setrole os remove @user': 'Remove OS from a user',
  '-setrole os remove @role': 'Unset the OS role',
  '-setlog #channel': 'Set the log channel',
  '-vouchlogsetup': 'Create private bot log channels',
  '-vouch wipeall': 'Clear all active vouches',
  '-forcemanage': 'Open the Force Management panel',
  '-forcenickname @user [nickname]': 'Force a nickname on a user',
  '-unforcenickname @user': 'Remove a forced nickname',
  '-forcerolestrip @user @role': 'Block a user from a role',
  '-unforcerolestrip @user': 'Remove a user\'s role strips',
  '-rolestrip @role-name/id': 'Strip a role from everyone',
  '-foreverban @user [reason]': 'Forever-ban an account',
  '-unforeverban @user': 'Remove a forever-ban record',
  '-foreverbanlist [page]': 'View forever-ban records',
  '-fp add @user|@role ban_members': 'Grant a fake permission',
  '-fp remove @user|@role ban_members': 'Remove a fake permission',
  '-fp list': 'List fake permission holders',
  '-alias add shortcut original command': 'Create or update a command alias'
};

function rootCommand(entry) {
  return entry.command.slice(1).trim().split(/\s+/)[0]?.toLowerCase();
}

function registeredCatalog() {
  const { handlers } = require('../events/messageCreate');
  const registered = catalog.filter((entry) => handlers.has(rootCommand(entry)));
  const knownRoots = new Set(catalog.map(rootCommand));
  const discovered = [...handlers.keys()].filter((root) => root !== 'vouchcommands' && !knownRoots.has(root));
  const fallbackEntries = discovered.map((root) => {
    if (/^(foreverban|unforeverban)/.test(root)) {
      return { command: `-${root}`, summary: 'Registered command; detailed metadata is not yet configured.', category: 'Forever Bans', permission: 'fakeban' };
    }
    if (/^(force|unforce|rolestrip|forcemanage)/.test(root)) {
      return { command: `-${root}`, summary: 'Registered command; detailed metadata is not yet configured.', category: 'Force Management', permission: 'force' };
    }
    return { command: `-${root}`, summary: 'Registered command; detailed metadata is not yet configured.', category: 'Vouch Information', permission: 'owner' };
  });
  return [...registered, ...fallbackEntries];
}

function primaryCommands(entries = registeredCatalog()) {
  return entries.filter((entry) => !entry.aliasOf);
}

function aliasesFor(entry, entries = registeredCatalog()) {
  return entries.filter((candidate) => candidate.aliasOf === entry.command).map((candidate) => candidate.command);
}

function sectionEntries(section, member, db, entries = primaryCommands()) {
  if (section.ownerOnly && !hasOwnerAccess(member, db)) return [];
  const sources = new Set(section.sources);
  return entries.filter((entry) => sources.has(entry.category) && allowed(entry, member, db));
}

function allCommandsFor(member, db) {
  const entries = primaryCommands();
  return CATEGORIES.filter((section) => section.sources)
    .flatMap((section) => sectionEntries(section, member, db, entries));
}

function categoriesFor(member, db) {
  const entries = primaryCommands();
  const visible = CATEGORIES.filter((section) => section.sources && sectionEntries(section, member, db, entries).length)
    .map((section) => section.key);
  if (visible.length) visible.push('all');
  visible.push('permissions');
  return visible;
}

function canViewCategory(category, member, db) {
  if (!CATEGORY_BY_KEY.has(category)) return false;
  return categoriesFor(member, db).includes(category);
}

function getEntries(category, member, db) {
  if (category === 'all') return allCommandsFor(member, db);
  const section = CATEGORY_BY_KEY.get(category);
  if (!section?.sources) return [];
  return sectionEntries(section, member, db);
}

function shortDescription(entry) {
  if (SHORT_DESCRIPTIONS[entry.command]) return SHORT_DESCRIPTIONS[entry.command];
  const firstSentence = entry.summary.split(/(?<=\.)\s/)[0].replace(/\.$/, '');
  return firstSentence.length > 60 ? `${firstSentence.slice(0, 57)}...` : firstSentence;
}

// Command words before the first argument placeholder, e.g. `-vouch role add @role` -> `-vouch role add`.
function aliasName(alias) {
  const words = alias.split(/\s+/);
  const argumentIndex = words.findIndex((word, index) => index > 0 && /^[@\[#<]|\|/.test(word));
  return (argumentIndex === -1 ? words : words.slice(0, argumentIndex)).join(' ');
}

function commandLine(entry) {
  const aliases = aliasesFor(entry).map((alias) => `\`${aliasName(alias)}\``);
  const aliasText = aliases.length ? ` (alias ${[...new Set(aliases)].join(', ')})` : '';
  return `\`${entry.command}\` — ${shortDescription(entry)}${aliasText}`;
}

function permissionDescription(member, db) {
  const access = [];
  if (isGuildOwner(member)) access.push('Guild Owner: all commands, including Forever Bans and Owner Allow.');
  else if (isOwnerAllowed(member, db)) access.push('Owner Allow: full Guild Owner access, except granting Owner Allow.');
  if (isOs(member, db)) access.push('OS: Vouch Admin powers, vouch role, Vouch Admins, and blacklist. 5 default vouches.');
  if (isVouchAdmin(member, db)) access.push('Vouch Admin: give vouches (5 default), manage givers, remove any vouch.');
  if (isFounder(member)) access.push('Founder: Force Management commands only.');
  if (db.getGiver(member.guild.id, member.id)) access.push('Vouch Giver: give vouches within your allowance; remove your own vouches.');
  if (isForceManager(member, db)) access.push('Force Management: forced nicknames and role-strip commands.');
  if (!access.length) access.push('Regular member: public vouch information and limited-role views.');
  if (hasFakePermission(member, db, 'ban_members')) access.push('Fake ban_members: Forever Ban and Forever Unban.');
  else access.push('Forever Ban commands need the fake ban_members permission.');
  return access.join('\n');
}

function pageCountFor(state, member, db) {
  if (state.category === 'home' || state.category === 'permissions') return 1;
  return Math.max(1, Math.ceil(getEntries(state.category, member, db).length / PAGE_SIZE));
}

function renderPage(state, member, db) {
  const embed = new EmbedBuilder().setColor(COLORS.info);
  const timeoutNote = 'Closes after 5 minutes of inactivity';

  if (state.category === 'home') {
    return embed
      .setTitle('Vouch Management')
      .setDescription('Click a category below to view its commands.')
      .setFooter({ text: timeoutNote });
  }

  const section = CATEGORY_BY_KEY.get(state.category);
  if (state.category === 'permissions') {
    return embed
      .setTitle(section.label)
      .setDescription(permissionDescription(member, db))
      .setFooter({ text: timeoutNote });
  }

  const entries = getEntries(state.category, member, db);
  const pageCount = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  state.page = Math.min(Math.max(1, state.page), pageCount);
  const pageEntries = entries.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
  return embed
    .setTitle(section.label)
    .setDescription(pageEntries.length
      ? pageEntries.map(commandLine).join('\n')
      : 'No commands are available in this category.')
    .setFooter({ text: `Page ${state.page}/${pageCount} | ${entries.length} command${entries.length === 1 ? '' : 's'} | ${timeoutNote}` });
}

function dashboardPayload(state, member, db) {
  const categories = categoriesFor(member, db);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`vouchcommands:${state.id}:category`)
    .setPlaceholder('Select a category')
    .addOptions(categories.map((key) => ({
      label: CATEGORY_BY_KEY.get(key).label,
      value: key,
      default: key === state.category
    })));
  const rows = [new ActionRowBuilder().addComponents(menu)];

  if (state.category === 'home') {
    const buttonCategories = categories.slice(0, MAX_CATEGORY_BUTTONS);
    for (let index = 0; index < buttonCategories.length; index += 5) {
      rows.push(new ActionRowBuilder().addComponents(buttonCategories.slice(index, index + 5).map((key) =>
        new ButtonBuilder()
          .setCustomId(`vouchcommands:${state.id}:category:${key}`)
          .setLabel(CATEGORY_BY_KEY.get(key).label)
          .setStyle(ButtonStyle.Secondary)
      )));
    }
  } else {
    const pageCount = pageCountFor(state, member, db);
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`vouchcommands:${state.id}:home`).setLabel('Home').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`vouchcommands:${state.id}:back`).setLabel('Back').setStyle(ButtonStyle.Secondary).setDisabled(state.history.length === 0),
      new ButtonBuilder().setCustomId(`vouchcommands:${state.id}:previous`).setLabel('Previous').setStyle(ButtonStyle.Primary).setDisabled(state.page <= 1),
      new ButtonBuilder().setCustomId(`vouchcommands:${state.id}:next`).setLabel('Next').setStyle(ButtonStyle.Primary).setDisabled(state.page >= pageCount)
    ));
  }
  return { embeds: [renderPage(state, member, db)], components: rows, allowedMentions: { parse: [] } };
}

function clearPanelTimer(state) {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
}

function resetPanelTimer(state) {
  clearPanelTimer(state);
  state.lastInteractionAt = Date.now();
  state.expiresAt = state.lastInteractionAt + INACTIVITY_TIMEOUT_MS;
  state.timer = setTimeout(() => { void expirePanel(state.id); }, INACTIVITY_TIMEOUT_MS);
  state.timer.unref?.();
}

async function expirePanel(panelId) {
  const state = panels.get(panelId);
  if (!state) return false;
  const remaining = state.expiresAt - Date.now();
  if (remaining > 0) {
    clearPanelTimer(state);
    state.timer = setTimeout(() => { void expirePanel(panelId); }, remaining);
    state.timer.unref?.();
    return false;
  }
  clearPanelTimer(state);
  panels.delete(panelId);
  try {
    await state.message.delete();
  } catch {
    await state.message?.edit?.({ components: [], allowedMentions: { parse: [] } }).catch(() => null);
  }
  return true;
}

function clearAllPanels() {
  for (const state of panels.values()) clearPanelTimer(state);
  panels.clear();
}

function prunePanels() {
  const now = Date.now();
  for (const [panelId, panel] of panels) {
    if (panel.expiresAt <= now) void expirePanel(panelId);
  }
}

function resolveCategoryArgument(value) {
  const normalized = value.toLowerCase().replace(/[^a-z]/g, '');
  return CATEGORIES.find((section) => section.key === normalized
    || section.label.toLowerCase().replace(/[^a-z]/g, '') === normalized
    || section.title.toLowerCase().replace(/[^a-z]/g, '') === normalized)?.key || null;
}

async function openDashboard(message, db, options = {}) {
  const commandName = options.commandName || 'vouchcommands';
  if (!message.guild || !message.member) {
    return message.reply({ embeds: [failure('Use this command in a server.')], allowedMentions: { parse: [] } });
  }
  db.ensureGuild(message.guild.id);
  prunePanels();
  const state = {
    id: randomUUID(),
    guildId: message.guild.id,
    channelId: message.channel?.id || message.channelId || null,
    commandName,
    messageId: null,
    message: null,
    timer: null,
    expiresAt: 0,
    category: options.category || 'home',
    page: options.page || 1,
    history: []
  };
  try {
    const payload = dashboardPayload(state, message.member, db);
    const dashboardMessage = message.channel?.send
      ? await message.channel.send(payload)
      : await message.reply(payload);
    state.messageId = dashboardMessage?.id || null;
    state.message = dashboardMessage;
    panels.set(state.id, state);
    resetPanelTimer(state);
    return dashboardMessage;
  } catch (error) {
    console.warn(`Could not send vouch command dashboard in ${message.guild.id}:`, error.message);
    return message.reply({ embeds: [failure('I could not send the dashboard in this channel. Check Send Messages, Embed Links, and Use Application Commands permissions.')], allowedMentions: { parse: [] } });
  }
}

async function execute(message, _args, db) {
  return openDashboard(message, db, { commandName: 'vouchcommands' });
}

async function executeHelp(message, args, db) {
  const argument = args.join(' ').trim();
  if (!argument) return openDashboard(message, db, { commandName: 'vouchhelp' });
  if (/^-?\d+$/.test(argument)) {
    const page = Number(argument);
    if (!Number.isSafeInteger(page) || page < 1) {
      return message.reply({ embeds: [argumentFailure('Use a positive page number bro.')], allowedMentions: { parse: [] } });
    }
    return openDashboard(message, db, { commandName: 'vouchhelp', category: 'all', page });
  }
  const category = resolveCategoryArgument(argument);
  if (!category || !canViewCategory(category, message.member, db)) {
    const available = categoriesFor(message.member, db).map((key) => `\`${key}\``).join(', ');
    return message.reply({ embeds: [argumentFailure(`Use a valid category bro: ${available}.`)], allowedMentions: { parse: [] } });
  }
  return openDashboard(message, db, { commandName: 'vouchhelp', category });
}

async function interactionError(interaction, text) {
  const payload = { embeds: [failure(text)], ephemeral: true, allowedMentions: { parse: [] } };
  if (interaction.deferred || interaction.replied) return interaction.followUp(payload).catch(() => null);
  return interaction.reply(payload).catch(() => null);
}

async function handleInteraction(interaction, db) {
  if (!interaction.customId?.startsWith('vouchcommands:')) return false;
  const [, panelId, action, actionCategory] = interaction.customId.split(':');
  const state = panels.get(panelId);
  if (!state) {
    await interactionError(interaction, 'This command dashboard has expired. Run `-vouchhelp` or `-vouchcommands` to open a new one.');
    return true;
  }
  if ((interaction.message?.id && state.messageId && interaction.message.id !== state.messageId)
    || (interaction.channelId && state.channelId && interaction.channelId !== state.channelId)) {
    await interactionError(interaction, 'This control does not belong to this command dashboard.');
    return true;
  }
  const validActions = new Set(['category', 'home', 'back', 'previous', 'next']);
  if (!validActions.has(action)) {
    await interactionError(interaction, 'That dashboard control is invalid.');
    return true;
  }
  if (state.expiresAt <= Date.now()) {
    await expirePanel(panelId);
    await interactionError(interaction, `This command dashboard has expired. Run \`-${state.commandName}\` to open a new one.`);
    return true;
  }
  resetPanelTimer(state);

  const guild = interaction.client.guilds.cache.get(state.guildId);
  const member = await guild?.members.fetch(interaction.user.id).catch(() => null);
  if (!guild || !member) {
    await interactionError(interaction, 'You must be a current server member to use this dashboard.');
    return true;
  }
  db.ensureGuild(guild.id);

  if (action === 'category') {
    const category = interaction.values?.[0] || actionCategory;
    if (!canViewCategory(category, member, db)) {
      await interactionError(interaction, 'You are not authorized to view that command category.');
      return true;
    }
    state.history.push({ category: state.category, page: state.page });
    state.category = category;
    state.page = 1;
  } else if (action === 'home') {
    state.history = [];
    state.category = 'home';
    state.page = 1;
  } else if (action === 'back') {
    const previous = state.history.pop();
    if (!previous || (previous.category !== 'home' && !canViewCategory(previous.category, member, db))) {
      await interactionError(interaction, 'There is no available previous dashboard page.');
      return true;
    }
    state.category = previous.category;
    state.page = previous.page;
  } else if (action === 'previous' || action === 'next') {
    if (state.category !== 'home' && !canViewCategory(state.category, member, db)) {
      await interactionError(interaction, 'You are not authorized to view this command category.');
      return true;
    }
    const pageCount = pageCountFor(state, member, db);
    if (pageCount < 2) {
      await interactionError(interaction, 'This category has no additional pages.');
      return true;
    }
    state.page = action === 'next' ? Math.min(pageCount, state.page + 1) : Math.max(1, state.page - 1);
  }

  await interaction.update(dashboardPayload(state, member, db));
  return true;
}

module.exports = {
  execute,
  executeHelp,
  openDashboard,
  handleInteraction,
  registeredCatalog,
  primaryCommands,
  categoriesFor,
  canViewCategory,
  getEntries,
  shortDescription,
  renderPage,
  dashboardPayload,
  prunePanels,
  resetPanelTimer,
  expirePanel,
  clearAllPanels,
  panels,
  CATEGORIES,
  CATEGORY_INFO,
  PAGE_SIZE,
  INACTIVITY_TIMEOUT_MS
};
