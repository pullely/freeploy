// Derived from coollabsio/coolify@91b7e3e:app/Notifications/Dto/{DiscordMessage,SlackMessage,PushoverMessage}.php
// and app/Notifications/ImageScan/NotificationText.php (Apache-2.0), modified.
//
// The message objects every notification builds, and the per-channel escaping of user text. What differs
// from Coolify is only what PayloadContext carries: the product's name in messages ("Coolify" in Coolify,
// "Freeploy" here), the Discord footer, the instance URL and the clock.
import { buttonText, buttonUrl, htmlspecialcharsHtml5, mbStrlen, mbSubstr, phpRtrim, phpTrim, type Button, type PhpValue } from "./php.js";

export interface PayloadContext {
  /** base_url(): the instance's URL, links in messages start with it. */
  baseUrl: string;
  /** config('app.url'): route() links and the replacement of http://localhost in buttons. */
  appUrl: string;
  /** The product's name where Coolify's messages say "Coolify". */
  brand: string;
  /** config('app.name'): the Mattermost username, the email signature. */
  appName: string;
  /** DiscordMessage's footer: "Coolify v4.7.6" in Coolify ("Coolify Cloud" on its cloud). */
  discordFooter: string;
  /** Where ForceDisabled tells a team to pay: https://app.coolify.io/subscription in Coolify. */
  subscriptionUrl: string;
  /** now()->timestamp, for Discord's relative time field. */
  now: () => number;
}

export class DiscordMessage {
  private readonly fields: Array<{ name: string; value: string; inline: boolean }> = [];

  constructor(
    public title: string,
    public description: string,
    public color: number,
    public isCritical = false,
  ) {}

  static successColor(): number {
    return 0xa1ffa5;
  }
  static warningColor(): number {
    return 0xffa743;
  }
  static errorColor(): number {
    return 0xff705f;
  }
  static infoColor(): number {
    return 0x4f545c;
  }

  addField(name: string, value: string | null, inline = false): this {
    // PHP's string parameter: a null value is a TypeError there; no notification passes one.
    this.fields.push({ name, value: value ?? "", inline });
    return this;
  }

  toPayload(ctx: PayloadContext): { [key: string]: PhpValue } {
    const payload: { [key: string]: PhpValue } = {
      embeds: [
        {
          title: this.title,
          description: this.description,
          color: this.color,
          fields: [...this.fields, { name: "Time", value: `<t:${ctx.now()}:R>`, inline: true }],
          footer: { text: ctx.discordFooter },
        },
      ],
    };
    if (this.isCritical) payload.content = "@here";
    return payload;
  }
}

export class SlackMessage {
  constructor(
    public title: string,
    public description: string,
    public color = "#0099ff",
  ) {}

  static infoColor(): string {
    return "#0099ff";
  }
  static errorColor(): string {
    return "#ff0000";
  }
  static successColor(): string {
    return "#00ff00";
  }
  static warningColor(): string {
    return "#ffa500";
  }
}

export type PushoverLevel = "info" | "error" | "success" | "warning";

export class PushoverMessage {
  constructor(
    public title: string,
    public message: string,
    public buttons: Button[] = [],
    public level: PushoverLevel = "info",
  ) {}

  getLevelIcon(): string {
    switch (this.level) {
      case "info":
        return "ℹ️";
      case "error":
        return "❌";
      case "success":
        return "✅ ";
      case "warning":
        return "⚠️";
    }
  }

  toPayload(ctx: PayloadContext, token: string, user: string): { [key: string]: PhpValue } {
    let message = this.message;
    for (const button of this.buttons) {
      let url = buttonUrl(button);
      if (url && url.includes("http://localhost")) url = url.split("http://localhost").join(ctx.appUrl);
      message += "&nbsp;<a href='" + (url ?? "") + "'>" + buttonText(button) + "</a>";
    }
    return { token, user, title: `${this.getLevelIcon()} ${this.title}`, message, html: 1 };
  }
}

/** toTelegram(): the text and the buttons (Coolify's array, whose `buttons` key a class may leave out). */
export interface TelegramMessage {
  message: string;
  buttons?: PhpValue[];
}

/** app/Notifications/ImageScan/NotificationText.php: escapes values for each channel. */
export const NotificationText = {
  plain(value: string | null | undefined): string {
    return phpTrim((value ?? "").replace(/[\p{Cc}\p{Cf}]+/gu, " "));
  },
  /** Discord markdown. */
  discord(value: string | null | undefined): string {
    return NotificationText.plain(value).replace(/([\\*_~`|>[\]()#])/gu, "\\$1");
  },
  /** Slack mrkdwn: only &, <, and > have a meaning that escaping can stop. */
  slack(value: string | null | undefined): string {
    return NotificationText.plain(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  },
  /** Pushover with html=1. */
  html(value: string | null | undefined): string {
    return htmlspecialcharsHtml5(NotificationText.plain(value));
  },
  /** Cuts a raw value before it is escaped, so one long name cannot fill a message. */
  limit(value: string | null | undefined, max: number): string {
    const v = NotificationText.plain(value);
    return mbStrlen(v) > max ? phpRtrim(mbSubstr(v, 0, max - 1)) + "…" : v;
  },
  /** The lines that fit in budget characters, joined with new lines, then "And N more." for the rest. */
  fitLines(lines: string[], budget: number): string[] {
    const kept: string[] = [];
    let used = 0;
    const count = lines.length;
    for (let index = 0; index < count; index++) {
      const line = lines[index]!;
      const remaining = count - index - 1;
      const reserve = remaining > 0 ? mbStrlen(`\nAnd ${remaining} more.`) : 0;
      const length = mbStrlen(line) + (kept.length === 0 ? 0 : 1);
      if (used + length + reserve > budget) break;
      kept.push(line);
      used += length;
    }
    const more = count - kept.length;
    if (more > 0) kept.push(`And ${more} more.`);
    return kept;
  },
};
