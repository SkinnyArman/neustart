export interface Button { text: string; callback_data: string }

export class Telegram {
  private token: string;
  private chatId: string;
  constructor(token: string, chatId: string) {
    this.token = token;
    this.chatId = chatId;
  }

  private async call(method: string, payload: Record<string, unknown>): Promise<any> {
    const r = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const body = (await r.text()).slice(0, 200);
      // A topic that was deleted (or a wrong id): post in General rather than lose it.
      if (payload.message_thread_id && /thread not found/i.test(body)) {
        const { message_thread_id: _, ...rest } = payload;
        return this.call(method, rest);
      }
      throw new Error(`Telegram ${method} ${r.status}: ${body}`);
    }
    return r.json();
  }

  send(text: string, opts: Record<string, unknown> = {}, chatId?: string) {
    return this.call("sendMessage", {
      chat_id: chatId ?? this.chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...opts,
    });
  }

  sendPhoto(photo: string, caption: string, chatId?: string, opts: Record<string, unknown> = {}) {
    return this.call("sendPhoto", {
      chat_id: chatId ?? this.chatId, photo, caption, parse_mode: "HTML", ...opts,
    });
  }

  sendDocument(document: string, opts: Record<string, unknown> = {}, chatId?: string) {
    return this.call("sendDocument", { chat_id: chatId ?? this.chatId, document, ...opts });
  }

  /** A file made here (a CSV…), uploaded as a document. */
  async sendFile(name: string, content: string | Uint8Array, type: string, opts: Record<string, unknown> = {}, chatId?: string) {
    const form = new FormData();
    form.append("chat_id", String(chatId ?? this.chatId));
    for (const [k, v] of Object.entries(opts)) form.append(k, typeof v === "string" ? v : JSON.stringify(v));
    form.append("document", new Blob([content], { type }), name);
    const r = await fetch(`https://api.telegram.org/bot${this.token}/sendDocument`, { method: "POST", body: form });
    if (!r.ok) throw new Error(`Telegram sendDocument ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }

  deleteMessage(messageId: number, chatId?: number | string) {
    return this.call("deleteMessage", { chat_id: chatId ?? this.chatId, message_id: messageId });
  }

  /** The menu shown when someone types "/" - per scope (a chat, one member of it, …). */
  setMyCommands(commands: { command: string; description: string }[], scope: Record<string, unknown>) {
    return this.call("setMyCommands", { commands, scope });
  }

  /** A new forum topic in the group; needs the "manage topics" admin right. */
  createForumTopic(name: string, chatId?: string) {
    return this.call("createForumTopic", { chat_id: chatId ?? this.chatId, name });
  }

  keyboard(rows: Button[][]) {
    return { reply_markup: { inline_keyboard: rows } };
  }

  answerCallback(id: string, text = "", alert = false) {
    return this.call("answerCallbackQuery", {
      callback_query_id: id, text, show_alert: alert,
    });
  }

  editText(chatId: number | string, messageId: number, text: string,
           rows?: Button[][]) {
    return this.call("editMessageText", {
      chat_id: chatId, message_id: messageId, text, parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(rows ? { reply_markup: { inline_keyboard: rows } } : {}),
    });
  }

  /** A photo's caption (editText only works on text messages). */
  editCaption(chatId: number | string, messageId: number, caption: string) {
    return this.call("editMessageCaption", { chat_id: chatId, message_id: messageId, caption, parse_mode: "HTML" });
  }

  /** The chat this bot posts to by default. */
  get chat() { return this.chatId; }

  editMarkup(chatId: number | string, messageId: number, rows: Button[][]) {
    return this.call("editMessageReplyMarkup", {
      chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows },
    });
  }

  clearKeyboard(chatId: number | string, messageId: number) {
    return this.call("editMessageReplyMarkup", {
      chat_id: chatId, message_id: messageId,
    });
  }
}

/** Post into a forum topic; nothing when there is none (plain groups, General). */
export const inTopic = (thread?: number | null): Record<string, unknown> =>
  thread ? { message_thread_id: thread } : {};

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
