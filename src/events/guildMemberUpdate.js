const { handleGuildMemberUpdate } = require('../services/roleProtection');
const { handleForceMemberUpdate } = require('../services/forceRules');

async function handleMemberUpdate(oldMember, newMember, db) {
  if (!oldMember.guild) return;
  db.ensureGuild(newMember.guild.id);
  try {
    const handledRoleIds = await handleGuildMemberUpdate(oldMember, newMember, db);
    await handleForceMemberUpdate(oldMember, newMember, db, handledRoleIds);
  } catch (error) {
    console.error(`Role protection failed in ${newMember.guild.id}:`, error);
  }
}

module.exports = { handleMemberUpdate };