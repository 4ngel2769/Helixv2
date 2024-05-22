import './lib/setup';
import '@kbotdev/plugin-modules/register';

import { LogLevel, SapphireClient } from '@sapphire/framework';
import { GatewayIntentBits, Partials } from 'discord.js';
import { env } from 'process';
// import Keyv from 'keyv';

// import SoftUI  from 'dbd-soft-ui';
// import config from '../config.json';

// let DBD = require('discord-dashboard');

const client = new SapphireClient({
	subcommandsAdvanced: {
		/* All options are optionals */
		nameCommandsAutogenerated: true
		/* more optional options.... */
	},
	defaultPrefix: env.PREFIX,
	regexPrefix: /^(hey +)?bot[,! ]/i,
	caseInsensitiveCommands: false,
	logger: {
		level: LogLevel.Debug
	},
	shards: 'auto',
	intents: [
		GatewayIntentBits.DirectMessageReactions,
		GatewayIntentBits.DirectMessages,
		GatewayIntentBits.GuildModeration,
		GatewayIntentBits.GuildEmojisAndStickers,
		GatewayIntentBits.GuildMembers,
		GatewayIntentBits.GuildMessageReactions,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildVoiceStates,
		GatewayIntentBits.MessageContent
	],
	partials: [Partials.Channel],
	loadMessageCommandListeners: true
});

const main = async () => {
	try {
		client.logger.info('Logging in');
		await client.login();
		client.logger.info('logged in');
	} catch (error) {
		client.logger.fatal(error);
		await client.destroy();
		process.exit(1);
	}
};

void main();
