const { SlashCommandBuilder, EmbedBuilder, ApplicationIntegrationType, InteractionContextType } = require('discord.js');
const path = require('path');
const fs = require('fs');
const { recordSnapshot, getTotalHistory, generateSparkline, getPeak24h, getPeakToday, getAllServerPeaksToday, stripLeadingEmoji } = require('../stats');
const db = require('../db');

const CONFIG_PATH = path.join(__dirname, '..', 'georgian-servers.json');
const BANNER = 'https://media.discordapp.net/attachments/927693311039402025/1490002133687468114/image.png';

let cache = { data: null, timestamp: 0, signature: null, lastDataChangeTs: 0 };
const CACHE_TTL = 30_000;

// Per-server backoff state: tracks consecutive API misses so dead servers aren't
// fetched (or shown) every cycle. Resets automatically when a server comes back.
const serverState = new Map(); // endpoint -> { misses: number, nextCheckAt: number }

function getBackoffMs(misses) {
  // First 2 misses: no backoff (transient outage). After that: 5 → 10 → 20 → 60 min.
  if (misses < 3) return 0;
  const minutes = Math.pow(2, misses - 3) * 5; // 5, 10, 20, 40, 80…
  return Math.min(minutes, 60) * 60_000;
}

function loadManualList() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).redm ?? [];
  } catch {
    return [];
  }
}

function stripColors(str) {
  return str.replace(/\^[0-9a-zA-Z]/g, '').trim();
}

function clearCache() {
  cache = { data: null, timestamp: 0, signature: null, lastDataChangeTs: 0 };
  serverState.clear(); // also reset all backoffs so every server gets a fresh chance
}

function buildSignature(servers) {
  return [...servers]
    .map(s => `${s.endpoint}|${s.clients}|${s.maxclients}|${s.hostname}`)
    .sort()
    .join('\n');
}

async function fetchSingleServer(endpoint) {
  try {
    const res = await fetch(
      `https://servers-frontend.fivem.net/api/servers/single/${encodeURIComponent(endpoint)}`,
      { signal: AbortSignal.timeout(5_000) }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchAutoDetected() {
  try {
    const res = await fetch(
      'https://servers-frontend.fivem.net/api/servers/streamRedir/?locale=ka-GE&gameName=redm',
      { signal: AbortSignal.timeout(15_000) }
    );
    if (!res.ok) return [];

    const text = await res.text();
    const servers = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { servers.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
    return servers;
  } catch (err) {
    console.warn('[/redm] Auto-detect failed:', err.message);
    return [];
  }
}

function formatServer(data, endpoint) {
  return {
    endpoint,
    hostname: stripColors(data.hostname || data.sv_hostname || endpoint),
    clients: data.clients ?? 0,
    maxclients: data.sv_maxclients ?? data.svMaxclients ?? '?'
  };
}

async function buildEmbed() {
  let servers;
  let updatedTs;

  if (cache.data && Date.now() - cache.timestamp < CACHE_TTL) {
    servers = cache.data;
    updatedTs = cache.lastDataChangeTs || Math.floor(cache.timestamp / 1000);
  } else {
    const manualList = loadManualList();
    const byEndpoint = new Map();

    // Parallelize fetching all manual servers, skipping those in backoff
    const now = Date.now();
    const fetchPromises = manualList.map(async (endpoint) => {
      const state = serverState.get(endpoint) || { misses: 0, nextCheckAt: 0 };

      // Server is in backoff — don't fetch or display it this cycle
      if (state.nextCheckAt > now) return null;

      const raw = await fetchSingleServer(endpoint);
      if (raw?.Data) {
        // Server is back — reset backoff
        serverState.set(endpoint, { misses: 0, nextCheckAt: 0 });
        return [endpoint, formatServer(raw.Data, endpoint)];
      } else {
        // API miss — increment failure count and schedule next probe
        const misses = state.misses + 1;
        const backoff = getBackoffMs(misses);
        serverState.set(endpoint, { misses, nextCheckAt: backoff > 0 ? now + backoff : 0 });
        if (backoff > 0) {
          const mins = Math.round(backoff / 60_000);
          console.warn(`[/redm] ${endpoint} offline (${misses} misses) — skipping for ${mins}m`);
          return null; // hide from list while in backoff
        }
        // Within the free retries: show as offline so it's not invisible
        return [endpoint, { endpoint, hostname: endpoint, clients: 0, maxclients: '?' }];
      }
    });

    const results = await Promise.all(fetchPromises);
    for (const result of results) {
      if (result) byEndpoint.set(result[0], result[1]);
    }

    const autoDetected = await fetchAutoDetected();
    for (const s of autoDetected) {
      const ep = s.EndPoint;
      if (!ep) continue;
      byEndpoint.set(ep, formatServer(s.Data, ep));
    }

    servers = [...byEndpoint.values()].sort((a, b) => b.clients - a.clients);

    const nowMs = Date.now();
    const nowTs = Math.floor(nowMs / 1000);
    const signature = buildSignature(servers);
    updatedTs = signature === cache.signature
      ? (cache.lastDataChangeTs || nowTs)
      : nowTs;

    cache = { data: servers, timestamp: nowMs, signature, lastDataChangeTs: updatedTs };
  }

  const totalPlayers = servers.reduce((sum, s) => sum + s.clients, 0);
  recordSnapshot('redm', servers, totalPlayers);

  const embed = new EmbedBuilder()
    .setTitle('🇬🇪 ქართული RedM სერვერები')
    .setColor(0x8B0000)
    .setImage(BANNER)
    .setTimestamp(new Date((updatedTs || Math.floor(Date.now() / 1000)) * 1000));

  if (servers.length === 0) {
    embed.setDescription('ქართული სერვერები ვერ მოიძებნა.');
    return embed;
  }

  const online = servers.filter(s => s.clients > 0).length;
  const localPeaks = getAllServerPeaksToday('redm');
  const dbPeaks = await db.getServerPeaksToday('redm');
  const serverPeaks = new Map(localPeaks);
  for (const [id, peak] of dbPeaks) {
    if (peak > (serverPeaks.get(id) || 0)) serverPeaks.set(id, peak);
  }

  const visibleServers = servers.slice(0, 25);
  const lines = visibleServers.map((s, i) => {
    const rank = `\`${String(i + 1).padStart(2, ' ')}\``;
    const dot = s.clients === 0 ? '⚫' : '🟢';
    const name = stripLeadingEmoji(s.hostname || s.endpoint);
    const display = name.length > 28 ? name.slice(0, 27) + '…' : name;
    const peak = serverPeaks.get(s.endpoint) || 0;
    const peakStr = peak > 0 ? ` (პიკი: ${peak})` : '';
    return `${rank} ${dot} **${display}** — ${s.clients}/${s.maxclients}${peakStr}`;
  });

  const ts = updatedTs || Math.floor(Date.now() / 1000);
  embed.setDescription(`👥 **${totalPlayers} მოთამაშე ონლაინ** ${online} სერვერზე\n\n${lines.join('\n')}\n\n-# განახლდა <t:${ts}:R> • დღე იწყება 06:00-ზე`);

  const sparkline = generateSparkline(getTotalHistory('redm'));
  const peak = getPeak24h('redm');
  const todayPeak = getPeakToday('redm');

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
    .setName('redm')
    .setDescription('Show Georgian RedM servers')
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
      console.error('[/redm]', err);
      await interaction.editReply('Failed to fetch RedM server list. Try again later.');
    }
  }
};
