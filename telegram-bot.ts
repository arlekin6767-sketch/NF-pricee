// ========== НОВЫЙ ТИП ==========
type BroadcastState = {
  text: string;
  buttons: Array<{ text: string; url: string }>; // МНОГО КНОПОК!
  imageFileId?: string;
  previewSent?: boolean;
};

// ========== НОВОЕ МЕНЮ ==========
function broadcastMainKeyboard(): Record<string, unknown> {
  return {
    inline_keyboard: [
      [
        { text: "📝 Написать текст", callback_data: "bcast_text" }
      ],
      [
        { text: "➕ Добавить кнопку", callback_data: "bcast_add_button" }
      ],
      [
        { text: "🗑️ Очистить кнопки", callback_data: "bcast_clear_buttons" }
      ],
      [
        { text: "🖼️ Добавить фото", callback_data: "bcast_add_image" }
      ],
      [
        { text: "👀 Посмотреть", callback_data: "bcast_preview" }
      ],
      [
        { text: "🚀 Опубликовать", callback_data: "bcast_publish" }
      ]
    ]
  };
}

// ========== ПОКАЗ СТАТУСА ==========
async function showBroadcastStatus(token: string, chatId: number) {
  let state = broadcastStates.get(chatId);
  if (!state) {
    state = { text: '', buttons: [], previewSent: false };
    broadcastStates.set(chatId, state);
  }

  let statusText = "📢 <b>Создание рассылки</b>\n\n";
  statusText += "━━━━━━━━━━━━━━━━━━━\n\n";
  statusText += "📝 <b>Текст:</b>\n";
  statusText += state.text ? state.text.substring(0, 100) + (state.text.length > 100 ? "..." : "") : "<i>(не добавлен)</i>";
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
    statusText += "Нажмите «Посмотреть» для превью";
  } else {
    statusText += "⚠️ Добавьте текст для рассылки";
  }

  await sendMessage(token, chatId, statusText, broadcastMainKeyboard());
}

// ========== ПОКАЗ ПРЕВЬЮ ==========
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

  // Создаем клавиатуру из всех кнопок
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

  let previewCaption = "👁️ <b>ПРЕДПРОСМОТР</b>\n\n";
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

// ========== ОБРАБОТЧИК BROADCAST ==========
async function handleBroadcastCallback(token: string, chatId: number, data: string) {
  let state = broadcastStates.get(chatId);
  if (!state) {
    state = { text: '', buttons: [], previewSent: false };
    broadcastStates.set(chatId, state);
  }

  // ===== ТЕКСТ =====
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

  // ===== ДОБАВИТЬ КНОПКУ =====
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

  // ===== ОЧИСТИТЬ КНОПКИ =====
  if (data === "bcast_clear_buttons") {
    state.buttons = [];
    state.previewSent = false;
    await sendMessage(token, chatId, "🗑️ Все кнопки удалены!");
    await showBroadcastStatus(token, chatId);
    return;
  }

  // ===== ИЗОБРАЖЕНИЕ =====
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

  // ===== ПРЕВЬЮ =====
  if (data === "bcast_preview") {
    await showBroadcastPreview(token, chatId);
    return;
  }

  // ===== ПУБЛИКАЦИЯ =====
  if (data === "bcast_publish") {
    if (!state.text) {
      await sendMessage(token, chatId, "❌ Добавьте текст рассылки!");
      return;
    }

    // Показываем сколько кнопок
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

    // Создаем клавиатуру из всех кнопок
    const replyMarkup = state.buttons.length > 0 ? {
      inline_keyboard: state.buttons.map(btn => [{ text: btn.text, url: btn.url }])
    } : undefined;

    await sendMessage(token, chatId, `📨 Начинаю рассылку ${subscribers.size} подписчикам...`);
    
    let sent = 0;
    let failed = 0;
    
    for (const userId of subscribers) {
      try {
        if (state.imageFileId) {
          await sendPhoto(token, userId, state.imageFileId, message, replyMarkup);
        } else {
          await sendMessage(token, userId, message, replyMarkup);
        }
        sent++;
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        failed++;
        if (failed > 10) break;
      }
    }
    
    broadcastStates.delete(chatId);
    
    await sendMessage(token, chatId, 
      `✅ <b>Рассылка завершена!</b>\n\n` +
      `📤 Отправлено: ${sent}\n` +
      `❌ Не доставлено: ${failed}\n` +
      `👥 Всего: ${subscribers.size}`
    );
    return;
  }

  // ===== НАЗАД =====
  if (data === "bcast_back") {
    await showBroadcastStatus(token, chatId);
    return;
  }

  // ===== ОТМЕНА =====
  if (data === "bcast_cancel") {
    broadcastStates.delete(chatId);
    await sendMessage(token, chatId, "❌ Рассылка отменена.");
    return;
  }
}

// ========== ОБРАБОТЧИК ВВОДА ==========
async function handleBroadcastInput(token: string, chatId: number, text: string) {
  const state = broadcastStates.get(chatId);
  if (!state) return;

  if (text === '/cancel') {
    broadcastStates.delete(chatId);
    await sendMessage(token, chatId, "❌ Отменено.");
    return;
  }

  // Проверяем, это кнопка или текст
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
