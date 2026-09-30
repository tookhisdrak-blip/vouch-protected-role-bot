const { handleGuildMemberUpdate } = require('../services/roleProtection');
const { handleForceMemberUpdate } = require('../services/forceRules');
const { handleRoleLockUpdate } = require('../services/roleLocks');
const { handlePaidRoleUpdate } = require('../services/paidRoles');

async function handleMemberUpdate(oldMember, newMember, db) {
  if (!oldMember.guild) return;
  db.ensureGuild(newMember.guild.id);
  try {
    const lockHandledRoleIds = await handleRoleLockUpdate(oldMember, newMember, db);
    const paidHandledRoleIds = await handlePaidRoleUpdate(oldMember, newMember, db, lockHandledRoleIds);
    const protectedRoleIds = new Set([...lockHandledRoleIds, ...paidHandledRoleIds]);
    const handledRoleIds = await handleGuildMemberUpdate(oldMember, newMember, db, protectedRoleIds);
    await handleForceMemberUpdate(oldMember, newMember, db, new Set([...protectedRoleIds, ...handledRoleIds]));
  } catch (error) {
    console.error(`Role protection failed in ${newMember.guild.id}:`, error);
  }
}

module.exports = { handleMemberUpdate };