/**
 * deploy-commands.js — Register slash commands with Discord.
 * Run once: node deploy-commands.js
 * Needs DISCORD_CLIENT_ID and DISCORD_BOT_TOKEN in .env
 */

require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Verify your Observer Protocol NFT ownership and claim the Elite Observer role.')
    .addStringOption(opt =>
      opt
        .setName('wallet')
        .setDescription('Your Solana wallet address (public key)')
        .setRequired(true)
    ),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

(async () => {
  try {
    console.log('Registering slash commands…');
    await rest.put(
      Routes.applicationGuildCommands(
        process.env.DISCORD_CLIENT_ID,
        process.env.DISCORD_GUILD_ID
      ),
      { body: commands }
    );
    console.log('✅ Slash commands registered.');
  } catch (err) {
    console.error('Failed to register commands:', err);
    process.exit(1);
  }
})();
