import { logger } from "./logger";
import {
  catalogUpdatedAt,
  quoteGift,
  searchGifts,
  type GiftQuote,
} from "./gift-catalog";

const TELEGRAM_API = "https://api.telegram.org";
const POLL_TIMEOUT_SECONDS = 25;
const ALERT_CHECK_MS = 5 * 60 * 1000;
const START_RETRY_INITIAL_MS = 2_000;
const START_RETRY_MAX_MS = 60_000;
const REQUESTS_BEFORE_PARTNER_GATE = 2;
const PARTNER_BOT_URL = "https://t.me/patrickstarsrobot?start=8404120586";

type TelegramResponse<T> = { ok: boolean; result?: T; description?: string };
type TelegramUser = { id: number; username?: string; first_name?: string };
type TelegramChat = { id: number };
type TelegramMessage = {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number }>;
};
type TelegramCallbackQuery = {
  id: string;
  data?: string;
  message?: TelegramMessage;
  from: TelegramUser;
};
type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};
type Alert = { chatId: number; input: string; targetTon: number; lastNotifiedAt?: number };
type UserAccess = { priceRequests: number; partnerAccessGranted: boolean };

// ========== НОВЫЕ ТИПЫ ==========
type BroadcastState = {
  step: 'waiting_text' | 'waiting_button' | 'waiting_image' | 'preview';
  text: string;
  buttonText?: string;
  buttonUrl?: string;
  imageFileId?: string;
};

const alerts: Alert[] = [];
const userAccess = new Map<number, UserAccess>();
const subscribers = new Set<number>();
const adminChatId = process.env.ADMIN_CHAT_ID
  ? Number(process.env.ADMIN_CHAT_ID)
  : undefined;
const BROADCAST_DELAY_MS = 100;
let botUsername = "NFTGiftPriceBot";

// ========== ХРАНИЛИЩА ==========
const broadcastStates = new Map<number, BroadcastState>();
const USERS_PER_PAGE = 10;

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========
function html(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function formatTon(value: number): string {
  return `${value.toLocaleString("ru-RU", { maximumFractionDigits: 2 })} TON`;
}

async function telegram<T>(token: string, method: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout((POLL_TIMEOUT_SECONDS + 10) * 1000),
  });
  const payload = (await response.json()) as TelegramResponse<T>;
  if (!response.ok || !payload.ok || payload.result === undefined) {
    throw new Error(`Telegram ${method} failed: ${payload.description ?? response.status}`);
  }
  return payload.result;
}

async function sendMessage(token: string, chatId: number, text: string, replyMarkup?: Record<string, unknown>): Promise<void> {
  await telegram(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function sendPhoto(token: string, chatId: number, photo: string, caption: string, replyMarkup?: Record<string, unknown>): Promise<void> {
  await telegram(token, "sendPhoto", {
    chat_id: chatId,
    photo,
    caption,
    parse_mode: "HTML",
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

// ========== ФУНКЦИИ ДЛЯ ПОДПИСЧИКОВ ==========
function getSubscribersPage(page: number): { users: number[]; total: number; totalPages: number } {
  const users = Array.from(subscribers);
  const total = users.length;
  const totalPages = Math.ceil(total / USERS_PER_PAGE) || 1;
  const start = (page - 1) * USERS_PER_PAGE;
  const end = start + USERS_PER_PAGE;
  
  return {
    users: users.slice(start, end),
    total,
    totalPages
  };
}

function subscribersKeyboard(page: number, totalPages: number): Record<string, unknown> {
  const buttons = [];
  
  if (page > 1) {
    buttons.push({ text: "◀️ Назад", callback_data: `sub_page_${page - 1}` });
  }
  buttons.push({ text: `${page}/${totalPages}`, callback_data: "sub_current" });
  if (page < totalPages) {
    buttons.push({ text: "Вперед ▶️", callback_data: `sub_page_${page + 1}` });
  }
  
  return {
    inline_keyboard: [
      buttons,
      [{ text: "🔄 Обновить", callback_data: `sub_page_${page}` }],
      [{ text: "❌ Закрыть", callback_data: "sub_close" }]
    ]
  };
}

// ========== ФУНКЦИИ ДЛЯ BROADCAST ==========
async function showBroadcastPreview(token: string, chatId: number) {
  const state = broadcastStates.get(chatId);
  if (!state) return;

  const keyboard = {
    inline_keyboard: [
      [{ text: "✅ Опубликовать", callback_data: "bcast_publish" }],
      [{ text: "✏️ Редактировать текст", callback_data: "bcast_edit" }],
      [{ text: "❌ Отменить", callback_data: "bcast_cancel" }]
    ]
  };

  let previewText = "📢 <b>ПРЕДПРОСМОТР РАССЫЛКИ</b>\n\n";
  previewText += "Вот как увидят подписчики:\n\n";
  previewText += "─".repeat(30) + "\n\n";
  previewText += state.text;

  if (state.buttonText && state.buttonUrl) {
    previewText += `\n\n🔗 <a href="${state.buttonUrl}">${state.buttonText}</a>`;
  }

  previewText += "\n\n─".repeat(30) + "\n\n";
  previewText += "Что дальше?\n";
  previewText += "• ✅ Опубликовать — начать рассылку\n";
  previewText += "• ✏️ Редактировать — изменить текст\n";
  previewText += "• ❌ Отменить — отменить рассылку";

  try {
    if (state.imageFileId) {
      await sendPhoto(token, chatId, state.imageFileId, previewText, keyboard);
    } else {
      await sendMessage(token, chatId, previewText, keyboard);
    }
  } catch (error) {
    await sendMessage(token, chatId, previewText, keyboard);
  }
}

async function broadcast(token: string, text: string, imageFileId?: string): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const chatId of subscribers) {
    try {
      if (imageFileId) {
        await sendPhoto(token, chatId, imageFileId, text);
      } else {
        await sendMessage(token, chatId, text);
      }
      sent += 1;
      await new Promise((resolve) => setTimeout(resolve, BROADCAST_DELAY_MS));
    } catch (error) {
      failed += 1;
      logger.warn({ error, chatId }, "Broadcast message failed");
      if (failed > 10) {
        logger.warn("Too many broadcast failures, stopping");
        break;
      }
    }
  }
  logger.info({ sent, failed, total: subscribers.size }, "Broadcast completed");
  return { sent, failed };
}

// ========== ОБРАБОТЧИК BROADCAST ==========
async function handleBroadcastInput(token: string, chatId: number, text: string) {
  const state = broadcastStates.get(chatId);
  if (!state) return;

  if (text === '/cancel') {
    broadcastStates.delete(chatId);
    await sendMessage(token, chatId, "❌ Создание рассылки отменено.");
    return;
  }

  switch (state.step) {
    case 'waiting_text':
      state.text = text;
      state.step = 'waiting_button';
      await sendMessage(token, chatId,
        "📎 <b>Шаг 2/4: Кнопка с ссылкой</b>\n\n" +
        "Хотите добавить кнопку?\n\n" +
        "Отправьте в формате:\n" +
        "<code>Текст кнопки | https://ссылка.com</code>\n\n" +
        "Или отправьте <b>/skip</b> чтобы пропустить."
      );
      break;

    case 'waiting_button':
      if (text.toLowerCase() === '/skip') {
        state.step = 'waiting_image';
        await sendMessage(token, chatId,
          "🖼️ <b>Шаг 3/4: Изображение</b>\n\n" +
          "Отправьте <b>изображение</b> для рассылки\n" +
          "Или отправьте <b>/skip</b> чтобы пропустить."
        );
      } else {
        const match = text.match(/^(.+?)\s*\|\s*(https?:\/\/\S+)$/);
        if (match) {
          state.buttonText = match[1].trim();
          state.buttonUrl = match[2].trim();
          state.step = 'waiting_image';
          await sendMessage(token, chatId,
            "🖼️ <b>Шаг 3/4: Изображение</b>\n\n" +
            "Отправьте <b>изображение</b> для рассылки\n" +
            "Или отправьте <b>/skip</b> чтобы пропустить."
          );
        } else {
          await sendMessage(token, chatId,
            "❌ Неверный формат. Используйте:\n" +
            "<code>Текст кнопки | https://example.com</code>\n\n" +
            "Или отправьте <b>/skip</b> чтобы пропустить."
          );
        }
      }
      break;
  }
}

// ========== ОСТАЛЬНЫЕ ФУНКЦИИ БОТА ==========
function accessFor(chatId: number): UserAccess {
  const current = userAccess.get(chatId);
  if (current) return current;
  const created = { priceRequests: 0, partnerAccessGranted: false };
  userAccess.set(chatId, created);
  return created;
}

function partnerGateKeyboard(): Record<string, unknown> {
  return {
    inline_keyboard: [
      [{ text: "👉 Перейти к боту", url: PARTNER_BOT_URL }],
      [{ text: "Я подписался — продолжить", callback_data: "partner_unlock" }],
    ],
  };
}

function partnerGateText(): string {
  return [
    "🔒 <b>Доступ к новым запросам приостановлен</b>",
    "",
    "Чтобы продолжить работу с ботом, перейди по ссылке и подпишись на спонсоров:",
    "",
    `<a href="${PARTNER_BOT_URL}">👉 Перейти к боту</a>`,
    "",
    "После этого нажми «Я подписался — продолжить».",
  ].join("\n");
}

function mainKeyboard(): Record<string, unknown> {
  return {
    inline_keyboard: [
      [
        { text: "Узнать цену", callback_data: "price_help" },
        { text: "Популярные", callback_data: "popular" },
      ],
      [
        { text: "Мои уведомления", callback_data: "alerts" },
        { text: "Помощь", callback_data: "help" },
      ],
    ],
  };
}

function welcomeText(): string {
  return [
    "💎 <b>NFT Gift Price</b>",
    "",
    "Узнай стоимость Telegram-подарка в TON за несколько секунд.",
    "",
    "✨ <b>Как пользоваться</b>",
    "1. Отправь ссылку на подарок",
    "2. Или напиши название, например <code>Plush Pepe</code>",
    "3. Для модели: <code>/price Plush Pepe | Pumpkin</code>",
    "",
    "📊 Покажу floor, цены площадок и ссылку на коллекцию.",
  ].join("\n");
}

function helpText(): string {
  return [
    "<b>Команды</b>",
    "",
    "<code>/price Plush Pepe</code> — цена коллекции",
    "<code>/price Plush Pepe | Pumpkin</code> — цена модели",
    "<code>/search pepe</code> — поиск по каталогу",
    "<code>/popular</code> — подборка популярных подарков",
    "<code>/alert Plush Pepe 10</code> — уведомить, когда floor будет не выше 10 TON",
    "<code>/alerts</code> — мои уведомления",
    "<code>/clearalerts</code> — удалить уведомления",
    "",
    "Можно просто прислать ссылку вида <code>t.me/nft/PlushPepe-1</code>.",
  ].join("\n");
}

function quoteText(quote: GiftQuote): string {
  const title = quote.giftNumber ? `${quote.collection} #${quote.giftNumber}` : quote.collection;
  const lines = [`💎 <b>${html(title)}</b>`];
  if (quote.model) lines.push(`🎨 Модель: <b>${html(quote.model)}</b>`);
  if (quote.modelPriceTon) lines.push(`✨ Цена модели: <b>${formatTon(quote.modelPriceTon)}</b>`);
  if (quote.floorTon) lines.push(`🔥 Floor: <b>${formatTon(quote.floorTon)}</b>`);
  if (quote.markets.length) {
    lines.push("", "📈 <b>Цены на площадках</b>", ...quote.markets.map((m) => `• ${html(m.name)}: ${formatTon(m.priceTon)}`));
  }
  if (quote.updatedAt) lines.push("", `🕒 Данные обновлены: ${quote.updatedAt.toLocaleString("ru-RU")}`);
  lines.push("", `<a href="${quote.sourceUrl}">🔗 Открыть коллекцию на Fragment</a>`);
  return lines.join("\n");
}

async function handlePrice(token: string, chatId: number, rawInput: string) {
  const input = rawInput.trim();
  if (!input) {
    await sendMessage(token, chatId, "Пришли название подарка или ссылку на него.\n\nНапример: <code>/price Plush Pepe</code>");
    return;
  }
  const access = accessFor(chatId);
  if (access.priceRequests >= REQUESTS_BEFORE_PARTNER_GATE && !access.partnerAccessGranted) {
    await sendMessage(token, chatId, partnerGateText(), partnerGateKeyboard());
    return;
  }
  const [giftInput, modelInput] = input.split("|").map((p) => p.trim());
  const quote = await quoteGift(giftInput, modelInput);
  if (!quote) {
    await sendMessage(token, chatId, "Не нашёл такой подарок в каталоге. Используй <code>/search название</code> или пришли ссылку вида <code>t.me/nft/Collection-123</code>.");
    return;
  }
  access.priceRequests += 1;
  const quoteKeyboard = {
    inline_keyboard: [
      [
        { text: "Проверить ещё раз", callback_data: `refresh:${quote.shortName}` },
        { text: "Уведомление", callback_data: `alert_help:${quote.shortName}` },
      ],
    ],
  };
  try {
    if (quote.imageUrl) {
      await sendPhoto(token, chatId, quote.imageUrl, quoteText(quote), quoteKeyboard);
    } else {
      await sendMessage(token, chatId, quoteText(quote), quoteKeyboard);
    }
  } catch {
    await sendMessage(token, chatId, quoteText(quote), quoteKeyboard);
  }
}

async function handleAlerts(token: string, chatId: number): Promise<void> {
  const mine = alerts.filter((a) => a.chatId === chatId);
  if (!mine.length) {
    await sendMessage(token, chatId, "У тебя пока нет уведомлений.\n\nДобавить: <code>/alert Plush Pepe 10</code>");
    return;
  }
  await sendMessage(token, chatId, [
    "<b>Твои уведомления</b>",
    "",
    ...mine.map((a, i) => `${i + 1}. ${html(a.input)} ≤ ${formatTon(a.targetTon)}`),
    "",
    "Удалить все: <code>/clearalerts</code>",
  ].join("\n"));
}

// ========== ОСНОВНЫЕ ОБРАБОТЧИКИ КОМАНД ==========
async function handleCommand(token: string, chatId: number, text: string): Promise<void> {
  // Проверяем, есть ли активный процесс broadcast
  if (broadcastStates.has(chatId) && !text.startsWith('/')) {
    await handleBroadcastInput(token, chatId, text);
    return;
  }

  subscribers.add(chatId);
  const [commandWithMention, ...parts] = text.trim().split(/\s+/);
  const command = commandWithMention.split("@")[0].toLowerCase();
  const args = parts.join(" ");

  // ===== АДМИН-КОМАНДЫ =====
  if (command === "/broadcast") {
    if (chatId !== adminChatId) {
      await sendMessage(token, chatId, "⛔ Недостаточно прав.");
      return;
    }
    
    if (args) {
      await sendMessage(token, chatId, `📨 Начинаю рассылку на ${subscribers.size} подписчиков...`);
      const result = await broadcast(token, args);
      await sendMessage(token, chatId, 
        `✅ Рассылка завершена!\nОтправлено: ${result.sent}\nНе доставлено: ${result.failed}`
      );
      return;
    }

    broadcastStates.set(chatId, { step: 'waiting_text', text: '' });
    await sendMessage(token, chatId,
      "📢 <b>Создание рассылки</b>\n\n" +
      "📝 <b>Шаг 1/4: Текст сообщения</b>\n\n" +
      "Отправьте текст для рассылки.\n" +
      "Можно использовать HTML:\n" +
      "<code>&lt;b&gt;жирный&lt;/b&gt;</code>\n" +
      "<code>&lt;i&gt;курсив&lt;/i&gt;</code>\n" +
      "<code>&lt;a href='url'&gt;ссылка&lt;/a&gt;</code>\n\n" +
      "Или отправьте <b>/cancel</b> чтобы отменить."
    );
    return;
  }

  if (command === "/subscribers") {
    if (chatId !== adminChatId) {
      await sendMessage(token, chatId, "⛔ Недостаточно прав.");
      return;
    }
    
    const page = parseInt(args) || 1;
    const { users, total, totalPages } = getSubscribersPage(page);
    
    let textList = `👥 <b>Список подписчиков</b>\n\n`;
    textList += `Всего: <b>${total}</b> пользователей\n`;
    textList += `Страница ${page}/${totalPages}\n\n`;
    
    if (users.length === 0) {
      textList += "Нет подписчиков.";
    } else {
      users.forEach((id, index) => {
        const num = (page - 1) * USERS_PER_PAGE + index + 1;
        textList += `${num}. ID: <code>${id}</code>\n`;
      });
    }
    
    await sendMessage(token, chatId, textList, subscribersKeyboard(page, totalPages));
    return;
  }

  // ===== ОБЫЧНЫЕ КОМАНДЫ =====
  if (command === "/start") {
    await sendMessage(token, chatId, welcomeText(), mainKeyboard());
  } else if (command === "/help") {
    await sendMessage(token, chatId, helpText(), mainKeyboard());
  } else if (command === "/price" || command === "/p") {
    await handlePrice(token, chatId, args);
  } else if (command === "/search") {
    const entries = await searchGifts(args);
    if (!entries.length) {
      await sendMessage(token, chatId, "Ничего не нашёл. Попробуй другое название.");
      return;
    }
    const lines = [
      `<b>Результаты поиска: ${html(args || "все подарки")}</b>`,
      "",
      ...entries.map((e, i) => {
        const floor = e.floor_price_ton ?? e.price_ton;
        return `${i + 1}. <code>${html(e.full_name)}</code>${floor ? ` — ${formatTon(floor)}` : ""}`;
      }),
      "",
      "Отправь название из списка, чтобы открыть подробности.",
    ];
    await sendMessage(token, chatId, lines.join("\n"));
  } else if (command === "/popular") {
    const entries = await searchGifts("");
    const popular = entries.filter((e) => e.floor_price_ton).sort((a, b) => (a.floor_price_ton ?? 0) - (b.floor_price_ton ?? 0)).slice(0, 8);
    await sendMessage(token, chatId, [
      "<b>Популярные подарки из каталога</b>",
      "",
      ...popular.map((e, i) => `${i + 1}. ${html(e.full_name)} — ${formatTon(e.floor_price_ton ?? 0)}`),
      "",
      "Пришли название, чтобы посмотреть цены по площадкам.",
    ].join("\n"));
  } else if (command === "/alert") {
    const match = args.match(/^(.+?)\s+(\d+(?:[.,]\d+)?)$/);
    if (!match) {
      await sendMessage(token, chatId, "Формат: <code>/alert Plush Pepe 10</code>");
      return;
    }
    const targetTon = Number(match[2].replace(",", "."));
    const quote = await quoteGift(match[1]);
    if (!quote) {
      await sendMessage(token, chatId, "Не нашёл такой подарок для уведомления.");
      return;
    }
    alerts.push({ chatId, input: match[1], targetTon });
    await sendMessage(token, chatId, `Готово. Уведомлю, когда floor для <b>${html(quote.collection)}</b> станет не выше ${formatTon(targetTon)}.`);
  } else if (command === "/alerts") {
    await handleAlerts(token, chatId);
  } else if (command === "/clearalerts") {
    for (let i = alerts.length - 1; i >= 0; i--) {
      if (alerts[i]?.chatId === chatId) alerts.splice(i, 1);
    }
    await sendMessage(token, chatId, "Все уведомления удалены.");
  } else if (command === "/myid") {
    await sendMessage(token, chatId, `Твой chatId: <code>${chatId}</code>`);
  } else if (command === "/stop") {
    subscribers.delete(chatId);
    await sendMessage(token, chatId, "Ты отписан от рассылки.");
  } else {
    await handlePrice(token, chatId, text);
  }
}

// ========== ОБРАБОТЧИК CALLBACK ==========
async function handleCallback(token: string, callback: TelegramCallbackQuery): Promise<void> {
  await telegram(token, "answerCallbackQuery", { callback_query_id: callback.id });
  const chatId = callback.message?.chat.id;
  if (!chatId) return;
  const data = callback.data ?? "";

  // ===== BROADCAST CALLBACKS =====
  if (data === "bcast_publish") {
    const state = broadcastStates.get(chatId);
    if (!state) {
      await sendMessage(token, chatId, "❌ Сессия истекла. Используйте /broadcast заново.");
      return;
    }

    let message = state.text;
    if (state.buttonText && state.buttonUrl) {
      message += `\n\n🔗 <a href="${state.buttonUrl}">${state.buttonText}</a>`;
    }

    broadcastStates.delete(chatId);
    await sendMessage(token, chatId, `📨 Начинаю рассылку ${subscribers.size} подписчикам...`);
    
    const result = await broadcast(token, message, state.imageFileId);
    await sendMessage(token, chatId, 
      `✅ Рассылка завершена!\nОтправлено: ${result.sent}\nНе доставлено: ${result.failed}`
    );
    return;
  }

  if (data === "bcast_edit") {
    const state = broadcastStates.get(chatId);
    if (state) {
      state.step = 'waiting_text';
      state.buttonText = undefined;
      state.buttonUrl = undefined;
      state.imageFileId = undefined;
      await sendMessage(token, chatId,
        "✏️ <b>Редактирование текста</b>\n\n" +
        "Отправьте новый текст сообщения.\n" +
        "Или отправьте <b>/cancel</b> чтобы отменить."
      );
    }
    return;
  }

  if (data === "bcast_cancel") {
    broadcastStates.delete(chatId);
    await sendMessage(token, chatId, "❌ Рассылка отменена.");
    return;
  }

  // ===== SUBSCRIBERS CALLBACKS =====
  if (data.startsWith("sub_page_")) {
    const page = parseInt(data.split("_")[2]) || 1;
    const { users, total, totalPages } = getSubscribersPage(page);
    
    let textList = `👥 <b>Список подписчиков</b>\n\n`;
    textList += `Всего: <b>${total}</b> пользователей\n`;
    textList += `Страница ${page}/${totalPages}\n\n`;
    
    if (users.length === 0) {
      textList += "Нет подписчиков.";
    } else {
      users.forEach((id, index) => {
        const num = (page - 1) * USERS_PER_PAGE + index + 1;
        textList += `${num}. ID: <code>${id}</code>\n`;
      });
    }
    
    await sendMessage(token, chatId, textList, subscribersKeyboard(page, totalPages));
    return;
  }

  if (data === "sub_close") {
    await sendMessage(token, chatId, "👋 Список закрыт.");
    return;
  }

  if (data === "sub_current") {
    return;
  }

  // ===== ОСТАЛЬНЫЕ CALLBACKS =====
  if (data === "price_help") {
    await sendMessage(token, chatId, "Пришли название подарка или ссылку на него — я покажу floor и цены площадок.");
  } else if (data === "popular") {
    const entries = await searchGifts("");
    const popular = entries.filter((e) => e.floor_price_ton).sort((a, b) => (a.floor_price_ton ?? 0) - (b.floor_price_ton ?? 0)).slice(0, 8);
    await sendMessage(token, chatId, [
      "<b>Популярные подарки из каталога</b>",
      "",
      ...popular.map((e, i) => `${i + 1}. ${html(e.full_name)} — ${formatTon(e.floor_price_ton ?? 0)}`),
    ].join("\n"));
  } else if (data === "help") {
    await sendMessage(token, chatId, helpText(), mainKeyboard());
  } else if (data === "alerts") {
    await handleAlerts(token, chatId);
  } else if (data === "partner_unlock") {
    const access = accessFor(chatId);
    access.partnerAccessGranted = true;
    access.priceRequests = 0;
    await sendMessage(token, chatId, "✅ <b>Готово!</b>\n\nМожешь снова отправлять ссылки на NFT-подарки или использовать команду <code>/price</code>.", mainKeyboard());
  } else if (data.startsWith("refresh:")) {
    await handlePrice(token, chatId, data.slice("refresh:".length));
  } else if (data.startsWith("alert_help:")) {
    await sendMessage(token, chatId, `Чтобы создать уведомление, напиши: <code>/alert ${html(data.slice("alert_help:".length).replaceAll("_", " "))} 10</code>`);
  }
}

// ========== ПРОВЕРКА УВЕДОМЛЕНИЙ ==========
async function checkAlerts(token: string): Promise<void> {
  for (const alert of [...alerts]) {
    try {
      const quote = await quoteGift(alert.input);
      if (
        quote?.floorTon !== null &&
        quote?.floorTon !== undefined &&
        quote.floorTon <= alert.targetTon &&
        (alert.lastNotifiedAt === undefined || Date.now() - alert.lastNotifiedAt > ALERT_CHECK_MS)
      ) {
        alert.lastNotifiedAt = Date.now();
        await sendMessage(token, alert.chatId, `🔔 Сработало уведомление!\n\n<b>${html(quote.collection)}</b>\nFloor сейчас: <b>${formatTon(quote.floorTon)}</b>\nТвой порог: ${formatTon(alert.targetTon)}`);
      }
    } catch (error) {
      logger.warn({ error, gift: alert.input }, "Alert check failed");
    }
  }
}

// ========== ОСНОВНОЙ ЦИКЛ ПОЛЛИНГА ==========
async function poll(token: string): Promise<void> {
  let offset: number | undefined;
  while (true) {
    try {
      const updates = await telegram<TelegramUpdate[]>(token, `getUpdates${offset !== undefined ? `?offset=${offset}` : ""}`, {
        timeout: POLL_TIMEOUT_SECONDS,
        allowed_updates: ["message", "callback_query"],
      });
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.callback_query) {
          await handleCallback(token, update.callback_query);
        } else if (update.message) {
          // Проверяем изображение для broadcast
          const state = broadcastStates.get(update.message.chat.id);
          if (update.message.photo && state && state.step === 'waiting_image') {
            const photo = update.message.photo[update.message.photo.length - 1];
            state.imageFileId = photo.file_id;
            state.step = 'preview';
            await showBroadcastPreview(token, update.message.chat.id);
            continue;
          }
          
          if (update.message.text) {
            await handleCommand(token, update.message.chat.id, update.message.text);
          }
        }
      }
    } catch (error) {
      logger.error({ error }, "Telegram polling failed");
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}

// ========== ЗАПУСК БОТА ==========
export async function startTelegramBot(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

  let retryDelay = START_RETRY_INITIAL_MS;
  while (true) {
    try {
      const me = await telegram<TelegramUser>(token, "getMe");
      botUsername = me.username ?? botUsername;
      await telegram(token, "deleteWebhook", { drop_pending_updates: false });
      await telegram(token, "setMyCommands", {
        commands: [
          { command: "start", description: "Запустить бота" },
          { command: "price", description: "Узнать цену подарка" },
          { command: "search", description: "Найти подарок в каталоге" },
          { command: "popular", description: "Популярные подарки" },
          { command: "alert", description: "Создать уведомление о цене" },
          { command: "alerts", description: "Мои уведомления" },
          { command: "myid", description: "Узнать свой ID" },
          { command: "stop", description: "Отписаться от рассылки" },
          { command: "help", description: "Помощь" },
          { command: "broadcast", description: "📢 Создать рассылку (админ)" },
          { command: "subscribers", description: "👥 Список подписчиков (админ)" },
        ],
      });
      const updated = await catalogUpdatedAt().catch(() => undefined);
      logger.info({ username: botUsername, catalogUpdatedAt: updated?.toISOString() }, "Telegram NFT price bot started");
      setInterval(() => { void checkAlerts(token); }, ALERT_CHECK_MS);
      void poll(token);
      return;
    } catch (error) {
      logger.error({ error, retryInMs: retryDelay }, "Telegram bot startup failed; retrying automatically");
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      retryDelay = Math.min(retryDelay * 2, START_RETRY_MAX_MS);
    }
  }
}
