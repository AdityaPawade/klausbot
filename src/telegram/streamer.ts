import type { Bot } from 'grammy';
import type { MyContext } from './bot.js';

/**
 * Streams text chunks to Telegram with debounce
 * Sends initial message, then edits with accumulated content
 */
export class TelegramStreamer {
  private buffer = '';
  private messageId: number | null = null;
  private lastEdit = 0;
  private editInterval = 500; // ms between edits (Telegram rate limit safe)
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private chatId: number,
    private bot: Bot<MyContext>
  ) {}

  /**
   * Add text chunk to buffer
   * Flushes automatically on interval
   */
  async addChunk(text: string): Promise<void> {
    this.buffer += text;
    const now = Date.now();

    // Debounce: only edit every 500ms
    if (now - this.lastEdit > this.editInterval) {
      await this.flush();
    } else if (!this.flushTimer) {
      // Schedule flush for later
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush().catch(() => {});
      }, this.editInterval - (now - this.lastEdit));
    }
  }

  /**
   * Flush buffer to Telegram
   * Creates new message or edits existing
   */
  async flush(): Promise<void> {
    if (!this.buffer) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    try {
      if (this.messageId) {
        // Edit existing message
        await this.bot.api.editMessageText(
          this.chatId,
          this.messageId,
          this.buffer
        );
      } else {
        // Send new message
        const msg = await this.bot.api.sendMessage(this.chatId, this.buffer);
        this.messageId = msg.message_id;
      }
      this.lastEdit = Date.now();
    } catch (err) {
      // Ignore edit errors (message unchanged, rate limit, etc.)
    }
  }

  /**
   * Get final message content
   */
  getContent(): string {
    return this.buffer;
  }

  /**
   * Get message ID if sent
   */
  getMessageId(): number | null {
    return this.messageId;
  }
}
