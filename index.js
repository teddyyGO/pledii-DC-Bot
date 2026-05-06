const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Events, Collection } = require('discord.js');
const db = require('./db');
const stats = require('./stats');
const { startAdmin } = require('./admin');
require('dotenv').config();

const CONFIG_PATH = path.join(__dirname, 'georgian-servers.json');
const UPDATE_INTERVAL = 60 * 1000;

async function updatePinnedMessages(client) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return;
  }

  const pinned = config.pinned ?? {};
  const games = [
    { key: 'ragemp', buildEmbed: () => require('./commands/ragemp').buildEmbed() },
    { key: 'redm',   buildEmbed: () => require('./commands/redm').buildEmbed()   },
    { key: 'samp',   buildEmbed: () => require('./commands/samp').buildEmbed()   },
    { key: 'total',  buildEmbed: () => require('./commands/total').buildEmbed()  }
  ];

  let configUpdated = false;

  for (const { key, buildEmbed } of games) {
    // Record combined total snapshot before building the total embed
    if (key === 'total') stats.recordCombinedSnapshot();

    const p = pinned[key] ?? {};
    if (!p.channelId || !p.messageId) continue;

    try {
      const channel = await client.channels.fetch(p.channelId);
      const msg = await channel.messages.fetch(p.messageId);
      const embed = await buildEmbed();
      await msg.edit({ embeds: [embed] });
      console.log(`[pingeorgia] Updated ${key} pinned message`);
    } catch (err) {
      console.error(`[pingeorgia] Failed to update ${key}:`, err.message);
      // Clear invalid message ID so it stops trying to update it
      if (err.code === 10008 || err.message.includes('Unknown Message')) {
        console.log(`[pingeorgia] Clearing invalid message ID for ${key}`);
        delete pinned[key];
        configUpdated = true;
      }
    }
  }

  // Save config if we cleared any invalid message IDs
  if (configUpdated) {
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    } catch (err) {
      console.error('[pingeorgia] Failed to save config:', err);
    }
  }
}

if (!process.env.TOKEN) {
  console.error('❌ TOKEN is missing in .env');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

client.commandHandlers = new Collection();

const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = require(filePath);

  if (command.data) {
    client.commandHandlers.set(command.data.name, command);
    console.log(`📦 Loaded command: /${command.data.name}`);
  }

  if (Array.isArray(command.commands)) {
    for (const cmd of command.commands) {
      client.commandHandlers.set(cmd.name, command);
      console.log(`📦 Loaded command: /${cmd.name}`);
    }
  }
}

client.once(Events.ClientReady, async readyClient => {
  console.log(`✅ Logged in as ${readyClient.user.tag}`);

  await db.init();

  // Start admin panel web server
  startAdmin();

  // Clean up old DB entries daily
  setInterval(() => db.cleanup(), 24 * 60 * 60 * 1000);

  // Expose updater on client so /refresh can call it without circular imports
  readyClient.updatePinnedMessages = () => updatePinnedMessages(readyClient);

  await updatePinnedMessages(readyClient);
  setInterval(() => updatePinnedMessages(readyClient), UPDATE_INTERVAL);
});

client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isAutocomplete()) {
    const handler = client.commandHandlers.get(interaction.commandName);
    if (handler?.autocomplete) {
      try { await handler.autocomplete(interaction); } catch (err) { console.error('[autocomplete]', err); }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const handler = client.commandHandlers.get(interaction.commandName);
  if (!handler) return;

  try {
    await handler.execute(interaction);
  } catch (error) {
    console.error(error);

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('There was an error while running this command.');
      } else {
        await interaction.reply({
          content: 'There was an error while running this command.'
        });
      }
    } catch (replyError) {
      console.error('Failed to send error response:', replyError);
    }
  }
});

process.on('unhandledRejection', error => {
  console.error('[UNHANDLED REJECTION]', error);
});

process.on('uncaughtException', error => {
  console.error('[UNCAUGHT EXCEPTION]', error);
});

client.on('error', error => {
  console.error('[CLIENT ERROR]', error);
});

client.on('warn', warning => {
  console.warn('[CLIENT WARNING]', warning);
});

client.login(process.env.TOKEN);
