# Vouch and Protected Role Bot

A CommonJS Discord moderation bot for persistent vouches and protected-role limits. Commands use the `-` prefix; all Discord replies and event logs are compact embeds without emoji or icons.

## Setup

1. Install Node.js 22 (LTS). Other recent versions generally work locally, but Railway builds with 22.x.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and set `DISCORD_TOKEN`.
4. Enable the **Server Members Intent** and **Message Content Intent** in the Discord Developer Portal.
5. Invite the bot with View Audit Log, Manage Roles, View Channels, Send Messages, Embed Links, and Read Message History permissions. Place its role above every role it must assign or remove.
6. Run `npm start`.

SQLite is stored at `./data/moderation.sqlite` by default for local development. Set `DATABASE_PATH` to use another location. Configuration, vouches, limited roles, force rules, bans, and logs all live in this one file and survive restarts as long as the file is retained.

## Deploying on Railway

1. Push this repository to GitHub. `.env` (and any `.env.*` except `.env.example`), the `data/` folder, and all SQLite files (`*.sqlite`, `*.db`, `-wal`, `-shm`, `-journal`) are git-ignored, so the bot token and databases are never committed. Never put a real token in `.env.example`.
2. In Railway, create a service from the GitHub repository. Railway builds with Node 22 (`engines.node`) and starts the bot with `npm start` (`node src/index.js`). No build command, port, or healthcheck is needed.
3. Attach a **Volume** to the service with mount path **`/app/data`**.
4. Set the service variable `DISCORD_TOKEN` (and `FORCE_FOUNDER_IDS` if used). `DATABASE_PATH` is optional: when unset, the bot stores the database at `$RAILWAY_VOLUME_MOUNT_PATH/moderation.sqlite`, which is `/app/data/moderation.sqlite`. If you set it, use `/app/data/moderation.sqlite`.
5. Deploy. The log shows `Using SQLite database at /app/data/moderation.sqlite`.

On Railway the bot refuses to start if no Volume is attached or if `DATABASE_PATH` points outside the Volume, so it can never silently use ephemeral container storage that is wiped on redeploy. Keep a single replica: Railway volumes do not support replicas. The Volume is the only production data store. Startup only creates missing tables (`CREATE TABLE IF NOT EXISTS`) and never resets existing data, so redeploys keep all vouches, limited roles, logs and settings. Do not delete or recreate the Volume.

To move an existing local database to Railway, stop the local bot first so the `-wal` file is merged into `data/moderation.sqlite`. Then upload it to the Volume with `railway volume files upload ./data/moderation.sqlite /moderation.sqlite`. Volume paths in that command are relative to the Volume root, so `/moderation.sqlite` becomes `/app/data/moderation.sqlite`. If the bot already ran on Railway and created an empty database, stop the service, run the upload with `--overwrite`, delete any leftover `/moderation.sqlite-wal` and `/moderation.sqlite-shm` files on the Volume, and then redeploy.

## First Configuration

- `-setrole os @role` or `-setrole os @user`
- `-setlimit @role|ROLE_ID 10`
- `-vouch setrole @role`
- `-vouch setreward @role`
- `-setlog #channel`
- `-vouch addgiver @user`

Use `-vouchhelp` or `-vouchcommands` to open the interactive, permission-filtered command dashboard. The Home page is a small panel with a category dropdown and one button per category (Giving & Removing, Vouch Information, Giver Management, Vouch & Reward Roles, Limited Roles, Blacklist, Administration, Force Management, Forever Bans, All Commands, Your Permissions). A category page lists only that category's commands, one compact line each (command and short description), up to five per page, with the category dropdown and Home/Back/Previous/Next buttons. `-vouchhelp limited` opens a category directly, and `-vouchhelp 2` opens page 2 of All Commands. The dashboard closes after 5 minutes of inactivity. Only commands you are allowed to use are listed; Owners see the complete command set.

## Commands

- `-vouch give @user [reason]`
- `-vouch take @user [reason]`
- `-vouch check [@user]`
- `-vouch list [page]`
- `-vouch setrole @role` and `-vouch unsetrole`
- `-vouch setreward @role`
- `-vouch addgiver @user` and `-vouch removegiver @user`
- `-vouch limit [number]`, `-vouch limit @user [number]`, `-vouch limit remove @user`
- `-vouch wipeall`
- `-vouchblacklist add @user`, `-vouchblacklist remove @user`, `-vouchblacklist list [page]`
- `-setrole os @role`, `-setrole os @user`, and `-setrole os remove @user|@role`
- `-setrole stripstaff @role` (optional legacy setting; STRIPSTAFF runs automatically without it)
- `-setlimit @role|ROLE_ID number` (Guild Owner; sets an independent maximum member count)
- `-setrole @role limit number` (legacy alias for `-setlimit`)
- `-limitedroles`
- `-setlog #channel`
- `-vouchhelp [category|page]` (interactive category dashboard with navigation buttons)
- `-vouchcommands` (same interactive category dashboard, posted in the channel)
- `-forcemanage` (OS and Guild Owner; private DM panel)
- `-forcenickname @user [nickname]` and `-unforcenickname @user` (OS and Guild Owner)
- `-forcerolestrip @user @role` and `-unforcerolestrip @user` (OS and Guild Owner)
- `-rolestrip @role-name/id` (OS and Guild Owner; requires button confirmation)
- `-forcestrip @user @role`, `-forcestrip @role-name/id`, and `-unforcestrip @user` (aliases)
- `-foreverban @user [reason]`, `-unforeverban @user`, and `-foreverbanlist [page]` (Guild Owner only)

The Guild Owner controls configuration and is always exempt from STRIPSTAFF. OS users and the configured OS role can administer vouches and the blacklist, but cannot change owner-controlled configuration. Only the original giver, OS, or Guild Owner can remove an active vouch.

Force Management is available to existing OS users/roles, the Guild Owner, and explicitly configured Founder account IDs in `FORCE_FOUNDER_IDS` (comma, space, or semicolon separated). Founder IDs do not grant forever-ban access; those commands always check the actual Guild Owner. Forever-ban records match exact Discord account IDs only. They do not identify alternate accounts belonging to the same person; future explicit account associations or verification signals would require separate owner-configured rules.

## Role Monitoring

`guildMemberUpdate` monitors role additions from this bot, the Discord role UI, and other bots. Executor attribution and STRIPSTAFF enforcement require the View Audit Log permission and a fresh matching role-add audit entry. Missing or stale audit entries are logged without punishment. Startup reconciliation removes invalid vouch roles. Limited-role reconciliation removes only excess members with a verifiable, most-recent role-add audit entry; if the executor/member cannot be safely identified, it leaves the excess assignment in place and reports it rather than removing an arbitrary existing member. STRIPSTAFF is an automatic punishment (no configured role required) that removes only roles whose Discord permissions include staff/moderation permissions; cosmetic, booster, reward, vouch, and ordinary roles are retained. Only the Guild Owner and OS are exempt from STRIPSTAFF (bots are also not punished); their invalid role assignments are still reversed. If a member with an active vouch has the vouch role manually removed, the bot restores it; only `-vouch take` (original giver, OS, or Guild Owner) or `-vouch wipeall` ends a vouch and removes the role.

Vouch-role requirements and limited-role member counts are independent settings. The same Discord role may have both configurations; either rule can independently reverse an invalid assignment.

The Server Members and Message Content privileged intents must be enabled for member monitoring and prefix commands. Prefix commands are also processed when a message is edited into a command. The bot's role must be higher than any protected or STRIPSTAFF role. Role limits are checked against the member cache maintained by the Server Members intent. The configured vouch role is reconciled at startup, when configured, when a member joins, and whenever a member role update is observed; members without an active vouch lose that role.

New manual vouch givers use the current default allowance (2 by default). OS users receive five available vouches by default; the Guild Owner can set or remove a user-specific OS allowance with `-vouch limit @user number` and `-vouch limit remove @user`. A giver's custom limit overrides their default and is enforced against active vouches. Role-member limits remain an independent configuration and never change vouch allowances. An exhausted giver's attempt is rejected with the configured limit response; STRIPSTAFF punishment applies only to non-Owner/non-OS members.

## Tests

Run `npm test` to exercise allowance restoration, vouch role assignment/removal, SQLite persistence, live role-limit enforcement, unauthorized vouch-role reversal, and owner/OS/bot punishment exemptions.