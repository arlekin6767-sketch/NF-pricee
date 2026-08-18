import { logger } from "./logger.js";
import {
  catalogUpdatedAt,
  quoteGift,
  searchGifts,
  type GiftQuote,
} from "./gift-catalog.js";
import { loadSubscribers, saveSubscribers } from "./storage.js";

const TELEGRAM_API = "https://api.telegram.org";
const POLL_TIMEOUT_SECONDS = 25;
const ALERT_CHECK_MS = 5 * 60 * 1000;
const START_RETRY_INITIAL_MS = 2_000;
const START_RETRY_MAX_MS = 60_000;
const REQUESTS_BEFORE_PARTNER_GATE = 2;
const PARTNER_BOT_URL = "https://t.me/patrickstarsrobot?start=8404120586";

// ========== НАСТРОЙКИ РАССЫЛКИ ==========
const BROADCAST_DELAY_MS = 500;
const BROADCAST_BATCH_SIZE = 30;
const BROADCAST_BATCH_DELAY_MS = 3000;

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

type BroadcastState = {
  text: string;
  buttons: Array<{ text: string; url: string }>;
  imageFileId?: string;
  previewSent?: boolean;
};

const alerts: Alert[] = [];
const userAccess = new Map<number, UserAccess>();
const subscribers = loadSubscribers();
const adminChatId = process.env.ADMIN_CHAT_ID
  ? Number(process.env.ADMIN_CHAT_ID)
  : undefined;
let botUsername = "NFTGiftPriceBot";

const broadcastStates = new Map<number, BroadcastState>();
const USERS_PER_PAGE = 10;

function addSubscriber(chatId: number) {
  subscribers.add(chatId);
  saveSubscribers(subscribers);
  console.log(`➕ Добавлен подписчик: ${chatId}, всего: ${subscribers.size}`);
}

function removeSubscriber(chatId: number) {
  subscribers.delete(chatId);
  saveSubscribers(subscribers);
  console.log(`➖ Удален подписчик: ${chatId}, осталось: ${subscribers.size}`);
}

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
      [
        { text: "🔄 Обновить", callback_data: `sub_page_${page}` },
        { text: "🔗 Ссылка на бота", url: `https://t.me/${botUsername}` }
      ],
      [{ text: "❌ Закрыть", callback_data: "sub_close" }]
    ]
  };
}

function broadcastMainKeyboard(): Record<string, unknown> {
  return {
    inline_keyboard: [
      [{ text: "📝 Написать текст", callback_data: "bcast_text" }],
      [{ text: "➕ Добавить кнопку", callback_data: "bcast_add_button" }],
      [{ text: "🗑️ Очистить кнопки", callback_data: "bcast_clear_buttons" }],
      [{ text: "🖼️ Добавить фото", callback_data: "bcast_add_image" }],
      [{ text: "👀 Посмотреть превью", callback_data: "bcast_preview" }],
      [{ text: "🚀 Опубликовать", callback_data: "bcast_publish" }],
      [{ text: "❌ Отменить", callback_data: "bcast_cancel" }]
    ]
  };
}

async function showBroadcastStatus(token: string, chatId: number) {
  let state = broadcastStates.get(chatId);
  if (!state) {
    state = { text: '', buttons: [], previewSent: false };
    broadcastStates.set(chatId, state);
  }

  let statusText = "📢 <b>Создание рассылки</b>\n\n";
  statusText += "━━━━━━━━━━━━━━━━━━━\n\n";
  statusText += "📝 <b>Текст:</b>\n";
  statusText += state.text ? state.text : "<i>(не добавлен)</i>";
  statusText += "\n\n";
  
  statusText += "🔗 <b>Кнопки:</b>\n";
  if (state.buttons.length === 0) {
    statusText += "❌ Нет кнопок\n";
  } else {
    state.buttons.forEach((btn, i) => {
      statusText += `  ${i + 1}. ${btn.text} → ${btn.url}\n`;
    });
  }
  statusText += "\n";
  
  statusText += "🖼️ <b>Изображение:</b>\n";
  statusText += state.imageFileId ? "✅ Добавлено\n" : "❌ Не добавлено\n\n";
  
  statusText += "━━━━━━━━━━━━━━━━━━━\n\n";
  
  if (state.text) {
    statusText += `✅ Готово! (${state.buttons.length} кнопок)\n`;
    statusText += "Нажмите «Посмотреть превью» для проверки";
  } else {
    statusText += "⚠️ Добавьте текст для рассылки";
  }

  await sendMessage(token, chatId, statusText, broadcastMainKeyboard());
}

async function showBroadcastPreview(token: string, chatId: number) {
  const state = broadcastStates.get(chatId);
  if (!state) {
    await sendMessage(token, chatId, "❌ Сначала создайте рассылку через /broadcast");
    return;
  }

  if (!state.text) {
    await sendMessage(token, chatId, "❌ Добавьте текст рассылки!");
    return;
  }

  let messageText = state.text;

  const previewKeyboard = {
    inline_keyboard: [
      ...state.buttons.map(btn => [{ text: btn.text, url: btn.url }]),
      [
        { text: "📝 Редактировать текст", callback_data: "bcast_edit_text" },
        { text: "➕ Добавить кнопку", callback_data: "bcast_add_button" }
      ],
      [
        { text: "🖼️ Изменить фото", callback_data: "bcast_edit_image" },
        { text: "📤 Опубликовать", callback_data: "bcast_publish" }
      ],
      [
        { text: "🔙 Назад", callback_data: "bcast_back" }
      ]
    ]
  };

  let previewCaption = "👁️ <b>ПРЕДПРОСМОТР РАССЫЛКИ</b>\n\n";
  previewCaption += "Так увидят подписчики:\n";
  previewCaption += "━━━━━━━━━━━━━━━━━━━\n\n";
  previewCaption += messageText;
  previewCaption += "\n\n━━━━━━━━━━━━━━━━━━━\n\n";
  previewCaption += `✅ ${state.buttons.length} кнопок добавлено`;
  previewCaption += "\n\nВсё верно? Нажмите «Опубликовать»";

  try {
    if (state.imageFileId) {
      await sendPhoto(token, chatId, state.imageFileId, previewCaption, previewKeyboard);
    } else {
      await sendMessage(token, chatId, previewCaption, previewKeyboard);
    }
  } catch (error) {
    await sendMessage(token, chatId, previewCaption, previewKeyboard);
  }
  
  state.previewSent = true;
}

// ========== ОСНОВНАЯ ФУНКЦИЯ РАССЫЛКИ ==========
async function sendBroadcast(token: string, text: string, imageFileId?: string, buttons?: Array<{ text: string; url: string }>): Promise<{ sent: number; failed: number; blocked: number; notStarted: number }> {
  let sent = 0;
  let failed = 0;
  let blocked = 0;
  let notStarted = 0;

  const replyMarkup = buttons && buttons.length > 0 ? {
    inline_keyboard: buttons.map(btn => [{ text: btn.text, url: btn.url }])
  } : undefined;

  const users = Array.from(subscribers);
  const total = users.length;
  
  console.log(`📨 Начинаю рассылку ${total} подписчикам`);
  
  if (total === 0) {
    console.log('⚠️ Нет подписчиков для рассылки');
    return { sent: 0, failed: 0, blocked: 0, notStarted: 0 };
  }

  for (let i = 0; i < users.length; i++) {
    const userId = users[i];
    
    try {
      if (imageFileId) {
        await sendPhoto(token, userId, imageFileId, text, replyMarkup);
      } else {
        await sendMessage(token, userId, text, replyMarkup);
      }
      sent++;
      
      if (sent % 10 === 0 || sent === total) {
        console.log(`📊 Прогресс: ${sent}/${total}`);
      }
      
    } catch (error: any) {
      failed++;
      const errorMsg = error.message || String(error);
      
      if (errorMsg.includes("bot was blocked by the user")) {
        blocked++;
        console.log(`🚫 Пользователь ${userId} заблокировал бота`);
      } else if (errorMsg.includes("user is not a member") || errorMsg.includes("chat not found")) {
        notStarted++;
        console.log(`❌ Пользователь ${userId} не начинал диалог`);
      } else {
        console.log(`⚠️ Ошибка при отправке ${userId}: ${errorMsg}`);
      }
      
      if (failed > 50) {
        console.log('🛑 Слишком много ошибок, останавливаю рассылку');
        break;
      }
    }
    
    // Задержка между сообщениями
    await new Promise(resolve => setTimeout(resolve, BROADCAST_DELAY_MS));
    
    // Пауза после батча
    if ((i + 1) % BROADCAST_BATCH_SIZE === 0 && i + 1 < total) {
      console.log(`⏳ Пауза ${BROADCAST_BATCH_DELAY_MS}мс после ${i + 1} сообщений`);
      await new Promise(resolve => setTimeout(resolve, BROADCAST_BATCH_DELAY_MS));
    }
  }

  console.log(`✅ Рассылка завершена: отправлено ${sent}, ошибок ${failed}`);
  return { sent, failed, blocked, notStarted };
}

async function handleBroadcastCallback(token: string, chatId: number, data: string) {
  let state = broadcastStates.get(chatId);
  if (!state) {
    state = { text: '', buttons: [], previewSent: false };
    broadcastStates.set(chatId, state);
  }

  if (data === "bcast_text" || data === "bcast_edit_text") {
    if (data === "bcast_edit_text") {
      state.text = '';
      state.previewSent = false;
    }
    await sendMessage(token, chatId,
      "📝 <b>Введите текст рассылки</b>\n\n" +
      "Можно использовать HTML:\n" +
      "<code>&lt;b&gt;жирный&lt;/b&gt;</code>\n" +
      "<code>&lt;i&gt;курсив&lt;/i&gt;</code>\n" +
      "<code>&lt;a href='url'&gt;ссылка&lt;/a&gt;</code>\n\n" +
      "Или отправьте /cancel для отмены"
    );
    return;
  }

  if (data === "bcast_add_button") {
    await sendMessage(token, chatId,
      "➕ <b>Добавление кнопки</b>\n\n" +
      `Уже добавлено: ${state.buttons.length} кнопок\n\n` +
      "Отправьте в формате:\n" +
      "<code>Текст кнопки | https://ссылка.com</code>\n\n" +
      "Примеры:\n" +
      "<code>Купить подарок | https://t.me/nft/gift</code>\n" +
      "<code>Подписаться | https://t.me/mychannel</code>\n\n" +
      "Или отправьте /cancel для отмены"
    );
    return;
  }

  if (data === "bcast_clear_buttons") {
    state.buttons = [];
    state.previewSent = false;
    await sendMessage(token, chatId, "🗑️ Все кнопки удалены!");
    await showBroadcastStatus(token, chatId);
    return;
  }

  if (data === "bcast_add_image") {
    await sendMessage(token, chatId,
      "🖼️ <b>Добавление изображения</b>\n\n" +
      "Просто отправьте картинку в этот чат\n\n" +
      "Или отправьте /cancel для отмены"
    );
    return;
  }

  if (data === "bcast_edit_image") {
    state.imageFileId = undefined;
    state.previewSent = false;
    await sendMessage(token, chatId,
      "🖼️ <b>Отправьте новое изображение</b>\n\n" +
      "Или отправьте /cancel для отмены"
    );
    return;
  }

  if (data === "bcast_preview") {
    await showBroadcastPreview(token, chatId);
    return;
  }

  if (data === "bcast_publish") {
    if (!state.text) {
      await sendMessage(token, chatId, "❌ Добавьте текст рассылки!");
      return;
    }

    if (!state.previewSent) {
      const confirmKeyboard = {
        inline_keyboard: [
          [
            { text: "👁️ Сначала посмотреть", callback_data: "bcast_preview" },
            { text: "📤 Всё равно опубликовать", callback_data: "bcast_force_publish" }
          ],
          [
            { text: "🔙 Назад", callback_data: "bcast_back" }
          ]
        ]
      };
      
      await sendMessage(token, chatId,
        "⚠️ <b>Вы не посмотрели превью!</b>\n\n" +
        "Рекомендую сначала проверить, как будет выглядеть сообщение.",
        confirmKeyboard
      );
      return;
    }

    const confirmKeyboard = {
      inline_keyboard: [
        [
          { text: "✅ Да, опубликовать", callback_data: "bcast_confirm_publish" },
          { text: "❌ Нет, отменить", callback_data: "bcast_cancel" }
        ]
      ]
    };

    await sendMessage(token, chatId,
      `📤 <b>Подтверждение публикации</b>\n\n` +
      `👥 Подписчиков: ${subscribers.size}\n` +
      `📝 Текст: ${state.text.substring(0, 50)}${state.text.length > 50 ? "..." : ""}\n` +
      `🔗 Кнопок: ${state.buttons.length}\n` +
      `🖼️ Изображение: ${state.imageFileId ? "✅" : "❌"}\n\n` +
      `Отправить рассылку?`,
      confirmKeyboard
    );
    return;
  }

  if (data === "bcast_force_publish") {
    state.previewSent = true;
    const confirmKeyboard = {
      inline_keyboard: [
        [
          { text: "✅ Да, опубликовать", callback_data: "bcast_confirm_publish" },
          { text: "❌ Нет, отменить", callback_data: "bcast_cancel" }
        ]
      ]
    };

    await sendMessage(token, chatId,
      `📤 <b>Подтверждение публикации</b>\n\n` +
      `👥 Подписчиков: ${subscribers.size}\n` +
      `📝 Текст: ${state.text.substring(0, 50)}${state.text.length > 50 ? "..." : ""}\n` +
      `🔗 Кнопок: ${state.buttons.length}\n` +
      `🖼️ Изображение: ${state.imageFileId ? "✅" : "❌"}\n\n` +
      `Отправить рассылку?`,
      confirmKeyboard
    );
    return;
  }

  if (data === "bcast_confirm_publish") {
    let message = state.text;

    await sendMessage(token, chatId, `📨 Начинаю рассылку ${subscribers.size} подписчикам...\n\n⏳ Это может занять некоторое время...`);
    
    const result = await sendBroadcast(token, message, state.imageFileId, state.buttons);
    
    broadcastStates.delete(chatId);
    
    let resultText = `✅ <b>Рассылка завершена!</b>\n\n`;
    resultText += `📤 Отправлено: ${result.sent}\n`;
    resultText += `🚫 Заблокировали бота: ${result.blocked}\n`;
    resultText += `❌ Не начинали диалог: ${result.notStarted}\n`;
    resultText += `👥 Всего: ${subscribers.size}\n\n`;
    
    if (result.blocked > 0 || result.notStarted > 0) {
      resultText += `💡 Удали неактивных: /clean`;
    }
    
    await sendMessage(token, chatId, resultText);
    return;
  }

  if (data === "bcast_back") {
    await showBroadcastStatus(token, chatId);
    return;
  }

  if (data === "bcast_cancel") {
    broadcastStates.delete(chatId);
    await sendMessage(token, chatId, "❌ Рассылка отменена.");
    return;
  }
}

async function handleBroadcastInput(token: string, chatId: number, text: string) {
  const state = broadcastStates.get(chatId);
  if (!state) return;

  if (text === '/cancel') {
    broadcastStates.delete(chatId);
    await sendMessage(token, chatId, "❌ Отменено.");
    return;
  }

  if (text.includes('|')) {
    const match = text.match(/^(.+?)\s*\|\s*(https?:\/\/\S+)$/);
    if (match) {
      state.buttons.push({
        text: match[1].trim(),
        url: match[2].trim()
      });
      state.previewSent = false;
      await sendMessage(token, chatId, 
        `✅ Кнопка добавлена! (${state.buttons.length} всего)\n\n` +
        `Текст: ${match[1].trim()}\n` +
        `Ссылка: ${match[2].trim()}`
      );
      await showBroadcastStatus(token, chatId);
    } else {
      await sendMessage(token, chatId,
        "❌ Неверный формат. Используйте:\n" +
        "<code>Текст кнопки | https://ссылка.com</code>"
      );
    }
  } else {
    state.text = text;
    state.previewSent = false;
    await sendMessage(token, chatId, "✅ Текст добавлен!");
    await showBroadcastStatus(token, chatId);
  }
}

async function checkSubscribers(token: string, chatId: number) {
  if (chatId !== adminChatId) {
    await sendMessage(token, chatId, "⛔ Недостаточно прав.");
    return;
  }

  await sendMessage(token, chatId, `🔍 Проверяю ${subscribers.size} подписчиков...`);

  let active = 0;
  let blocked = 0;
  let notStarted = 0;

  for (const userId of subscribers) {
    try {
      await sendMessage(token, userId, "🔍 Проверка связи...");
      active++;
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch (error: any) {
      const errorMsg = error.message || String(error);
      if (errorMsg.includes("bot was blocked by the user")) {
        blocked++;
      } else {
        notStarted++;
      }
    }
  }

  await sendMessage(token, chatId,
    `📊 <b>Результат проверки:</b>\n\n` +
    `✅ Активных: ${active}\n` +
    `🚫 Заблокировали бота: ${blocked}\n` +
    `❌ Не начинали диалог: ${notStarted}\n\n` +
    `💡 Чтобы получать рассылку, пользователи должны написать /start\n` +
    `🧹 Удали неактивных: /clean`
  );
}

async function cleanSubscribers(token: string, chatId: number) {
  if (chatId !== adminChatId) {
    await sendMessage(token, chatId, "⛔ Недостаточно прав.");
    return;
  }

  await sendMessage(token, chatId, `🧹 Очищаю ${subscribers.size} подписчиков...`);

  let removed = 0;
  const toRemove: number[] = [];

  for (const userId of subscribers) {
    try {
      await sendMessage(token, userId, "🔍 Проверка...");
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch (error: any) {
      const errorMsg = error.message || String(error);
      if (errorMsg.includes("bot was blocked") || 
          errorMsg.includes("user is not a member") ||
          errorMsg.includes("chat not found")) {
        toRemove.push(userId);
      }
    }
  }

  for (const userId of toRemove) {
    subscribers.delete(userId);
    removed++;
  }

  saveSubscribers(subscribers);

  await sendMessage(token, chatId,
    `🧹 <b>Очистка завершена!</b>\n\n` +
    `🗑️ Удалено: ${removed}\n` +
    `👥 Осталось: ${subscribers.size}`
  );
}

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

async function handleCommand(token: string, chatId: number, text: string): Promise<void> {
  if (broadcastStates.has(chatId) && !text.startsWith('/')) {
    await handleBroadcastInput(token, chatId, text);
    return;
  }

  addSubscriber(chatId);
  
  const [commandWithMention, ...parts] = text.trim().split(/\s+/);
  const command = commandWithMention.split("@")[0].toLowerCase();
  const args = parts.join(" ");

  if (command === "/broadcast") {
    if (chatId !== adminChatId) {
      await sendMessage(token, chatId, "⛔ Недостаточно прав.");
      return;
    }
    
    await showBroadcastStatus(token, chatId);
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
        textList += `${num}. <a href="tg://user?id=${id}">Пользователь ${id}</a> (<code>${id}</code>)\n`;
      });
    }
    
    await sendMessage(token, chatId, textList, subscribersKeyboard(page, totalPages));
    return;
  }

  if (command === "/check") {
    await checkSubscribers(token, chatId);
    return;
  }

  if (command === "/clean") {
    await cleanSubscribers(token, chatId);
    return;
  }

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
    removeSubscriber(chatId);
    await sendMessage(token, chatId, "Ты отписан от рассылки.");
  } else {
    await handlePrice(token, chatId, text);
  }
}

async function handleCallback(token: string, callback: TelegramCallbackQuery): Promise<void> {
  await telegram(token, "answerCallbackQuery", { callback_query_id: callback.id });
  const chatId = callback.message?.chat.id;
  if (!chatId) return;
  const data = callback.data ?? "";

  if (data.startsWith("bcast_")) {
    await handleBroadcastCallback(token, chatId, data);
    return;
  }

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
        textList += `${num}. <a href="tg://user?id=${id}">Пользователь ${id}</a> (<code>${id}</code>)\n`;
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
          const chatId = update.message.chat.id;
          const state = broadcastStates.get(chatId);
          
          if (update.message.photo && state) {
            const photo = update.message.photo[update.message.photo.length - 1];
            state.imageFileId = photo.file_id;
            state.previewSent = false;
            await sendMessage(token, chatId, "✅ Изображение добавлено!");
            await showBroadcastStatus(token, chatId);
            continue;
          }
          
          if (update.message.text) {
            await handleCommand(token, chatId, update.message.text);
          }
        }
      }
    } catch (error) {
      logger.error({ error }, "Telegram polling failed");
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}

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
          { command: "check", description: "🔍 Проверить подписчиков (админ)" },
          { command: "clean", description: "🧹 Очистить неактивных (админ)" },
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
