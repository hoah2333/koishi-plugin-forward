import { Context, h, Schema, Logger, Time } from "koishi";
import {} from "koishi-plugin-adapter-onebot";
import {} from "@satorijs/adapter-discord";
import type { Bot, Session } from "koishi";
import type { Discord, DiscordBot } from "@satorijs/adapter-discord";

export const name = "forward";

export const inject = ["database"];

declare module "koishi" {
    interface Tables {
        forward_sentMessage: SentMessage;
    }
}

interface Config {
    platform: string;
    selfId: string;
    channelId: string;
    blockId: string[];
}

export interface Configs {
    configs: Record<string, Config>;
    rules: {
        from: string;
        to: string;
    }[];
    delay: number;
}

interface SentMessage {
    id?: number;
    fromMessageId: string;
    fromBot: string;
    toMessageId: string;
    toBot: string;
    fromChannelId: string;
    toChannelId: string;
    time: Date;
}

export const Config: Schema<Configs> = Schema.intersect([
    Schema.object({
        configs: Schema.dict(
            Schema.intersect([
                Schema.object({
                    platform: Schema.string().required().description("平台名称"),
                    selfId: Schema.string().required().description("自身 ID"),
                    channelId: Schema.string().required().description("频道 ID"),
                    blockId: Schema.array(Schema.string().description("转发屏蔽 ID")).description("转发屏蔽列表")
                })
            ]).description("配置名称")
        )
            .collapse(true)
            .description("配置列表")
    }).description("转发配置"),
    Schema.object({
        rules: Schema.array(
            Schema.object({
                from: Schema.string().required().description("来源配置"),
                to: Schema.string().required().description("目标配置")
            })
        )
            .collapse(true)
            .description("规则列表"),
        delay: Schema.natural()
            .role("ms")
            .default(0.2 * Time.second)
            .description("发送间隔（默认 200 毫秒）")
    }).description("转发规则")
]);

export function apply(ctx: Context, config: Configs) {
    ctx.model.extend("forward_sentMessage", {
        id: "unsigned",
        fromMessageId: "string(64)",
        fromBot: "string(64)",
        toMessageId: "string(64)",
        toBot: "string(64)",
        fromChannelId: "string(64)",
        toChannelId: "string(64)",
        time: "timestamp"
    });
    let logger: Logger = new Logger("forward");
    for (const groupList of config.rules) {
        let configs: Record<string, Config> = config.configs;
        let from: Config = configs[groupList.from];
        let to: Config = configs[groupList.to];

        ctx.platform(from.platform)
            .self(from.selfId)
            .channel(from.channelId)
            .on(
                "message-created",
                async (session: Session<never, never, Context>): Promise<void> => {
                    let sentMessage: SentMessage[] = [];
                    let avatar: string = session.event.user.avatar;
                    let prefix: h =
                        to.platform == "discord"
                            ? h("author", {
                                  name: session.username,
                                  avatar
                              })
                            : h.text(`[${session.username}]\n`);
                    let bot: Bot<Context, any> = ctx.bots[`${to.platform}:${to.selfId}`];

                    // 不接受机器人自己发的消息
                    if (session.userId === from.selfId) {
                        return;
                    }

                    // 不接受被屏蔽用户发的消息
                    for (const blockId of from.blockId) {
                        if (session.userId === blockId) {
                            return;
                        }
                    }

                    let filtered: h[];
                    let quoteMessages: SentMessage[] = [];
                    if (session.event.message.quote) {
                        if (
                            session.event.selfId === session.event.message.quote.user.id ||
                            session.event.message.quote.user.isBot
                        ) {
                            quoteMessages = await ctx.database.get("forward_sentMessage", {
                                toMessageId: session.event.message.quote.id,
                                toBot: session.sid,
                                toChannelId: session.event.channel.id
                            });
                        } else {
                            quoteMessages = await ctx.database.get("forward_sentMessage", {
                                fromMessageId: session.event.message.quote.id,
                                fromBot: session.sid,
                                fromChannelId: session.event.channel.id
                            });
                        }
                    }
                    if (from.platform == "onebot" && to.platform === "discord") {
                        filtered = await onebotRule(session.event.message.elements);
                    } else if (from.platform == "discord" && to.platform === "onebot") {
                        filtered = await discordRule(session.event.message.elements);
                        if (session.event._data.d.embeds) {
                            for (const embed of session.event._data.d.embeds) {
                                filtered = [
                                    ...filtered,
                                    h.text(!!embed.author.name ? embed.author.name + "\n" : ""),
                                    h.text(!!embed.description ? embed.description + "\n" : ""),
                                    h.text(!!embed.footer.text ? embed.footer.text + "\n" : "")
                                ];
                            }
                        }
                    }

                    let payload: h[] = [prefix, ...filtered];

                    if (session.event.message.quote) {
                        prefix = h.text(`[${session.username}]\n`);
                        let quote: h;
                        if (
                            session.event.selfId === session.event.message.quote.user.id ||
                            session.event.message.quote.user.isBot
                        ) {
                            let quoteMessage: SentMessage = quoteMessages.find(
                                (value: SentMessage): boolean =>
                                    value.fromBot === `${to.platform}:${to.selfId}` &&
                                    value.fromChannelId === to.channelId
                            );
                            if (quoteMessage) {
                                quote = h.quote(quoteMessage.fromMessageId);
                            }
                        } else {
                            let quoteMessage: SentMessage = quoteMessages.find(
                                (value: SentMessage): boolean =>
                                    value.toBot === `${to.platform}:${to.selfId}` &&
                                    value.toChannelId === to.channelId
                            );

                            if (quoteMessage) {
                                quote = h.quote(quoteMessage.toMessageId);
                            }
                        }

                        payload = [quote, prefix, ...filtered];
                    }

                    try {
                        let sentMessageIds: string[] = await bot.sendMessage(to.channelId, payload);

                        if (from.platform === "onebot" && to.platform === "discord") {
                            if (session.event.message.elements[0].type == "forward") {
                                let forwardMessage = await session.onebot.getForwardMsg(
                                    session.event.message.elements[0].attrs.id
                                );
                                let forwardPayload: h[] = [];
                                for (const message of forwardMessage) {
                                    let singleMessagePayload: h[] = [];
                                    for (const content of message.content) {
                                        let payload: h[] = [];
                                        if (content.type === "text") {
                                            payload = [h.text(content.data.text)];
                                        } else if (content.type === "image") {
                                            try {
                                                let res = await ctx.http(content.data.url, {
                                                    responseType: "arraybuffer"
                                                });
                                                payload = [
                                                    h.image(
                                                        Buffer.from(res.data),
                                                        `image/${content.data.file
                                                            .split(".")
                                                            .pop()}`
                                                    )
                                                ];
                                            } catch (error) {
                                                logger.error(error);
                                                payload = [h.text("[图片]")];
                                            }
                                        } else if (content.type === "json") {
                                            let data = JSON.parse(content.data.data);
                                            if (data.app === "com.tencent.miniapp_01") {
                                                let card = data.meta.detail_1;

                                                payload = [
                                                    h.text(
                                                        `[卡片消息] - ${card.title}\n${card.desc}\n${card.qqdocurl}`
                                                    ),
                                                    h.image(
                                                        `${
                                                            card.preview.startsWith("http")
                                                                ? ""
                                                                : "https://"
                                                        }${card.preview}`
                                                    )
                                                ];
                                            } else if (data.app === "com.tencent.structmsg") {
                                                let card = data.meta[data.view];
                                                payload = [
                                                    h.text(
                                                        `[卡片消息] - ${card.tag}\n${card.title}\n${card.desc}\n${card.jumpUrl}`
                                                    )
                                                ];
                                            }
                                        }

                                        singleMessagePayload = [
                                            ...singleMessagePayload,
                                            ...payload
                                        ];
                                    }
                                    forwardPayload.push(
                                        h("message", {}, [
                                            h("author", {
                                                name: message.sender.nickname,
                                                avatar: `http://q.qlogo.cn/headimg_dl?dst_uin=${message.sender.user_id}&spec=640`
                                            }),
                                            ...singleMessagePayload
                                        ])
                                    );
                                }
                                sentMessageIds = await bot.sendMessage(to.channelId, [
                                    prefix,
                                    h("text", {
                                        content: "[合并转发]"
                                    }),
                                    h(
                                        "message",
                                        {
                                            forward: true
                                        },
                                        h("message", {}, [prefix, ...forwardPayload])
                                    )
                                ]);
                            }
                            if (session.event.message.elements[0].type == "json") {
                                sentMessageIds = await cardSimuSend(
                                    JSON.parse(session.event.message.elements[0].attrs.data)
                                );
                            }
                        }

                        for (const msgId of sentMessageIds) {
                            sentMessage.push({
                                fromMessageId: session.event.message.id,
                                fromBot: `${session.event.platform}:${session.selfId}`,
                                toMessageId: msgId,
                                toBot: `${to.platform}:${to.selfId}`,
                                fromChannelId: session.event.channel.id,
                                toChannelId: to.channelId,
                                time: new Date()
                            });
                        }
                    } catch (error) {
                        ctx.logger.error(error);
                    }

                    if (sentMessage.length != 0) {
                        await ctx.database.upsert("forward_sentMessage", sentMessage);
                    }

                    async function cardSimuSend(
                        data: Record<string, any>,
                        threadId?: string
                    ): Promise<string[]> {
                        let card: Record<string, any>;
                        let embed: Record<string, any> = [];
                        if (data.app === "com.tencent.miniapp_01") {
                            card = data.meta.detail_1;
                            embed = [
                                {
                                    title: card.desc,
                                    url: card.qqdocurl,
                                    color: 3518885, // #35B1A5
                                    image: {
                                        url: `${card.preview.startsWith("http") ? "" : "https://"}${
                                            card.preview
                                        }`
                                    },
                                    footer: {
                                        text: card.title,
                                        icon_url: card.icon
                                    }
                                }
                            ];
                        } else if (data.app === "com.tencent.structmsg") {
                            card = data.meta[data.view];
                            embed = [
                                {
                                    title: card.title,
                                    description: card.desc,
                                    url: card.jumpUrl,
                                    color: 3518885, // #35B1A5
                                    image: {
                                        url: card.preview
                                    },
                                    footer: {
                                        text: card.tag,
                                        icon_url: card.source_icon
                                    }
                                }
                            ];
                        }

                        let webhook: Discord.Webhook = await (
                            bot as unknown as DiscordBot
                        ).ensureWebhook(to.channelId);
                        let created = await bot.internal.executeWebhook(
                            webhook.id,
                            webhook.token,
                            {
                                username: session.username,
                                avatar_url: avatar,
                                embeds: embed
                            },
                            Object.assign({ wait: true }, threadId ? { threadId: threadId } : {})
                        );
                        return [created.id];
                    }

                    async function onebotRule(elements: h[]) {
                        return h.transformAsync(elements, {
                            async text(attrs: Record<string, string>) {
                                return h.text(attrs.content);
                            },
                            async file(attrs) {
                                if (attrs.src.split(".")[1] == "mp4") {
                                    return h.text(`[视频 - ${attrs.src}]`);
                                }
                            },
                            async forward(attrs) {
                                return "";
                            },
                            async audio(attrs) {
                                // let pcm = await ctx.silk.decode(attrs.path, 24000);
                                // let converedAudio: Buffer = await ctx.ffmpeg
                                //     .builder()
                                //     .input(Buffer.from(pcm.data))
                                //     .inputOption(
                                //         "-f",
                                //         "s16le",
                                //         "-ar",
                                //         "24000",
                                //         "-ac",
                                //         "1",
                                //         "-acodec",
                                //         "libamr_nb"
                                //     )
                                //     .outputOption("-f", "wav")
                                //     .run("buffer");
                                // return h.audio(converedAudio, "audio/vnd.wave");
                                if (attrs.src.split(".")[1] == "amr") {
                                    return h.text(`[语音]`);
                                }
                            },
                            async mface(attrs) {
                                return h.image(attrs.url);
                            },
                            async json(attrs) {
                                let data: Record<string, any> = JSON.parse(attrs.data);
                                if (data.app === "com.tencent.miniapp_01") {
                                    return h.text("");
                                } else if (data.app === "com.tencent.structmsg") {
                                    return h.text("");
                                }
                            },
                            async at(attrs) {
                                return h.text(`@${attrs.name}`);
                            }
                        });
                    }

                    async function discordRule(elements: h[]) {
                        return h.transformAsync(elements, {
                            async text(attrs: Record<string, string>) {
                                return h.text(attrs.content);
                            },
                            async img(attrs: Record<string, string>) {
                                try {
                                    let res = await ctx.http(attrs.src, {
                                        responseType: "arraybuffer"
                                    });
                                    return h.image(Buffer.from(res.data), attrs.type);
                                } catch (error) {
                                    logger.error(error);
                                    return h.text(attrs.content);
                                }
                            },
                            async reply(attrs: Record<string, string>) {
                                return h.text(`[Reply to ${attrs.id}]\n`);
                            },
                            async sticker(attrs: Record<string, string>, children: h[]) {
                                try {
                                    let res = await ctx.http(children[0].attrs.src, {
                                        responseType: "arraybuffer"
                                    });
                                    return h.image(Buffer.from(res.data), "image/webp");
                                } catch (error) {
                                    logger.error(error);
                                    return h.text(`[贴纸 - ${attrs.name}]`);
                                }
                            },
                            async record(attrs: Record<string, string>) {
                                // let res = await ctx.http(attrs.src, { responseType: "arraybuffer" });
                                // let converedAudio: Buffer = await ctx.ffmpeg
                                //     .builder()
                                //     .input(Buffer.from(res.data))
                                //     .inputOption("-acodec", "libvorbis", "-acodec", "pcm_s16le")
                                //     .outputOption("-f", "wav")
                                //     .run("buffer");
                                // let pcm = await ctx.silk.encode(converedAudio, 24000);
                                // return h.audio(Buffer.from(pcm.data), "audio/amr");
                                return h.text(`[语音]`);
                            },
                            async face(attrs: Record<string, string>, children: h[]) {
                                try {
                                    let res = await ctx.http(children[0].attrs.src, {
                                        responseType: "arraybuffer"
                                    });
                                    return h.image(Buffer.from(res.data), "image/webp");
                                } catch (error) {
                                    logger.error(error);
                                    return h.text(`[表情 - ${attrs.name}]`);
                                }
                            },
                            async sharp(attrs: Record<string, string>) {
                                let channel: Discord.Channel = await session.discord.getChannel(attrs.id);
                                return h.text(`#${channel.name}`);
                            }
                        });
                    }

                    await ctx.sleep(config.delay);
                }
            );
    }
}
