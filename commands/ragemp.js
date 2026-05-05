const { SlashCommandBuilder, EmbedBuilder, ApplicationIntegrationType, InteractionContextType } = require('discord.js');
const path = require('path');
const fs = require('fs');
const { recordSnapshot, getTotalHistory, generateSparkline, getPeak24h, getPeakToday, getAllServerPeaksToday, stripLeadingEmoji } = require('../stats');
const db = require('../db');

const CONFIG_PATH = path.join(__dirname, '..', 'georgian-servers.json');
const BANNER = 'https://media.discordapp.net/attachments/900441540156067920/1491598397428334592/Gemini_Generated_Image_c0j6elc0j6elc0j6.png?ex=69d846c2&is=69d6f542&hm=4c7e158ff1105a744dced673c222fabaf9f1f62929304b79d23672c6b88ebc4e&=&format=webp&quality=lossless&width=924&height=230';

let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 30_000;

function cleanName(name) {
  return stripLeadingEmoji(
    name.replace(/\[.*?\]/g, '').replace(/\s{2,}/g, ' ').trim()
  );
}

function loadManualList() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).ragemp ?? [];
  } catch {
    return [];
  }
}

function clearCache() {
  cache = { data: null, timestamp: 0 };
}

async function buildEmbed() {
  let servers;

  if (cache.data && Date.now() - cache.timestamp < CACHE_TTL) {
    servers = cache.data;
  } else {
    const res = await fetch('https://cdn.rage.mp/master/');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const manualList = loadManualList();

    servers = Object.entries(data)
      .filter(([addr, s]) => {
        if (manualList.includes(addr)) return true;
        const name = (s.name || '').toLowerCase();
        return name.includes('georgia') || name.includes('საქართველო');
      })
      .map(([addr, s]) => ({
        addr,
        ...s,
        api_peak: s.peak ?? s.peakPlayers ?? s.peak_players ?? null
      }))
      .sort((a, b) => (b.players ?? 0) - (a.players ?? 0));

    cache = { data: servers, timestamp: Date.now() };
  }

  const totalPlayers = servers.reduce((sum, s) => sum + (s.players ?? 0), 0);
  recordSnapshot('ragemp', servers, totalPlayers);

  const embed = new EmbedBuilder()
    .setTitle('🇬🇪 ქართული RageMP სერვერები')
    .setColor(0x8B0000)
    .setImage(BANNER)
    .setTimestamp();

  if (servers.length === 0) {
    embed.setDescription('ქართული სერვერები ვერ მოიძებნა.');
    return embed;
  }

  const online = servers.filter(s => (s.players ?? 0) > 0).length;
  const localPeaks = getAllServerPeaksToday('ragemp');
  const dbPeaks = await db.getServerPeaksToday('ragemp');
  // Merge: take higher of DB vs local for each server
  const serverPeaks = new Map(localPeaks);
  for (const [id, peak] of dbPeaks) {
    if (peak > (serverPeaks.get(id) || 0)) serverPeaks.set(id, peak);
  }

  const visibleServers = servers.filter(s => (s.players ?? 0) > 0);
  const lines = visibleServers.slice(0, 25).map((s, i) => {
    const rank = `\`${String(i + 1).padStart(2, ' ')}\``;
    const dot = (s.players ?? 0) === 0 ? '⚫' : '🟢';
    const name = cleanName(s.name || s.addr);
    const display = name.length > 28 ? name.slice(0, 27) + '…' : name;
    const peak = serverPeaks.get(s.addr) || 0;
    const peakStr = peak > 0 ? ` (პიკი: ${peak})` : '';
    return `${rank} ${dot} **${display}** — ${s.players ?? 0}/${s.maxplayers ?? '?'}${peakStr}`;
  });

  const ts = Math.floor(Date.now() / 1000);
  embed.setDescription(`👥 **${totalPlayers} მოთამაშე ონლაინ** ${online} სერვერზე\n\n${lines.join('\n')}\n\n-# განახლდა <t:${ts}:R> • დღე იწყება 06:00-ზე`);

  const sparkline = generateSparkline(getTotalHistory('ragemp'));
  const peak = getPeak24h('ragemp');
  const todayPeak = getPeakToday('ragemp');

  if (sparkline || peak || todayPeak) {
    const parts = [];
    if (sparkline) parts.push(`\`${sparkline}\``);
    if (todayPeak) parts.push(`დღის პიკი: **${todayPeak.p}** <t:${todayPeak.t}:t>`);
    if (peak && (!todayPeak || peak.p !== todayPeak.p)) parts.push(`24h პიკი: **${peak.p}** <t:${peak.t}:t>`);
    embed.addFields([{ name: '📊 სტატისტიკა', value: parts.join('  '), inline: false }]);
  }

  return embed;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ragemp')
    .setDescription('Show Georgian RageMP servers')
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel),

  buildEmbed,
  clearCache,

  async execute(interaction) {
    await interaction.deferReply();
    try {
      const embed = await buildEmbed();
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('[/ragemp]', err);
      await interaction.editReply('Failed to fetch RageMP server list. Try again later.');
    }
  }
};
