import { Context, h, Logger } from "koishi";
import { Config } from "./types";

import type { Discord } from "@satorijs/adapter-discord";
import type { Message } from "@satorijs/protocol";
import type { Bot, Session } from "koishi";
import type { Payload } from "koishi-plugin-adapter-onebot/lib/types";
import type { Configs, SentMessage } from "./types";

import {} from "@satorijs/adapter-discord";
import {} from "koishi-plugin-adapter-onebot";

export { Config };
export const name = "forward";

export const inject = ["database"];

declare module "koishi" {
  interface Tables {
    forward_sentMessage: SentMessage;
  }
}

export function apply(ctx: Context, config: Configs) {
  ctx.model.extend("forward_sentMessage", {
    id: "unsigned",
    fromMessageId: "string(64)",
    fromBot: "string(64)",
    toMessageId: "string(64)",
    toBot: "string(64)",
    fromChannelId: "string(64)",
    toChannelId: "string(64)",
    time: "timestamp",
  });
  const logger: Logger = new Logger("forward");
  config.rules.map((groupList: { from: string; to: string }): void => {
    const configs: Record<string, Config> = config.configs;
    const from: Config = configs[groupList.from];
    const to: Config = configs[groupList.to];

    const messageHandler = async (session: Session<never, never, Context>): Promise<void> => {
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
      const avatar: string = session.event.user.avatar;
      const bot: Bot = ctx.bots[`${to.platform}:${to.selfId}`];

      const quote: Message = session.event.message.quote;
      const isQuoteBot: boolean = session.event.selfId === quote?.user.id || quote?.user.isBot;

      const quoteMessages: SentMessage[] =
        quote ?
          await ctx.database.get(
            "forward_sentMessage",
            isQuoteBot ?
              { toMessageId: quote.id, toBot: session.sid, toChannelId: session.event.channel.id }
            : { fromMessageId: quote.id, fromBot: session.sid, fromChannelId: session.event.channel.id },
          )
        : [];

      const elements: h[] = session.event.message.elements;

      const UsernamePrefix = (): JSX.IntrinsicElements["template"] =>
        to.platform == "discord" && !quote ?
          <author name={session.username} avatar={avatar} />
        : <template>
            [{session.username}]<br />
          </template>;

      const filteredElements: h[] =
        from.platform == "onebot" && to.platform === "discord" ? await onebotRule(elements, session)
        : from.platform == "discord" && to.platform === "onebot" ? await discordRule(elements, session)
        : [];

      const QuoteElements = (): JSX.IntrinsicElements["quote"] => {
        if (quote) {
          if (isQuoteBot) {
            const quoteMessage: SentMessage | undefined = quoteMessages.find(
              (value: SentMessage): boolean =>
                value.fromBot === `${to.platform}:${to.selfId}` && value.fromChannelId === to.channelId,
            );

            if (quoteMessage) {
              return <quote id={quoteMessage.fromMessageId} />;
            }
          } else {
            const quoteMessage: SentMessage | undefined = quoteMessages.find(
              (value: SentMessage): boolean =>
                value.toBot === `${to.platform}:${to.selfId}` && value.toChannelId === to.channelId,
            );
            if (quoteMessage) {
              return <quote id={quoteMessage.toMessageId} />;
            }
          }
        } else {
          return;
        }
      };

      const PayloadElements = () => (
        <template>
          <QuoteElements />
          <UsernamePrefix />
          {filteredElements}
        </template>
      );

      try {
        const sentMessageIds: string[] = await bot.sendMessage(to.channelId, <PayloadElements />);
        // console.log(sentMessageIds);

        // if (from.platform === "onebot" && to.platform === "discord") {
        //   if (session.event.message.elements[0].type == "forward") {
        //     const forwardMessage = await session.onebot.getForwardMsg(session.event.message.elements[0].attrs.id);
        //     const forwardPayload: h[] = [];
        //     for (const message of forwardMessage) {
        //       let singleMessagePayload: h[] = [];
        //       for (const content of message.content) {
        //         let payload: h[] = [];
        //         if (content.type === "text") {
        //           payload = [h.text(content.data.text)];
        //         } else if (content.type === "image") {
        //           try {
        //             const res = await ctx.http(content.data.url, { responseType: "arraybuffer" });
        //             payload = [h.image(Buffer.from(res.data), `image/${content.data.file.split(".").pop()}`)];
        //           } catch (error) {
        //             logger.error(error);
        //             payload = [h.text("[图片]")];
        //           }
        //         } else if (content.type === "json") {
        //           let data = JSON.parse(content.data.data);
        //           if (data.app === "com.tencent.miniapp_01") {
        //             let card = data.meta.detail_1;

        //             payload = [
        //               h.text(`[卡片消息] - ${card.title}\n${card.desc}\n${card.qqdocurl}`),
        //               h.image(`${card.preview.startsWith("http") ? "" : "https://"}${card.preview}`),
        //             ];
        //           } else if (data.app === "com.tencent.structmsg") {
        //             let card = data.meta[data.view];
        //             payload = [h.text(`[卡片消息] - ${card.tag}\n${card.title}\n${card.desc}\n${card.jumpUrl}`)];
        //           }
        //         }

        //         singleMessagePayload = [...singleMessagePayload, ...payload];
        //       }
        //       forwardPayload.push(
        //         h("message", {}, [
        //           h("author", {
        //             name: message.sender.nickname,
        //             avatar: `http://q.qlogo.cn/headimg_dl?dst_uin=${message.sender.user_id}&spec=640`,
        //           }),
        //           ...singleMessagePayload,
        //         ]),
        //       );
        //     }
        //     sentMessageIds = await bot.sendMessage(to.channelId, [
        //       prefix,
        //       h("text", { content: "[合并转发]" }),
        //       h("message", { forward: true }, h("message", {}, [prefix, ...forwardPayload])),
        //     ]);
        //   }
        //   if (session.event.message.elements[0].type == "json") {
        //     sentMessageIds = await cardSimuSend(JSON.parse(session.event.message.elements[0].attrs.data));
        //   }
        // }

        const sentMessage: SentMessage[] = sentMessageIds.map(
          (msgId: string): SentMessage => ({
            fromMessageId: session.event.message.id,
            fromBot: `${session.event.platform}:${session.selfId}`,
            toMessageId: msgId,
            toBot: `${to.platform}:${to.selfId}`,
            fromChannelId: session.event.channel.id,
            toChannelId: to.channelId,
            time: new Date(),
          }),
        );

        if (sentMessage.length != 0) {
          await ctx.database.upsert("forward_sentMessage", sentMessage);
        }
      } catch (error) {
        ctx.logger.error(error);
      }

      // async function cardSimuSend(data: Record<string, unknown>, threadId?: string): Promise<string[]> {
      //   let card: Record<string, any>;
      //   let embed: Record<string, any> = [];
      //   if (data.app === "com.tencent.miniapp_01") {
      //     card = data.meta.detail_1;
      //     embed = [
      //       {
      //         title: card.desc,
      //         url: card.qqdocurl,
      //         color: 3518885, // #35B1A5
      //         image: { url: `${card.preview.startsWith("http") ? "" : "https://"}${card.preview}` },
      //         footer: { text: card.title, icon_url: card.icon },
      //       },
      //     ];
      //   } else if (data.app === "com.tencent.structmsg") {
      //     card = data.meta[data.view];
      //     embed = [
      //       {
      //         title: card.title,
      //         description: card.desc,
      //         url: card.jumpUrl,
      //         color: 3518885, // #35B1A5
      //         image: { url: card.preview },
      //         footer: { text: card.tag, icon_url: card.source_icon },
      //       },
      //     ];
      //   }

      //   let webhook: Discord.Webhook = await (bot as unknown as DiscordBot).ensureWebhook(to.channelId);
      //   let created = await bot.internal.executeWebhook(
      //     webhook.id,
      //     webhook.token,
      //     { username: session.username, avatar_url: avatar, embeds: embed },
      //     Object.assign({ wait: true }, threadId ? { threadId: threadId } : {}),
      //   );
      //   return [created.id];
      // }
    };

    ctx.platform(from.platform).self(from.selfId).channel(from.channelId).on("message-created", messageHandler);
  });

  /**
   * onebot -> discord Rule
   */
  async function onebotRule(elements: h[], session: Session<never, never, Context>): Promise<h[]> {
    return h.transformAsync(elements, {
      text: (attrs: Record<string, string>): h => <template>{attrs.content}</template>,
      file: (attrs: Record<string, string>): h => {
        if (attrs.src.split(".")[1] == "mp4") {
          return <template>[视频 - {attrs.file}]</template>;
        } else {
          return <template>[文件 - {attrs.file}]</template>;
        }
      },
      forward: async (): Promise<h> => {
        const forwardMsg: Payload[] = await session.onebot.getForwardMsg(elements[0].attrs.id);
        const ForwardElements = ({ id, content }: { id?: string; content: Payload[] }) => (
          <template>
            <message forward>
              [转发消息{id ? `- ${id}` : ""}]
              {content.map((msg: Payload): JSX.IntrinsicElements["message"] => {
                return (
                  <message>
                    <author
                      name={msg.sender.nickname}
                      avatar={`http://q.qlogo.cn/headimg_dl?dst_uin=${msg.sender.user_id}&spec=640`}
                    />
                    {Array.isArray(msg.message) ?
                      msg.message.map(({ type, data }: { type: string; data: Record<string, unknown> }) => {
                        if (type == "text") {
                          return <template>{data.text}</template>;
                        } else if (type == "image") {
                          const url: string = data.url as string;
                          return (
                            <template>
                              <img src={url} file={"image.png"} width={300} />
                            </template>
                          );
                        } else if (type == "file") {
                          return <template>[文件 - {data.url}]</template>;
                        } else if (type == "video") {
                          return <template>[视频 - {data.url}]</template>;
                        } else if (type == "forward") {
                          const forwardContent: Payload[] = data.content as Payload[];
                          return (
                            <template>
                              <message>[转发消息 - {data.id}]</message>
                              <ForwardElements id={data.id as string} content={forwardContent} />
                            </template>
                          );
                        }
                      })
                    : <template>{msg.message}</template>}
                  </message>
                );
              })}
            </message>
          </template>
        );
        return <ForwardElements content={forwardMsg} />;
      },
      audio: (attrs: Record<string, string>): h => {
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
          return <template>[语音]</template>;
        }
      },
      mface: (attrs: Record<string, string>): h => <image src={attrs.url} />,
      json: (attrs: Record<string, string>): h => {
        const data: Record<string, unknown> = JSON.parse(attrs.data);
        if (data.app === "com.tencent.miniapp_01") {
          return <template>{""}</template>;
        } else if (data.app === "com.tencent.structmsg") {
          return <template>{""}</template>;
        }
      },
      at: (attrs: Record<string, string>): h => <template>{`@${attrs.name}`}</template>,
    });
  }

  /**
   * discord -> onebot Rule
   */
  async function discordRule(elements: h[], session: Session<never, never, Context>): Promise<h[]> {
    return h.transformAsync(elements, {
      text: (attrs: Record<string, string>): h => <template>{attrs.content}</template>,
      img: async (attrs: Record<string, string>): Promise<h> => {
        try {
          const res = await ctx.http(attrs.src, { responseType: "arraybuffer" });
          return <image src={Buffer.from(res.data)} type={attrs.type} />;
        } catch (error) {
          logger.error(error);
          return <template>{attrs.content}</template>;
        }
      },
      reply: (attrs: Record<string, string>): h => {
        return <template>{`[回复 ${attrs.id}]\n`}</template>;
      },
      sticker: async (attrs: Record<string, string>, children: h[]): Promise<h> => {
        try {
          const res = await ctx.http(children[0].attrs.src, { responseType: "arraybuffer" });
          return <image src={Buffer.from(res.data)} type="image/webp" />;
        } catch (error) {
          logger.error(error);
          return <template>[贴纸 - {attrs.name}]</template>;
        }
      },
      record: async (): Promise<h> => {
        // let res = await ctx.http(attrs.src, { responseType: "arraybuffer" });
        // let converedAudio: Buffer = await ctx.ffmpeg
        //     .builder()
        //     .input(Buffer.from(res.data))
        //     .inputOption("-acodec", "libvorbis", "-acodec", "pcm_s16le")
        //     .outputOption("-f", "wav")
        //     .run("buffer");
        // let pcm = await ctx.silk.encode(converedAudio, 24000);
        // return h.audio(Buffer.from(pcm.data), "audio/amr");
        return <template>[语音]</template>;
      },
      face: async (attrs: Record<string, string>, children: h[]): Promise<h> => {
        try {
          const res = await ctx.http(children[0].attrs.src, { responseType: "arraybuffer" });
          return <image src={Buffer.from(res.data)} type="image/webp" />;
        } catch (error) {
          logger.error(error);
          return <template>[表情 - {attrs.name}]</template>;
        }
      },
      sharp: async (attrs: Record<string, string>): Promise<h> => {
        const channel: Discord.Channel = await session.discord.getChannel(attrs.id);
        return <template>#{channel.name}</template>;
      },
      at: async (attrs: Record<string, string>): Promise<h> => {
        const atUser = await session.discord.getUser(attrs.id);
        return <template>{`@${atUser.username}`}</template>;
      },
    });
  }
}
