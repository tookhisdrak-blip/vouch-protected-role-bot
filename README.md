# Vouch and Protected Role Bot

A CommonJS Discord moderation bot for persistent vouches and protected-role limits. Commands use the `-` prefix; all Discord replies and event logs are compact embeds without emoji or icons.

## Setup

1. Install Node.js 22 (LTS). Other recent versions generally work locally, but Railway builds with 22.x.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and set `DISCORD_TOKEN`.
4. Enable the **Server Members Intent** and **Message Content Intent** in the Discord Developer Portal.
5. Invite the bot with View Audit Log, Manage Roles, View Channels, Send Messages, Embed Links, and Read Message History permissions. Place its role above every role it must assign or remove.
6. Run `npm start`.

SQLite is stored at `./data/moderation.sqlite` by default for local development. Set `DATABASE_PATH` to use another location. Configuration, vouches, limited roles, force rules, bans, log-channel IDs, and logs all live in this one file and survive restarts as long as the file is retained. The Guild Owner can run `-vouchlogsetup` once to create private Vouch, Ban, Main, and Admin log channels; the bot needs Manage Channels permission. Re-running setup reuses the configured channels.

Every user argument accepts a user mention or user ID, and every role argument accepts a role mention or role ID. Mixed user/role commands verify raw IDs against Discord so they are not treated as the wrong target type. Custom aliases are also stored in SQLite and survive restarts.

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
- `-vouchlogsetup` (Guild Owner; creates private Vouch, Ban, Main, and Admin log channels)
- `-vouch addgiver @user`

Use `-vouchhelp` or `-vouchcommands` to open the interactive, permission-filtered command dashboard. The Home page is a small panel with a category dropdown and one button per category (Giving & Removing, Vouch Information, Giver Management, Vouch & Reward Roles, Limited Roles, Blacklist, Administration, Force Management, Forever Bans, All Commands, Your Permissions). A category page lists only that category's commands, one compact line each (command and short description), up to five per page, with the category dropdown and Home/Back/Previous/Next buttons. `-vouchhelp limited` opens a category directly, and `-vouchhelp 2` opens page 2 of All Commands. The dashboard closes after 5 minutes of inactivity. Only commands you are allowed to use are listed; Owners see the complete command set.

## Commands

- `-vouch give @user [reason]`
- `-vouch take @user [reason]` (original giver, Vouch Admin, OS, or Guild Owner)
- `-vouch admin take @user [reason]` (Vouch Admin, OS, or Guild Owner; removes any vouch)
- `-vouch check [@user]`
- `-vouch list [page]`
- `-vouch setrole @role` and `-vouch unsetrole` (aliases `-vouch role add @role` and `-vouch role remove`; OS or Guild Owner)
- `-vouch setreward @role`
- `-vouch addgiver @user` and `-vouch removegiver @user` (Vouch Admin, OS, or Guild Owner)
- `-vouch admin allow @user` and `-vouch admin remove @user` (OS or Guild Owner)
- `-vouch owner allow @user` and `-vouch owner remove @user` (actual Guild Owner only)
- `-vouch limit [number]`, `-vouch limit @user [number]`, `-vouch limit remove @user`
- `-vouch wipeall` (alias `-vouch reset`; Guild Owner)
- `-vouchblacklist add @user`, `-vouchblacklist remove @user`, `-vouchblacklist list [page]`
- `-setrole os @role`, `-setrole os @user`, and `-setrole os remove @user|@role`
- `-setrole stripstaff @role` (optional legacy setting; STRIPSTAFF runs automatically without it)
- `-setlimit @role|ROLE_ID number` (Guild Owner; sets an independent maximum member count)
- `-setrole @role limit number` (legacy alias for `-setlimit`)
- `-limitedroles`
- `-setlog #channel`
- `-vouchlogsetup` (Guild Owner; creates private persistent channels for vouch, ban, main, and admin events)
- `-vouchhelp [category|page]` (interactive category dashboard with navigation buttons)
- `-vouchcommands` (same interactive category dashboard, posted in the channel)
- `-forcemanage` (OS and Guild Owner; private DM panel)
- `-forcenickname @user [nickname]` and `-unforcenickname @user` (OS and Guild Owner)
- `-forcerolestrip @user @role` and `-unforcerolestrip @user` (OS and Guild Owner)
- `-rolestrip @role-name/id` (OS and Guild Owner; requires button confirmation)
- `-forcestrip @user @role`, `-forcestrip @role-name/id`, and `-unforcestrip @user` (aliases)
- `-foreverban @user [reason]`, `-unforeverban @user`, and `-foreverbanlist [page]` (fake `ban_members` permission; OS and Guild Owner have it automatically)
- `-fp add @user/id or @role/id <permission>`, `-fp remove @user/id or @role/id <permission>`, and `-fp list` (OS and Guild Owner)
- `-vg @user|USER_ID [reason]` (alias for `-vouch give`)
- `-vag @user|USER_ID` (alias for `-vouch addgiver`)
- `-alias add shortcut original command`, `-alias remove shortcut`, and `-alias list` (OS and Guild Owner; persistent)

### Fake permissions

Fake permissions are internal bot permissions. They never change real Discord permissions. Grant one directly to a user, or to a role so every member holding that role receives it. OS, the Guild Owner and Owner Allow users automatically have every fake permission. Everyone else needs the permission, either directly or through a role. Real Discord permissions such as Ban Members or Administrator do not grant it, and neither does other bot access (Vouch Admin, Founder, and so on).

| Fake permission | Allows |
| --- | --- |
| `ban_members` | `-foreverban`, `-unforeverban`, `-foreverbanlist` |

To add more fake permissions, extend `FAKE_PERMISSIONS` in `src/services/fakePermissions.js` and gate commands with `hasFakePermission(member, db, '<name>')`.

Permission levels are separate:

- Vouch Giver: 2 vouches by default; can give vouches and take back only the vouches they gave.
- Vouch Admin: 5 vouches by default; can give vouches, add/remove Vouch Givers, and remove any vouch. Not exempt from STRIPSTAFF.
- OS: Vouch Admin powers (5 vouches by default), plus the vouch role, Vouch Admins, and the blacklist. Exempt from STRIPSTAFF. Cannot grant Owner Allow or change owner-controlled configuration.
- Guild Owner: full control; uncapped vouches unless a custom limit is set; exempt from STRIPSTAFF.
- Owner Allow: treated exactly like the Guild Owner for this bot (including Forever Bans), except that only the actual Discord Guild Owner can grant or remove Owner Allow.

The Guild Owner can change any giver, Vouch Admin, or OS allowance with `-vouch limit @user [number]`; `-vouch limit remove @user` restores that level's default. Vouch permissions never affect the limited-role system.

Force Management is available to existing OS users/roles, the Guild Owner, and explicitly configured Founder account IDs in `FORCE_FOUNDER_IDS` (comma, space, or semicolon separated). Founder IDs do not grant forever-ban access; those commands require the fake `ban_members` permission (automatic for OS, the Guild Owner and Owner Allow users). Forever-ban records match exact Discord account IDs only. They do not identify alternate accounts belonging to the same person; future explicit account associations or verification signals would require separate owner-configured rules.

## Role Monitoring

`guildMemberUpdate` monitors role additions from this bot, the Discord role UI, and other bots. Executor attribution and STRIPSTAFF enforcement require the View Audit Log permission and a fresh matching role-add audit entry. Missing or stale audit entries are logged without punishment. Startup reconciliation removes invalid vouch roles. Limited-role reconciliation removes only excess members with a verifiable, most-recent role-add audit entry; if the executor/member cannot be safely identified, it leaves the excess assignment in place and reports it rather than removing an arbitrary existing member. STRIPSTAFF is an automatic punishment (no configured role required) that removes only roles whose Discord permissions include staff/moderation permissions; cosmetic, booster, reward, vouch, and ordinary roles are retained. Only the Guild Owner, Owner Allow users, and OS are exempt from STRIPSTAFF (bots are also not punished); their invalid role assignments are still reversed. If a member with an active vouch has the vouch role manually removed, the bot restores it; only `-vouch take` (original giver, Vouch Admin, OS, or Guild Owner), `-vouch admin take`, or `-vouch wipeall`/`-vouch reset` ends a vouch and removes the role.

Vouch-role requirements and limited-role member counts are independent settings. The same Discord role may have both configurations; either rule can independently reverse an invalid assignment.

The Server Members and Message Content privileged intents must be enabled for member monitoring and prefix commands. Prefix commands are also processed when a message is edited into a command. The bot's role must be higher than any protected or STRIPSTAFF role. Role limits are checked against the member cache maintained by the Server Members intent. The configured vouch role is reconciled at startup, when configured, when a member joins, and whenever a member role update is observed; members without an active vouch lose that role.

New manual vouch givers use the current default allowance (2 by default). OS users receive five available vouches by default; the Guild Owner can set or remove a user-specific OS allowance with `-vouch limit @user number` and `-vouch limit remove @user`. A giver's custom limit overrides their default and is enforced against active vouches. Role-member limits remain an independent configuration and never change vouch allowances. An exhausted giver's attempt is rejected with the configured limit response; STRIPSTAFF punishment applies only to non-Owner/non-OS members.

### Discord rate limits

discord.js queues rate-limited (429) requests and waits for Discord's `retry_after` before sending them again. The bot never treats a rate limit or a temporary Discord failure (5xx, timeout, network reset) as a permanent failure. Enforcement actions retry inline while honoring `retry_after`. These actions are: vouch-role removal and restore, limited-role reversal, STRIPSTAFF, reward/vouch-role assignment and removal, force-management strips, and audit-log lookups. If Discord keeps rate limiting, the action is queued for an automatic background retry and logged as "automatic retry scheduled" instead of "failed". Before each retry the bot re-checks that the action is still required. For example, it will not remove a vouch role from someone who has since received a real vouch, and it will not assign a reward role after the vouch was taken. A rate limit during `-vouch give` keeps the vouch and assigns its roles automatically. Permanent errors such as Missing Permissions or role hierarchy problems still roll back and are reported as failures.

## Tests

Run `npm test` to exercise allowance restoration, vouch role assignment/removal, SQLite persistence, live role-limit enforcement, unauthorized vouch-role reversal, and owner/OS/bot punishment exemptions.