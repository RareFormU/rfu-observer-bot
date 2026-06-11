const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { getWalletForUser } = require('./wallet-links');
const { CLAIM_URL, defaultRevenueService, formatUsdc, shortWallet } = require('./revenue-service');

function buildMyRevenueEmbed(summary) {
  return new EmbedBuilder()
    .setColor(0x00ffc8)
    .setTitle('RFU Holder Revenue')
    .setDescription(`Wallet ${shortWallet(summary.wallet)} is linked to your Discord account.`)
    .addFields(
      { name: 'Claimable',   value: formatUsdc(summary.claimable),    inline: true },
      { name: 'Claimed',     value: formatUsdc(summary.claimed),      inline: true },
      { name: 'Total',       value: formatUsdc(summary.total),        inline: true },
      { name: 'Tier',        value: summary.tier || 'None',           inline: true },
      { name: 'Tier Weight', value: String(summary.tierWeight),       inline: true }
    )
    .setFooter({ text: 'RareForm United holder revenue' })
    .setTimestamp();
}

function claimButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Claim')
      .setStyle(ButtonStyle.Link)
      .setURL(CLAIM_URL)
  );
}

async function handleMyRevenue(interaction, service = defaultRevenueService, walletLookup = getWalletForUser) {
  await interaction.deferReply({ ephemeral: true });

  const wallet = walletLookup(interaction.user.id);
  if (!wallet) {
    return interaction.editReply({ content: 'No verified wallet found. Run /verify first.' });
  }

  const summary = await service.getWalletRevenue(wallet);
  if (!summary.hasHoldings) {
    return interaction.editReply({ content: `Wallet ${shortWallet(wallet)} has no holdings registered for holder revenue yet.` });
  }

  return interaction.editReply({
    embeds: [buildMyRevenueEmbed(summary)],
    components: [claimButtonRow()],
  });
}

module.exports = { handleMyRevenue };
