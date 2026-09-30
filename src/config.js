require('dotenv').config();
const { resolveDatabasePath } = require('./databasePath');

const database = resolveDatabasePath(process.env);

module.exports = {
  token: process.env.DISCORD_TOKEN,
  prefix: '-',
  databasePath: database.path,
  databasePathError: database.error
};