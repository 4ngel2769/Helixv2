import { ApplyOptions } from '@sapphire/decorators';
import { Args, Command, CommandOptions, container } from '@sapphire/framework';
import { 
    ActionRowBuilder, 
    ButtonBuilder, 
    EmbedBuilder, 
    StringSelectMenuBuilder,
    ButtonStyle,
    StringSelectMenuInteraction,
    ButtonInteraction,
    ColorResolvable,
    Message,
    TextChannel,
    PermissionFlagsBits,
    PermissionsBitField
} from 'discord.js';
import { Guild as DiscordGuild } from 'discord.js';
import { Guild as GuildModel } from '../../models/Guild';
import config from '../../config';
import { Module, Modules, type IsEnabledContext, type ModuleError } from '@kbotdev/plugin-modules';
import { Result } from '@sapphire/result';
import { ModuleCommand, ModuleCommandUnion } from '@kbotdev/plugin-modules';
import { GeneralModule } from '../../modules/General';

const COMMANDS_PER_PAGE = 5;

interface ExtendedCommand extends Command<Args, CommandOptions> {
    category: string | null;
}

interface CommandPermissions {
    [key: string]: bigint[];
}

interface ExtendedModule extends Module {
    name: string;
    IsEnabled: (context: IsEnabledContext) => Promise<Result<boolean, ModuleError>>;
    requiredPermissions?: bigint[];
}

@ApplyOptions<Command.Options>({
    name: 'help',
    description: 'Shows all available commands',
    enabled: true
})
export class HelpCommand extends ModuleCommand<GeneralModule> {
    public constructor(context: ModuleCommand.LoaderContext, options: ModuleCommand.Options) {
        super(context, {
            ...options,
            module: 'GeneralModule',
            description: 'Shows all available commands',
            enabled: true
        });
    }

    // Define required permissions for each module
    private modulePermissions: CommandPermissions = {
        Administration: [
            PermissionFlagsBits.Administrator,
            PermissionFlagsBits.ManageGuild
        ],
        Moderation: [
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ManageRoles,
            PermissionFlagsBits.BanMembers,
            PermissionFlagsBits.KickMembers,
            PermissionFlagsBits.ModerateMembers
        ]
    };

    public override async registerApplicationCommands(registry: Command.Registry): Promise<void> {
        await registry.registerChatInputCommand((builder) =>
            builder
                .setName('help')
                .setDescription('Shows all available commands')
                .addStringOption((option) =>
                    option
                        .setName('module')
                        .setDescription('Specific module to show commands for')
                        .setRequired(false)
                )
        );
        // No need to store command ID or return anything
        return;
    }

    public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
        await this.handleHelp(interaction);
    }

    public override async messageRun(message: Message) {
        await this.handleHelp(message);
    }

    private async handleHelp(interaction: Command.ChatInputCommandInteraction | Message) {
        const isSlash = 'options' in interaction;
        const guildId = isSlash ? interaction.guildId! : interaction.guild!.id;
        const member = isSlash ? interaction.member : (interaction as Message).member;
        
        // Get guild settings
        const guildData = await GuildModel.findOne({ guildId });
        if (!guildData) return;

        // Get all categories (modules)
        const categories = new Set<string>();
        for (const command of container.stores.get('commands').values()) {
            if (command.category) categories.add(command.category);
        }

        // Filter modules based on user permissions and enabled status
        const enabledModules = await Promise.all(
            Array.from(categories).map(async (category: string) => {
                // Check if module is enabled in guild
                const moduleStatus = guildData[`is${category}Module` as keyof typeof guildData];
                if (moduleStatus === false) return null;

                // Check module's IsEnabled status
                const moduleStore = container.stores.get('modules');
                const module = moduleStore.get(category.toLowerCase() as keyof Modules) as ExtendedModule | undefined;
                
                if (module && typeof module.IsEnabled === 'function') {
                    const moduleCommand = module.container.stores.get('commands').get(module.name);
                    
                    // Check for required module permissions
                    if (module.requiredPermissions) {
                        const hasPermission = module.requiredPermissions.some(perm => {
                            if (!member?.permissions) return false;
                            return typeof member.permissions === 'bigint'
                                ? member.permissions === perm
                                : (member.permissions as Readonly<PermissionsBitField>).has(perm);
                        });
                        if (!hasPermission) return null;
                    }

                    const isEnabled = await module.IsEnabled({
                        guild: interaction.guild! as DiscordGuild,
                        interaction: interaction as any,
                        command: moduleCommand as ModuleCommandUnion
                    });
                    if (isEnabled.isErr() || !isEnabled.unwrap()) return null;
                }

                // Check if user has required permissions for restricted modules
                if (this.modulePermissions[category]) {
                    // Allow if user has any of the required permissions
                    const hasPermission = this.modulePermissions[category].some(perm => {
                        if (!member?.permissions) return false;
                        return typeof member.permissions === 'bigint' 
                            ? member.permissions === perm
                            : (member.permissions as Readonly<PermissionsBitField>).has(perm);
                    });
                    if (!hasPermission) return null;
                }

                return category;
            })
        );

        // Filter out null values and create final array
        const filteredModules = enabledModules.filter((module): module is string => module !== null);

        const moduleSelect = this.createModuleSelect(filteredModules);

        const mainEmbed = new EmbedBuilder()
            .setColor(config.bot.embedColor.default as ColorResolvable)
            .setTitle('Help Menu')
            .setDescription(
                'Select a module from the dropdown menu below to view its commands.\n\n' +
                '**Available Modules:**\n' +
                filteredModules.map(module => `↳ • \`${module}\``).join('\n')
            );

        const row = new ActionRowBuilder<StringSelectMenuBuilder>()
            .addComponents(moduleSelect);

        const response = await (isSlash ? 
            interaction.reply({ 
                embeds: [mainEmbed], 
                components: [row], 
                ephemeral: true, 
                fetchReply: true 
            }) :
            (interaction.channel as TextChannel).send({ embeds: [mainEmbed], components: [row] }));
        const collector = response.createMessageComponentCollector({
            filter: (i) => 
                i.user.id === (isSlash ? interaction.user.id : (interaction as Message).author.id),
            time: 300000
        });

        collector.on('collect', async (i: ButtonInteraction | StringSelectMenuInteraction) => {
            if (i.isStringSelectMenu()) {
                await this.handleModuleSelect(i);
            } else if (i.isButton()) {
                await this.handlePaginationButton(i);
            }
        });

        collector.on('end', () => {
            if (response instanceof Message) {
                response.edit({ components: [] }).catch(() => null);
            }
        });
    }

    private async handleModuleSelect(interaction: StringSelectMenuInteraction) {
        try {
            const selectedModule = interaction.values[0];
            
            // Get commands for the selected module
            const commands = Array.from(container.stores.get('commands').values() as IterableIterator<ExtendedCommand>)
                .filter(cmd => {
                    // Filter commands by module
                    if (cmd.category?.toLowerCase() !== selectedModule) return false;
                    // Check if user has required permissions for the command
                    const requiredPerms = cmd.options?.requiredUserPermissions;
                    if (requiredPerms) {
                        return interaction.member?.permissions instanceof PermissionsBitField && 
                               interaction.member.permissions.has(requiredPerms);
                    }

                    return true;
                });

            if (!commands.length) {
                await interaction.update({
                    embeds: [new EmbedBuilder()
                        .setColor(config.bot.embedColor.default as ColorResolvable)
                        .setTitle(`${selectedModule.charAt(0).toUpperCase() + selectedModule.slice(1)} Commands`)
                        .setDescription('No commands available in this module.')],
                    components: [new ActionRowBuilder<ButtonBuilder>()
                        .addComponents(new ButtonBuilder()
                            .setCustomId('back-to-main')
                            .setLabel('Back to Modules')
                            .setStyle(ButtonStyle.Secondary))]
                });
                return;
            }

            const pages = this.generateCommandPages(commands);
            const embed = this.generateCommandEmbed(pages[0], selectedModule, 1, pages.length);

            const buttons = this.createPaginationButtons(0, pages.length);
            const backButton = new ButtonBuilder()
                .setCustomId('back-to-main')
                .setLabel('Back to Modules')
                .setStyle(ButtonStyle.Secondary);

            const components = [
                new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons),
                new ActionRowBuilder<ButtonBuilder>().addComponents(backButton)
            ];

            await interaction.update({ embeds: [embed], components });
        } catch (error) {
            console.error('Error in handleModuleSelect:', error);
            await interaction.update({
                content: 'An error occurred while fetching commands.',
                components: []
            }).catch(() => null);
        }
    }

    private async handlePaginationButton(interaction: ButtonInteraction) {
        if (interaction.customId === 'back-to-main') {
            // Get guild settings
            const guildId = interaction.guildId!;
            const guildData = await GuildModel.findOne({ guildId });
            if (!guildData) return;

            // Get all categories (modules)
            const categories = new Set<string>();
            for (const command of container.stores.get('commands').values()) {
                if (command.category) categories.add(command.category);
            }

            // Filter modules based on user permissions and enabled status - same as in handleHelp
            const enabledModules = await Promise.all(
                Array.from(categories).map(async (category: string) => {
                    // Check if module is enabled in guild
                    const moduleStatus = guildData[`is${category}Module` as keyof typeof guildData];
                    if (moduleStatus === false) return null;

                    // Check module's IsEnabled status
                    const moduleStore = container.stores.get('modules');
                    const module = moduleStore.get(category.toLowerCase() as keyof Modules) as ExtendedModule | undefined;
                    
                    if (module && typeof module.IsEnabled === 'function') {
                        const moduleCommand = module.container.stores.get('commands').get(module.name);
                        const isEnabled = await module.IsEnabled({
                            guild: interaction.guild! as DiscordGuild,
                            interaction: interaction as any,
                            command: moduleCommand as ModuleCommandUnion
                        });
                        if (isEnabled.isErr() || !isEnabled.unwrap()) return null;
                    }

                    // Check if user has required permissions for restricted modules
                    if (this.modulePermissions[category]) {
                        // Allow if user has any of the required permissions
                        const hasPermission = this.modulePermissions[category].some(perm => {
                            if (!interaction.member?.permissions) return false;
                            return typeof interaction.member.permissions === 'bigint' 
                                ? interaction.member.permissions === perm
                                : (interaction.member.permissions as Readonly<PermissionsBitField>).has(perm);
                        });
                        if (!hasPermission) return null;
                    }

                    return category;
                })
            );

            // Filter out null values
            const filteredModules = enabledModules.filter((module): module is string => module !== null);

            const moduleSelect = this.createModuleSelect(filteredModules);

            const mainEmbed = new EmbedBuilder()
                .setColor(config.bot.embedColor.default as ColorResolvable)
                .setTitle('Help Menu')
                .setDescription(
                    'Select a module from the dropdown menu below to view its commands.\n\n' +
                    '**Available Modules:**\n' +
                    filteredModules.map(module => `↳ • \`${module}\``).join('\n')
                );

            const row = new ActionRowBuilder<StringSelectMenuBuilder>()
                .addComponents(moduleSelect);

            await interaction.update({ embeds: [mainEmbed], components: [row] });
            return;
        }

        const [currentPage] = interaction.message.embeds[0].footer!.text
            .match(/Page (\d+)\/(\d+)/)!
            .slice(1)
            .map(Number);

        let newPage = currentPage;
        if (interaction.customId === 'previous') newPage--;
        if (interaction.customId === 'next') newPage++;
        const selectedModule = interaction.message.embeds[0].title!.split(' ')[0].toLowerCase();
        const commandStore = container.stores.get('commands');
        const commands = Array.from(commandStore.values())
            .filter(cmd => cmd.category?.toLowerCase() === selectedModule) as unknown as ExtendedCommand[];

        const pages = this.generateCommandPages(commands);
        const embed = this.generateCommandEmbed(pages[newPage - 1], selectedModule, newPage, pages.length);
        const buttons = this.createPaginationButtons(newPage - 1, pages.length);

        const backButton = new ButtonBuilder()
            .setCustomId('back-to-main')
            .setLabel('Back to Modules')
            .setStyle(ButtonStyle.Secondary);

        const components = [
            new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons),
            new ActionRowBuilder<ButtonBuilder>().addComponents(backButton)
        ];

        await interaction.update({ embeds: [embed], components });
    }

    private generateCommandPages(commands: ExtendedCommand[]) {
        const pages: ExtendedCommand[][] = [];
        for (let i = 0; i < commands.length; i += COMMANDS_PER_PAGE) {
            pages.push(commands.slice(i, i + COMMANDS_PER_PAGE));
        }
        return pages;
    }

    private generateCommandEmbed(
        commands: ExtendedCommand[],
        moduleName: string,
        currentPage: number,
        totalPages: number
    ) {
        const embed = new EmbedBuilder()
            .setColor(config.bot.embedColor.default as ColorResolvable)
            .setTitle(`${moduleName.charAt(0).toUpperCase() + moduleName.slice(1)} Commands`)
            .setDescription(
                commands.map(cmd => {
                    // Get command ID from application commands
                    const commandId = this.container.client.application?.commands.cache
                        .find(c => c.name === cmd.name)?.id;

                    // Create clickable command mention
                    const commandMention = commandId 
                        ? `</${cmd.name}:${commandId}>`
                        : `\`/${cmd.name}\``;

                    // Get command options if any
                    const options = cmd.options?.options && Array.isArray(cmd.options.options)
                        ? cmd.options.options.map((opt: { name: string }) => `\`${opt.name}\``)
                        .join(', ')
                        : undefined;

                    return `${commandMention}\n↳ ${cmd.description || 'No description available'}${
                        options ? `\nOptions: ${options}` : ''
                    }\n`;
                }).join('\n')
            )
            .setFooter({ text: `Page ${currentPage}/${totalPages}` });

        return embed;
    }

    private createPaginationButtons(currentPage: number, totalPages: number) {
        const previousButton = new ButtonBuilder()
            .setCustomId('previous')
            .setLabel('Previous')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(currentPage === 0);

        const nextButton = new ButtonBuilder()
            .setCustomId('next')
            .setLabel('Next')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(currentPage === totalPages - 1);

        return [previousButton, nextButton];
    }

    private createModuleSelect(enabledModules: string[]) {
        const emojiMap: { [key: string]: string } = {
            general: '⚙️',
            moderation: '🛡️',
            fun: '🎮',
            utility: '🔧',
            music: '🎵',
            economy: '💰',
            leveling: '📈'
        };

        return new StringSelectMenuBuilder()
            .setCustomId('module-select')
            .setPlaceholder('Select a module')
            .addOptions(
                enabledModules.map(module => ({
                    label: module,
                    description: `View ${module} commands`,
                    value: module.toLowerCase(),
                    emoji: emojiMap[module.toLowerCase()] || '📁'
                }))
            );
    }
}