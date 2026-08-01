// ... весь остальной код остается таким же ...

// ========== НОВЫЕ ТИПЫ ==========
type BroadcastState = {
  text: string;
  buttonText?: string;
  buttonUrl?: string;
  imageFileId?: string;
};

// ========== КЛАВИАТУРЫ ==========
function broadcastMainKeyboard(): Record<string, unknown> {
  return {
    inline_keyboard: [
      [
        { text: "📝 Текст рассылки", callback_data: "bcast_text" },
        { text: "✏️ Редактировать текст", callback_data: "bcast_edit_text" }
      ],
      [
        { text: "🔗 Добавить кнопку", callback_data: "bcast_add_button" },
        { text: "🗑️ Удалить меню", callback_data: "bcast_remove_buttons" }
      ],
      [
        { text: "🖼️ Добавить изображение", callback_data: "bcast_add_image" },
        { text: "📎 Совместить сообщение", callback_data: "bcast_merge" }
      ],
      [
        { text: "🎮 Панель управления", callback_data: "bcast_control_panel" }
      ]
    ]
  };
}

function controlPanelKeyboard(): Record<string, unknown> {
  return {
    inline_keyboard: [
      [
        { text: "▶️ Запустить рассылку", callback_data: "bcast_start" },
        { text: "⏰ По времени", callback_data: "bcast_schedule" }
      ],
      [
        { text: "⚙️ Настройки сообщения", callback_data: "bcast_settings" },
        { text: "🔙 Назад", callback_data: "bcast_back" }
      ]
    ]
  };
}

// ========== ПОКАЗ СТАТУСА ==========
async function showBroadcastStatus(token: string, chatId: number) {
  let state = broadcastStates.get(chatId);
  if (!state) {
    state = { text: '' };
    broadcastStates.set(chatId, state);
  }

  let statusText = "📢 <b>Создание рассылки</b>\n\n";
  statusText += "━━━━━━━━━━━━━━━━━━━\n\n";
  statusText += "📝 <b>Текст рассылки:</b>\n";
  statusText += state.text || "<i>(не добавлен)</i>\n\n";
  statusText += "🔗 <b>Кнопки:</b>\n";
  if (state.buttonText && state.buttonUrl) {
    statusText += `✅ ${state.buttonText} → ${state.buttonUrl}\n\n`;
  } else {
    statusText += "❌ Кнопок пока нет\n\n";
  }
  statusText += "🖼️ <b>Изображение:</b>\n";
  statusText += state.imageFileId ? "✅ Добавлено\n" : "❌ Не добавлено\n\n";
  statusText += "━━━━━━━━━━━━━━━━━━━\n\n";
  statusText += "Выберите действие:";

  await sendMessage(token, chatId, statusText, broadcastMainKeyboard());
}

// ========== ОБРАБОТЧИК BROADCAST ==========
async function handleBroadcastCallback(token: string, chatId: number, data: string) {
  let state = broadcastStates.get(chatId);
  if (!state) {
    state = { text: '' };
    broadcastStates.set(chatId, state);
  }

  // ТЕКСТ
  if (data === "bcast_text" || data === "bcast_edit_text") {
    if (data === "bcast_edit_text") state.text = '';
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

  // КНОПКИ
  if (data === "bcast_add_button") {
    await sendMessage(token, chatId,
      "🔗 <b>Добавление кнопки</b>\n\n" +
      "Отправьте в формате:\n" +
      "<code>Текст кнопки | https://ссылка.com</code>\n\n" +
      "Пример:\n" +
      "<code>Купить подарок | https://t.me/nft/gift</code>"
    );
    return;
  }

  if (data === "bcast_remove_buttons") {
    state.buttonText = undefined;
    state.buttonUrl = undefined;
    await sendMessage(token, chatId, "✅ Кнопки удалены!");
    await showBroadcastStatus(token, chatId);
    return;
  }

  // ИЗОБРАЖЕНИЕ
  if (data === "bcast_add_image") {
    await sendMessage(token, chatId,
      "🖼️ <b>Добавление изображения</b>\n\n" +
      "Просто отправьте картинку в этот чат\n\n" +
      "Или отправьте /cancel для отмены"
    );
    return;
  }

  // СОВМЕСТИТЬ
  if (data === "bcast_merge") {
    if (!state.text && !state.imageFileId) {
      await sendMessage(token, chatId, "❌ Добавьте текст или изображение!");
      return;
    }
    
    let previewText = "📢 <b>Предпросмотр</b>\n\n";
    previewText += "━━━━━━━━━━━━━━━━━━━\n\n";
    if (state.text) previewText += state.text + "\n\n";
    if (state.buttonText && state.buttonUrl) {
      previewText += `🔗 <a href="${state.buttonUrl}">${state.buttonText}</a>\n\n`;
    }
    previewText += "━━━━━━━━━━━━━━━━━━━\n\n";
    previewText += "✅ Сообщение готово к отправке!";
    
    if (state.imageFileId) {
      await sendPhoto(token, chatId, state.imageFileId, previewText);
    } else {
      await sendMessage(token, chatId, previewText);
    }
    return;
  }

  // ПАНЕЛЬ УПРАВЛЕНИЯ
  if (data === "bcast_control_panel") {
    await sendMessage(token, chatId,
      "🎮 <b>Панель управления</b>\n\n" +
      `👥 Подписчиков: ${subscribers.size}\n` +
      `📝 Текст: ${state.text ? "✅" : "❌"}\n` +
      `🔗 Кнопка: ${state.buttonText ? "✅" : "❌"}\n` +
      `🖼️ Изображение: ${state.imageFileId ? "✅" : "❌"}\n\n` +
      "Выберите действие:",
      controlPanelKeyboard()
    );
    return;
  }

  // ЗАПУСТИТЬ
  if (data === "bcast_start") {
    if (!state.text) {
      await sendMessage(token, chatId, "❌ Добавьте текст рассылки!");
      return;
    }

    let message = state.text;
    if (state.buttonText && state.buttonUrl) {
      message += `\n\n🔗 <a href="${state.buttonUrl}">${state.buttonText}</a>`;
    }

    await sendMessage(token, chatId, `📨 Начинаю рассылку ${subscribers.size} подписчикам...`);
    const result = await broadcast(token, message, state.imageFileId);
    await sendMessage(token, chatId, 
      `✅ Рассылка завершена!\nОтправлено: ${result.sent}\nНе доставлено: ${result.failed}`
    );
    return;
  }

  // ПО ВРЕМЕНИ
  if (data === "bcast_schedule") {
    await sendMessage(token, chatId,
      "⏰ <b>Запланировать рассылку</b>\n\n" +
      "В разработке...\n" +
      "Скоро появится возможность отложенной отправки!"
    );
    return;
  }

  // НАСТРОЙКИ
  if (data === "bcast_settings") {
    await sendMessage(token, chatId,
      "⚙️ <b>Настройки сообщения</b>\n\n" +
      "• Режим: обычный\n" +
      "• Формат: HTML\n" +
      "• Кнопки: " + (state.buttonText ? "включены" : "выключены") + "\n\n" +
      "Настройки по умолчанию"
    );
    return;
  }

  // НАЗАД
  if (data === "bcast_back") {
    await showBroadcastStatus(token, chatId);
    return;
  }

  // ОТМЕНА
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
      state.buttonText = match[1].trim();
      state.buttonUrl = match[2].trim();
      await sendMessage(token, chatId, "✅ Кнопка добавлена!");
      await showBroadcastStatus(token, chatId);
    } else {
      await sendMessage(token, chatId,
        "❌ Неверный формат. Используйте:\n" +
        "<code>Текст кнопки | https://ссылка.com</code>"
      );
    }
  } else {
    state.text = text;
    await sendMessage(token, chatId, "✅ Текст добавлен!");
    await showBroadcastStatus(token, chatId);
  }
}

// ========== ОБНОВЛЯЕМ handleCommand ==========
// В функции handleCommand находим обработку /broadcast и заменяем на:

if (command === "/broadcast") {
  if (chatId !== adminChatId) {
    await sendMessage(token, chatId, "⛔ Недостаточно прав.");
    return;
  }
  
  await showBroadcastStatus(token, chatId);
  return;
}

// ========== ОБНОВЛЯЕМ handleCallback ==========
// В функции handleCallback добавляем обработку bcast:

if (data.startsWith("bcast_")) {
  await handleBroadcastCallback(token, chatId, data);
  return;
}

// ========== ОБНОВЛЯЕМ poll ==========
// В функции poll, при получении изображения:

if (update.message.photo) {
  const chatId = update.message.chat.id;
  const state = broadcastStates.get(chatId);
  if (state) {
    const photo = update.message.photo[update.message.photo.length - 1];
    state.imageFileId = photo.file_id;
    await sendMessage(token, chatId, "✅ Изображение добавлено!");
    await showBroadcastStatus(token, chatId);
    continue;
  }
}
