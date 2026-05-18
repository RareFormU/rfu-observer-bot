/**
 * agent-status.js — /agent-status slash command
 * Shows active monitors, per-source signal counts, and last alert time
 * drawn from the in-memory ring buffer populated by /agent-alert.
 */

const MONITORS = ['whale-flow', 'jupiter-swap'];

async function handleAgentStatus(interaction, alertBuffer) {
  await interaction.deferReply({ ephemeral: true });

  const now = Date.now();
  const cutoff = now - 24 * 60 * 60 * 1000; // 24 h window

  const recent = alertBuffer.filter(e => e.ts >= cutoff);

  // Count per source
  const counts = {};
  for (const m of MONITORS) counts[m] = 0;
  for (const e of recent) {
    if (counts[e.source] !== undefined) counts[e.source]++;
    else counts[e.source] = (counts[e.source] ?? 0) + 1;
  }

  // Last alert across all sources
  const lastEntry = alertBuffer.length > 0 ? alertBuffer[alertBuffer.length - 1] : null;
  const lastTs = lastEntry
    ? `<t:${Math.floor(lastEntry.ts / 1000)}:R> (${new Date(lastEntry.ts).toUTCString()})`
    : 'none yet';

  const monitorLines = MONITORS.map(m =>
    `• **${m}** — ${counts[m] ?? 0} signal(s) in last 24h`
  ).join('\n');

  const lines = [
    `🔭 **Observer Agent — Status**`,
    ``,
    `**Mode:** OBSERVE`,
    `**Active monitors (${MONITORS.length}):**`,
    monitorLines,
    ``,
    `**Total signals (24h):** ${recent.length} / ${alertBuffer.length} buffered`,
    `**Last alert:** ${lastTs}`,
    ``,
    `-# Ring buffer: last ${alertBuffer.length} alert(s) held in memory`,
  ].join('\n');

  return interaction.editReply({ content: lines });
}

module.exports = { handleAgentStatus };
