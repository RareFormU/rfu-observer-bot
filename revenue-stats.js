const { EmbedBuilder } = require('discord.js');
const { defaultRevenueService, formatUsdc } = require('./revenue-service');

async function handleRevenueStats(interaction, service = defaultRevenueService) {
  await interaction.deferReply();

  const stats = await service.getStats();
  const embed = new EmbedBuilder()
    .setColor(0xC9A84C)
    .setTitle('RFU Holder Revenue Stats')
    .addFields(
      { name: 'Total Distributed', value: formatUsdc(stats.totalDistributed),       inline: true },
      { name: 'Total Claimed',     value: formatUsdc(stats.totalClaimed),           inline: true },
      { name: 'Holders Earning',   value: String(stats.totalHoldersEarning),        inline: true },
      { name: 'Initiate',          value: String(stats.tierCounts.Initiate || 0),   inline: true },
      { name: 'Observer',          value: String(stats.tierCounts.Observer || 0),   inline: true },
      { name: 'Community Layer',   value: String(stats.tierCounts['Community Layer'] || 0), inline: true }
    )
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

module.exports = { handleRevenueStats };
