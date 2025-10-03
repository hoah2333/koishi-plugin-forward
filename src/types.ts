import { Schema, Time } from "koishi";

export interface Config {
  platform: string;
  selfId: string;
  channelId: string;
  blockId: string[];
}

export interface Configs {
  configs: Record<string, Config>;
  rules: { from: string; to: string }[];
  delay: number;
}

export interface SentMessage {
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
          blockId: Schema.array(Schema.string().description("转发屏蔽 ID")).description("转发屏蔽列表"),
        }),
      ]).description("配置名称"),
    )
      .collapse(true)
      .description("配置列表"),
  }).description("转发配置"),
  Schema.object({
    rules: Schema.array(
      Schema.object({
        from: Schema.string().required().description("来源配置"),
        to: Schema.string().required().description("目标配置"),
      }),
    )
      .collapse(true)
      .description("规则列表"),
    delay: Schema.natural()
      .role("ms")
      .default(0.2 * Time.second)
      .description("发送间隔（默认 200 毫秒）"),
  }).description("转发规则"),
]);
