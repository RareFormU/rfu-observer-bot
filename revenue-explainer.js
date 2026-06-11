const { EmbedBuilder } = require('discord.js');

async function handleRevenueExplainer(interaction) {
  const embed = new EmbedBuilder()
    .setColor(0x00ffc8)
    .setTitle('How RFU Holder Revenue Works')
    .setDescription(
      'RFU sells an intelligence feed for AI agents. When agents pay for premium research or access, a holder share is routed on-chain to the revenue pool. NFT holders earn by tier weight, and claims happen from the dashboard.'
    )
    .addFields(
      { name: 'Tiers',  value: 'Initiate weight 1, Observer weight 3, Community Layer weight 10.' },
      { name: 'Claims', value: 'Discord shows status and sends the dashboard link. Wallet claims are handled outside Discord.' }
    );

  return interaction.reply({ embeds: [embed] });
}

module.exports = { handleRevenueExplainer };
