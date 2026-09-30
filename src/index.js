const { Client, GatewayIntentBits, Events } = require('discord.js');
const config = require('./config');
const { createDatabase } = require('./database');
const { handleMessageCreate, handleMessageUpdate } = require('./events/messageCreate');
const { handleMemberUpdate } = require('./events/guildMemberUpdate');
const { handleReady } = require('./events/ready');
const { handleMemberAdd } = require('./events/guildMemberAdd');
const { handleInteraction } = require('./events/interactionCreate');

if (!config.token) {
  console.error('DISCORD_TOKEN is required. Copy .env.example to .env and set the bot token.');
  process.exit(1);
}

if (config.databasePathError) {
  console.error(config.databasePathError);
  process.exit(1);
}

const db = createDatabase(config.databasePath);
console.log(`Using SQLite database at ${require('node:path').resolve(config.databasePath)}`);
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once(Events.ClientReady, () => handleReady(client, db));
client.on(Events.MessageCreate, (message) => handleMessageCreate(message, client, db, config.prefix));
client.on(Events.MessageUpdate, (oldMessage, newMessage) => handleMessageUpdate(oldMessage, newMessage, client, db, config.prefix));
client.on(Events.GuildMemberUpdate, (oldMember, newMember) => handleMemberUpdate(oldMember, newMember, db));
client.on(Events.GuildMemberAdd, (member) => handleMemberAdd(member, db));
client.on(Events.InteractionCreate, (interaction) => handleInteraction(interaction, db));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    db.close();
    client.destroy();
    process.exit(0);
  });
}

client.login(config.token).catch((error) => {
  console.error('Discord login failed:', error.message);
  db.close();
  process.exit(1);
});