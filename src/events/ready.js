const { reconcileGuild } = require('../services/roleProtection');
const { reconcileForceGuild } = require('../services/forceRules');
const { reconcileForeverBans } = require('../services/foreverBans');

async function handleReady(client, db) {
  console.log(`Connected as ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) {
    db.ensureGuild(guild.id);
    try {
      await guild.roles.fetch();
    } catch (error) {
      console.error(`Could not refresh roles in ${guild.id}:`, error);
    }
    for (const [name, reconcile] of [
      ['vouch/protected roles', () => reconcileGuild(guild, db)],
      ['force rules', () => reconcileForceGuild(guild, db)],
      ['forever bans', () => reconcileForeverBans(guild, db)]
    ]) {
      try {
        await reconcile();
      } catch (error) {
        console.error(`Startup ${name} reconciliation failed in ${guild.id}:`, error);
      }
    }
  }
}

module.exports = { handleReady };