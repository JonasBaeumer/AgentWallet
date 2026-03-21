import { Bot } from 'grammy';
import { env } from '@/config/env';
import { getMockBot } from './mockBot';

let _bot: Bot | null = null;

export function getTelegramBot() {
  if (env.TELEGRAM_MOCK) {
    return getMockBot();
  }
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  }
  if (!_bot) {
    _bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  }
  return _bot;
}
