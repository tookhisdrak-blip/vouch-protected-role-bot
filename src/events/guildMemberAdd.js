const { enforceForeverBanOnJoin } = require('../services/foreverBans');
const { handleForceMemberAdd } = require('../services/forceRules');
const { handleGuildMemberAdd } = require('../services/roleProtection');

async function handleMemberAdd(member, db) {
  db.ensureGuild(member.guild.id);
  try {
    const banResult = await enforceForeverBanOnJoin(member, db);
    if (banResult) return;
    await handleGuildMemberAdd(member, db);
    await handleForceMemberAdd(member, db);
  } catch (error) {
    console.error(`Join handling failed in ${member.guild.id}:`, error);
  }
}

module.exports = { handleMemberAdd };