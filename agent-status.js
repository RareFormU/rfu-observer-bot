/**
 * agent-status.js - /agent-status slash command
 * Shows active monitors, per-source signal counts, and last alert time
 * drawn from the in-memory ring buffer populated by /agent-alert.
 */

const { createRevenueService, formatUsdc } = require('./revenue-service');
const defaultService = createRevenueService();

const MONITORS = ['whale-flow', 'jupiter-swap'];

async function handleAgentStatus(interaction, alertBuffer, service = defaultService) {
  await interaction.deferReply({ ephemeral: true });

  const now = Date.now();
  const cutoff = now - 24 * 60 * 60 * 1000; // 24 h window

  const recent = alertBuffer.filter(e => e.ts >= cutoff);

  const counts = {};
  for (const monitor of MONITORS) counts[monitor] = 0;
  for (const entry of recent) {
    if (counts[entry.source] !== undefined) counts[entry.source] += 1;
    else counts[entry.source] = (counts[entry.source] ?? 0) + 1;
  }

  const lastEntry = alertBuffer.length > 0 ? alertBuffer[alertBuffer.length - 1] : null;
  const lastTs = lastEntry
    ? `<t:${Math.floor(lastEntry.ts / 1000)}:R> (${new Date(lastEntry.ts).toUTCString()})`
    : 'none yet';

  const monitorLines = MONITORS.map(monitor =>
    `* **${monitor}** - ${counts[monitor] ?? 0} signal(s) in last 24h`
  ).join('\n');

  const lines = [
    `**Observer Agent - Status**`,
    ``,
    `**Mode:** OBSERVE`,
    `**Active monitors (${MONITORS.length}):**`,
    monitorLines,
    ``,
    `**Total signals (24h):** ${recent.length} / ${alertBuffer.length} buffered`,
    `**Last alert:** ${lastTs}`,
    ``,
    `-# Ring buffer: last ${alertBuffer.length} alert(s) held in memory`,
  ];

  try {
    const stats = await service.getStats();
    lines.push(``, `**Total revenue distributed to holders:** ${formatUsdc(stats.totalDistributed)}`);
  } catch {
    // Omit revenue status if RPC is unavailable.
  }

  return interaction.editReply({ content: lines.join('\n') });
}

module.exports = { handleAgentStatus };
