
const API = (token, method) =>
  `https://api.telegram.org/bot${token}/${method}`;

async function tg(env, method, data = {}) {
  const response = await fetch(API(env.TELEGRAM_BOT_TOKEN, method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  const result = await response.json();
  if (!result.ok) console.error("Telegram API error:", result);
  return result;
}

async function send(env, chatId, text, keyboard) {
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...(keyboard ? { reply_markup: keyboard } : {})
  });
}

const mainMenu = {
  keyboard: [
    ["🎯 Открытые игры"],
    ["📝 Мои записи", "ℹ️ Информация о клубе"]
  ],
  resize_keyboard: true
};

const adminMenu = {
  keyboard: [
    ["🎯 Открытые игры"],
    ["📝 Мои записи", "ℹ️ Информация о клубе"],
    ["⚙️ Администрирование"]
  ],
  resize_keyboard: true
};

const adminPanelMenu = {
  inline_keyboard: [
    [{ text: "📋 Список игр", callback_data: "admin:games" }]
  ]
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function state(env, id, value, data = {}) {
  await env.DB.prepare(
    `INSERT INTO user_states (telegram_id,state,data)
     VALUES (?,?,?)
     ON CONFLICT(telegram_id) DO UPDATE SET
       state=excluded.state,
       data=excluded.data,
       updated_at=CURRENT_TIMESTAMP`
  ).bind(String(id), value, JSON.stringify(data)).run();
}

async function getState(env, id) {
  return env.DB.prepare(
    "SELECT state,data FROM user_states WHERE telegram_id=?"
  ).bind(String(id)).first();
}

async function clearState(env, id) {
  await env.DB.prepare(
    "DELETE FROM user_states WHERE telegram_id=?"
  ).bind(String(id)).run();
}

async function isAdmin(env, id) {
  if (String(id) === String(env.OWNER_ID)) return "owner";

  const row = await env.DB.prepare(
    "SELECT role FROM admins WHERE telegram_id=?"
  ).bind(String(id)).first();

  return row?.role || null;
}

function adminBackKeyboard(gameId) {
  return {
    inline_keyboard: [
      [{ text: "⬅️ К игре", callback_data: `admin:players:${gameId}` }],
      [{ text: "📋 К списку игр", callback_data: "admin:games" }]
    ]
  };
}

async function showAdminPanel(env, chatId) {
  return send(
    env,
    chatId,
    "⚙️ <b>Административная панель</b>\n\nВыбери действие:",
    adminPanelMenu
  );
}

async function showAdminGames(env, chatId) {
  const rows = await env.DB.prepare(
    `SELECT g.*,
       COALESCE(SUM(
         CASE WHEN b.status='active' THEN b.participants ELSE 0 END
       ),0) AS booked
     FROM games g
     LEFT JOIN bookings b ON b.game_id=g.id
     GROUP BY g.id
     ORDER BY g.game_date DESC,g.game_time DESC
     LIMIT 30`
  ).all();

  if (!rows.results.length) {
    return send(env, chatId, "Игры пока не добавлены.", {
      inline_keyboard: [[
        { text: "⬅️ В админ-панель", callback_data: "admin:menu" }
      ]]
    });
  }

  const buttons = rows.results.map(game => {
    const date = String(game.game_date).split("-").reverse().join(".");
    const status = {
      open: "🟢",
      pending: "🟡",
      cancelled: "🔴",
      closed: "⚫"
    }[game.status] || "❔";

    return [{
      text: `${status} ${date} | ${String(game.title || "Игра").slice(0, 28)} | 👥 ${game.booked}`,
      callback_data: `admin:players:${game.id}`
    }];
  });

  buttons.push([{
    text: "⬅️ В админ-панель",
    callback_data: "admin:menu"
  }]);

  return send(
    env,
    chatId,
    "📋 <b>Все игры</b>\n\n🟢 Запись открыта\n⚫ Запись закрыта\n🔴 Игра отменена\n🟡 Ожидает подтверждения\n\nВыбери игру:",
    { inline_keyboard: buttons }
  );
}

async function showAdminPlayers(env, chatId, gameId) {
  const game = await env.DB.prepare(
    "SELECT * FROM games WHERE id=?"
  ).bind(gameId).first();

  if (!game) return send(env, chatId, "Игра не найдена.");

  const rows = await env.DB.prepare(
    `SELECT organizer_name,phone,participants
     FROM bookings
     WHERE game_id=? AND status='active'
     ORDER BY created_at`
  ).bind(gameId).all();

  const date = String(game.game_date).split("-").reverse().join(".");
  const total = rows.results.reduce(
    (sum, row) => sum + Number(row.participants || 0),
    0
  );

  let message =
    `🎯 <b>${escapeHtml(game.title || "Открытая игра")}</b>\n` +
    `📅 ${date} в ${escapeHtml(game.game_time)}\n` +
    `💰 ${escapeHtml(game.price || "Уточняется")}\n` +
    `📌 Статус: ${escapeHtml(game.status)}\n` +
    `👥 <b>Всего участников: ${total}</b>\n\n`;

  if (!rows.results.length) {
    message += "Пока никто не записался.";
  } else {
    rows.results.forEach((row, index) => {
      message +=
        `${index + 1}. ${escapeHtml(row.organizer_name)}\n` +
        `📞 ${escapeHtml(row.phone)}\n` +
        `👥 Человек: ${row.participants}\n\n`;
    });
  }

  const statusButton = game.status === "open"
    ? { text: "🔒 Закрыть запись", callback_data: `admin:close:${gameId}` }
    : game.status === "closed"
      ? { text: "🟢 Открыть запись", callback_data: `admin:open:${gameId}` }
      : null;

  const buttons = [];

  if (statusButton) buttons.push([statusButton]);

  if (game.status !== "cancelled") {
    buttons.push([
      { text: "📅 Изменить дату", callback_data: `admin:date:${gameId}` },
      { text: "🕒 Изменить время", callback_data: `admin:time:${gameId}` }
    ]);

    buttons.push([
      { text: "💰 Изменить цену", callback_data: `admin:price:${gameId}` }
    ]);

    buttons.push([
      { text: "📢 Уведомить игроков", callback_data: `admin:notify:${gameId}` }
    ]);

    buttons.push([
      { text: "❌ Отменить игру", callback_data: `admin:cancel:${gameId}` }
    ]);
  }

  buttons.push([
    { text: "⬅️ К списку игр", callback_data: "admin:games" }
  ]);

  buttons.push([
    { text: "⚙️ В админ-панель", callback_data: "admin:menu" }
  ]);

  return send(env, chatId, message, {
    inline_keyboard: buttons
  });
}

async function notifyGamePlayers(env, gameId, message) {
  const rows = await env.DB.prepare(
    `SELECT DISTINCT telegram_id
     FROM bookings
     WHERE game_id=? AND status='active'`
  ).bind(gameId).all();

  let sent = 0;
  let failed = 0;

  for (const row of rows.results) {
    const result = await send(env, row.telegram_id, message);

    if (result?.ok) sent++;
    else failed++;
  }

  return { total: rows.results.length, sent, failed };
}

async function getGame(env, gameId) {
  return env.DB.prepare(
    "SELECT * FROM games WHERE id=?"
  ).bind(gameId).first();
}

async function adminEditStart(env, chatId, userId, gameId, editType) {
  const game = await getGame(env, gameId);

  if (!game) return send(env, chatId, "Игра не найдена.");

  if (game.status === "cancelled") {
    return send(env, chatId, "Нельзя редактировать отменённую игру.");
  }

  const prompts = {
    date: "📅 Введи новую дату игры в формате ДД.ММ.ГГГГ.",
    time: "🕒 Введи новое время игры в формате ЧЧ:ММ.",
    price: "💰 Введи новую цену игры. Например: 2500 ₽ или 2300 ₽ безлимит."
  };

  await state(env, userId, `admin_edit_${editType}`, { gameId });

  return send(
    env,
    chatId,
    prompts[editType],
    {
      inline_keyboard: [[
        { text: "⬅️ Назад к игре", callback_data: `admin:players:${gameId}` }
      ]]
    }
  );
}

async function adminCancelGame(env, chatId, gameId) {
  const game = await getGame(env, gameId);

  if (!game) return send(env, chatId, "Игра не найдена.");

  if (game.status === "cancelled") {
    return send(env, chatId, "Эта игра уже отменена.");
  }

  return send(
    env,
    chatId,
    `⚠️ <b>Подтверждение отмены игры</b>\n\n` +
    `${escapeHtml(game.title)}\n` +
    `Дата: ${String(game.game_date).split("-").reverse().join(".")}\n` +
    `Время: ${escapeHtml(game.game_time)}\n\n` +
    `Игра будет отменена, а все записанные игроки получат уведомление.\n\nОтменить игру?`,
    {
      inline_keyboard: [
        [
          { text: "❌ Да, отменить", callback_data: `admin:cancel_confirm:${gameId}` }
        ],
        [
          { text: "⬅️ Нет, назад", callback_data: `admin:players:${gameId}` }
        ]
      ]
    }
  );
}

async function showGames(env, chatId) {
  const rows = await env.DB.prepare(
    `SELECT g.*,
       COALESCE(SUM(
         CASE WHEN b.status='active' THEN b.participants ELSE 0 END
       ),0) AS booked
     FROM games g
     LEFT JOIN bookings b ON b.game_id=g.id
     WHERE g.status='open'
       AND (g.game_date > date('now','localtime')
         OR (g.game_date = date('now','localtime')
             AND g.game_time >= time('now','localtime')))
     GROUP BY g.id
     ORDER BY g.game_date,g.game_time`
  ).all();

  if (!rows.results.length) {
    return send(env, chatId, "Пока нет опубликованных открытых игр.", mainMenu);
  }

  for (const game of rows.results) {
    const date = String(game.game_date).split("-").reverse().join(".");

    await send(
      env,
      chatId,
      `🎯 <b>${escapeHtml(game.title || "Открытая игра")}</b>\n\n` +
      `📅 ${date}\n🕒 ${escapeHtml(game.game_time)}\n` +
      `💰 ${escapeHtml(game.price || "Уточняется")}\n` +
      `👥 Записано: ${Number(game.booked) || 0}\n\n` +
      `${escapeHtml(game.description || "")}`,
      {
        inline_keyboard: [[
          { text: "Записаться", callback_data: `book:${game.id}` }
        ]]
      }
    );
  }
}

async function showMyBookings(env, chatId, userId) {
  const rows = await env.DB.prepare(
    `SELECT b.*,g.title,g.game_date,g.game_time
     FROM bookings b
     JOIN games g ON g.id=b.game_id
     WHERE b.telegram_id=? AND b.status='active'
     ORDER BY g.game_date,g.game_time`
  ).bind(String(userId)).all();

  if (!rows.results.length) {
    return send(env, chatId, "У тебя пока нет активных записей.", mainMenu);
  }

  for (const booking of rows.results) {
    const date = String(booking.game_date).split("-").reverse().join(".");

    await send(
      env,
      chatId,
      `🎯 <b>${escapeHtml(booking.title || "Открытая игра")}</b>\n` +
      `📅 ${date} в ${escapeHtml(booking.game_time)}\n` +
      `👤 ${escapeHtml(booking.organizer_name)}\n` +
      `📞 ${escapeHtml(booking.phone)}\n` +
      `👥 Участников: ${booking.participants}`,
      {
        inline_keyboard: [
          [{ text: "Изменить количество", callback_data: `editcount:${booking.id}` }],
          [{ text: "Изменить телефон", callback_data: `editphone:${booking.id}` }],
          [{ text: "Отменить запись", callback_data: `cancel:${booking.id}` }]
        ]
      }
    );
  }
}

async function startBooking(env, chatId, userId, gameId) {
  const game = await env.DB.prepare(
    "SELECT id,status FROM games WHERE id=?"
  ).bind(gameId).first();

  if (!game || game.status !== "open") {
    return send(env, chatId, "Эта игра уже недоступна для записи.", mainMenu);
  }

  await state(env, userId, "name", { gameId });
  return send(env, chatId, "Напиши имя и фамилию организатора записи.");
}

async function notifyAdmins(env, message) {
  const rows = await env.DB.prepare(
    "SELECT telegram_id FROM admins"
  ).all();

  const ids = [...new Set([
    String(env.OWNER_ID),
    ...rows.results.map(row => String(row.telegram_id))
  ])];

  for (const id of ids) {
    if (id && id !== "undefined") await send(env, id, message);
  }
}

function parseGame(text) {
  const dateMatch = text.match(/\b(\d{2})\.(\d{2})\.(\d{4})\b/);
  const timeMatch = text.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/);
  const priceMatch = text.match(/(\d[\d ]*)\s*₽/i);

  if (!dateMatch || !timeMatch) return null;

  const [, day, month, year] = dateMatch;
  const date = `${year}-${month}-${day}`;
  const parsedDate = new Date(`${date}T00:00:00`);

  if (
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.getFullYear() !== Number(year) ||
    parsedDate.getMonth() + 1 !== Number(month) ||
    parsedDate.getDate() !== Number(day)
  ) return null;

  const cleanText = text.replace(/#открытаяигра/ig, "").trim();
  const firstLine =
    cleanText.split(/\r?\n/).find(line => line.trim()) || "Открытая игра";

  return {
    title: firstLine.slice(0, 150) || "Открытая игра",
    date,
    time: timeMatch[0].length === 4 ? `0${timeMatch[0]}` : timeMatch[0],
    price: priceMatch ? `${priceMatch[1].trim()} ₽` : "Уточняется",
    description: cleanText.slice(0, 3500)
  };
}

async function handleMessage(env, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = (msg.text || "").trim();

  if (!userId) return;

  await env.DB.prepare(
    `INSERT INTO subscribers (telegram_id) VALUES (?)
     ON CONFLICT(telegram_id) DO NOTHING`
  ).bind(String(userId)).run();

  if (text === "/start") {
    await clearState(env, userId);

    return send(
      env,
      chatId,
      "Добро пожаловать в клуб «Стрелок»!\nЗдесь можно посмотреть открытые игры и записаться на участие.",
      (await isAdmin(env, userId)) ? adminMenu : mainMenu
    );
  }

  if (text === "⚙️ Администрирование") {
    await clearState(env, userId);

    if (!(await isAdmin(env, userId))) {
      return send(env, chatId, "Недостаточно прав.");
    }

    return showAdminPanel(env, chatId);
  }

  if (text === "🎯 Открытые игры") {
    await clearState(env, userId);
    return showGames(env, chatId);
  }

  if (text === "📝 Мои записи") {
    await clearState(env, userId);
    return showMyBookings(env, chatId, userId);
  }

  if (text === "ℹ️ Информация о клубе") {
    await clearState(env, userId);

    const info = await env.DB.prepare(
      "SELECT * FROM club_info ORDER BY id DESC LIMIT 1"
    ).first();

    return send(
      env,
      chatId,
      info
        ? `ℹ️ <b>Информация о клубе</b>\n\n📍 ${escapeHtml(info.address || "Не указано")}\n☎️ ${escapeHtml(info.contacts || "Не указано")}\n\n📋 ${escapeHtml(info.rules || "Правила уточняйте у организатора")}\n\n🔞 ${escapeHtml(info.age_restrictions || "Возрастные ограничения уточняйте у организатора")}`
        : "Информация о клубе пока не добавлена.",
      mainMenu
    );
  }

  const current = await getState(env, userId);
  if (!current) return;

  const data = JSON.parse(current.data || "{}");

  // Администратор: ввод новой даты игры
  if (current.state === "admin_edit_date") {
    const match = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);

    if (!match) {
      return send(env, chatId, "Неверный формат. Введи дату ДД.ММ.ГГГГ.");
    }

    const [, day, month, year] = match;
    const date = `${year}-${month}-${day}`;
    const parsed = new Date(`${date}T00:00:00`);

    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.getFullYear() !== Number(year) ||
      parsed.getMonth() + 1 !== Number(month) ||
      parsed.getDate() !== Number(day)
    ) {
      return send(env, chatId, "Такой даты не существует. Попробуй ещё раз.");
    }

    const game = await getGame(env, data.gameId);

    if (!game || game.status === "cancelled") {
      await clearState(env, userId);
      return send(env, chatId, "Игра не найдена или уже отменена.");
    }

    await env.DB.prepare(
      "UPDATE games SET game_date=?,updated_at=CURRENT_TIMESTAMP WHERE id=?"
    ).bind(date, data.gameId).run();

    await clearState(env, userId);

    await send(env, chatId, "✅ Дата игры изменена.", adminBackKeyboard(data.gameId));

    return showAdminPlayers(env, chatId, data.gameId);
  }

  // Администратор: ввод нового времени
  if (current.state === "admin_edit_time") {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) {
      return send(env, chatId, "Неверный формат. Введи время ЧЧ:ММ, например 13:00.");
    }

    const game = await getGame(env, data.gameId);

    if (!game || game.status === "cancelled") {
      await clearState(env, userId);
      return send(env, chatId, "Игра не найдена или уже отменена.");
    }

    await env.DB.prepare(
      "UPDATE games SET game_time=?,updated_at=CURRENT_TIMESTAMP WHERE id=?"
    ).bind(text, data.gameId).run();

    await clearState(env, userId);

    await send(env, chatId, "✅ Время игры изменено.");
    return showAdminPlayers(env, chatId, data.gameId);
  }

  // Администратор: ввод новой цены
  if (current.state === "admin_edit_price") {
    if (text.length < 1 || text.length > 100) {
      return send(env, chatId, "Цена должна содержать от 1 до 100 символов.");
    }

    const game = await getGame(env, data.gameId);

    if (!game || game.status === "cancelled") {
      await clearState(env, userId);
      return send(env, chatId, "Игра не найдена или уже отменена.");
    }

    await env.DB.prepare(
      "UPDATE games SET price=?,updated_at=CURRENT_TIMESTAMP WHERE id=?"
    ).bind(text, data.gameId).run();

    await clearState(env, userId);

    await send(env, chatId, "✅ Цена игры изменена.");
    return showAdminPlayers(env, chatId, data.gameId);
  }

  // Администратор: текст уведомления игрокам
  if (current.state === "admin_notify") {
    if (text.length < 1 || text.length > 3500) {
      return send(env, chatId, "Сообщение должно содержать от 1 до 3500 символов.");
    }

    const game = await getGame(env, data.gameId);

    if (!game) {
      await clearState(env, userId);
      return send(env, chatId, "Игра не найдена.");
    }

    const result = await notifyGamePlayers(
      env,
      data.gameId,
      `📢 <b>Сообщение от клуба «Стрелок»</b>\n\n${escapeHtml(text)}`
    );

    await clearState(env, userId);

    return send(
      env,
      chatId,
      `✅ Рассылка завершена.\n\nВсего записей: ${result.total}\nДоставлено: ${result.sent}\nОшибок доставки: ${result.failed}`,
      adminBackKeyboard(data.gameId)
    );
  }

  if (current.state === "name") {
    if (text.length < 2 || text.length > 100) {
      return send(env, chatId, "Введи имя и фамилию (от 2 до 100 символов).");
    }

    await state(env, userId, "phone", {
      ...data,
      name: text
    });

    return send(env, chatId, "Теперь введи номер телефона организатора.");
  }

  if (current.state === "phone") {
    if (text.length < 5 || text.length > 30) {
      return send(env, chatId, "Проверь номер телефона и введи его ещё раз.");
    }

    await state(env, userId, "count", {
      ...data,
      phone: text
    });

    return send(env, chatId, "Сколько всего человек будет в вашей группе? Введи число.");
  }

  if (current.state === "count" || current.state === "edit_count") {
    const count = Number(text);

    if (!Number.isInteger(count) || count < 1 || count > 100) {
      return send(env, chatId, "Введи целое число от 1 до 100.");
    }

    if (current.state === "count") {
      const game = await env.DB.prepare(
        "SELECT status FROM games WHERE id=?"
      ).bind(data.gameId).first();

      if (!game || game.status !== "open") {
        await clearState(env, userId);
        return send(env, chatId, "Игра больше недоступна для записи.", mainMenu);
      }

      const result = await env.DB.prepare(
        `INSERT INTO bookings
         (game_id,telegram_id,organizer_name,phone,participants)
         VALUES (?,?,?,?,?)`
      ).bind(
        data.gameId,
        String(userId),
        data.name,
        data.phone,
        count
      ).run();

      await env.DB.prepare(
        `INSERT INTO booking_history (booking_id,action,new_data)
         VALUES (?,'created',?)`
      ).bind(
        result.meta.last_row_id,
        JSON.stringify({
          name: data.name,
          phone: data.phone,
          participants: count
        })
      ).run();

      await clearState(env, userId);

      await notifyAdmins(
        env,
        `📝 Новая запись!\nИгра ID: ${data.gameId}\nОрганизатор: ${data.name}\nТелефон: ${data.phone}\nУчастников: ${count}`
      );

      return send(env, chatId, "✅ Запись принята! Ждём тебя на игре.", mainMenu);
    }

    const booking = await env.DB.prepare(
      "SELECT * FROM bookings WHERE id=? AND telegram_id=? AND status='active'"
    ).bind(data.bookingId, String(userId)).first();

    if (!booking) {
      await clearState(env, userId);
      return send(env, chatId, "Активная запись не найдена.", mainMenu);
    }

    await env.DB.prepare(
      "UPDATE bookings SET participants=?,updated_at=CURRENT_TIMESTAMP WHERE id=?"
    ).bind(count, data.bookingId).run();

    await env.DB.prepare(
      `INSERT INTO booking_history (booking_id,action,old_data,new_data)
       VALUES (?,'updated',?,?)`
    ).bind(
      data.bookingId,
      JSON.stringify({ participants: booking.participants }),
      JSON.stringify({ participants: count })
    ).run();

    await clearState(env, userId);

    await notifyAdmins(
      env,
      `✏️ Изменено количество участников.\nЗапись ID: ${data.bookingId}\nБыло: ${booking.participants}\nСтало: ${count}`
    );

    return send(env, chatId, `✅ Количество участников изменено: ${count}.`, mainMenu);
  }

  if (current.state === "edit_phone") {
    if (text.length < 5 || text.length > 30) {
      return send(env, chatId, "Проверь номер телефона и введи его ещё раз.");
    }

    const booking = await env.DB.prepare(
      "SELECT * FROM bookings WHERE id=? AND telegram_id=? AND status='active'"
    ).bind(data.bookingId, String(userId)).first();

    if (!booking) {
      await clearState(env, userId);
      return send(env, chatId, "Активная запись не найдена.", mainMenu);
    }

    await env.DB.prepare(
      "UPDATE bookings SET phone=?,updated_at=CURRENT_TIMESTAMP WHERE id=?"
    ).bind(text, data.bookingId).run();

    await env.DB.prepare(
      `INSERT INTO booking_history (booking_id,action,old_data,new_data)
       VALUES (?,'updated',?,?)`
    ).bind(
      data.bookingId,
      JSON.stringify({ phone: booking.phone }),
      JSON.stringify({ phone: text })
    ).run();

    await clearState(env, userId);

    await notifyAdmins(
      env,
      `✏️ Изменён телефон в записи ID ${data.bookingId}.`
    );

    return send(env, chatId, "✅ Номер телефона успешно изменён.", mainMenu);
  }
}

async function handleCallback(env, query) {
  const chatId = query.message?.chat?.id;
  const userId = query.from?.id;
  const callbackData = query.data || "";

  await tg(env, "answerCallbackQuery", {
    callback_query_id: query.id
  });

  if (!chatId || !userId) return;

  // Все административные действия проверяют права
  if (callbackData.startsWith("admin:")) {
    if (!(await isAdmin(env, userId))) {
      return send(env, chatId, "Недостаточно прав.");
    }

    if (callbackData === "admin:menu") {
      return showAdminPanel(env, chatId);
    }

    if (callbackData === "admin:games") {
      return showAdminGames(env, chatId);
    }

    if (callbackData.startsWith("admin:players:")) {
      const gameId = Number(callbackData.split(":")[2]);

      if (!Number.isInteger(gameId) || gameId < 1) {
        return send(env, chatId, "Некорректный номер игры.");
      }

      return showAdminPlayers(env, chatId, gameId);
    }

    const parts = callbackData.split(":");
    const action = parts[1];
    const gameId = Number(parts[2]);

    if (!Number.isInteger(gameId) || gameId < 1) {
      return send(env, chatId, "Некорректный номер игры.");
    }

    const game = await getGame(env, gameId);

    if (!game) return send(env, chatId, "Игра не найдена.");

    if (action === "close") {
      if (game.status !== "open") {
        return send(env, chatId, "Запись на эту игру уже закрыта или игра недоступна.");
      }

      await env.DB.prepare(
        "UPDATE games SET status='closed',updated_at=CURRENT_TIMESTAMP WHERE id=?"
      ).bind(gameId).run();

      await send(env, chatId, "🔒 Запись на игру закрыта.");
      return showAdminPlayers(env, chatId, gameId);
    }

    if (action === "open") {
      if (game.status !== "closed") {
        return send(env, chatId, "Открыть запись можно только для закрытой игры.");
      }

      await env.DB.prepare(
        "UPDATE games SET status='open',updated_at=CURRENT_TIMESTAMP WHERE id=?"
      ).bind(gameId).run();

      await send(env, chatId, "🟢 Запись на игру снова открыта.");
      return showAdminPlayers(env, chatId, gameId);
    }

    if (action === "date" || action === "time" || action === "price") {
      return adminEditStart(env, chatId, userId, gameId, action);
    }

    if (action === "notify") {
      await state(env, userId, "admin_notify", { gameId });

      return send(
        env,
        chatId,
        "📢 Напиши текст уведомления. Оно будет отправлено всем активным участникам этой игры.",
        {
          inline_keyboard: [[
            { text: "⬅️ Отмена", callback_data: `admin:players:${gameId}` }
          ]]
        }
      );
    }

    if (action === "cancel") {
      return adminCancelGame(env, chatId, gameId);
    }

    if (action === "cancel_confirm") {
      if (game.status === "cancelled") {
        return send(env, chatId, "Игра уже отменена.");
      }

      await env.DB.prepare(
        "UPDATE games SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=?"
      ).bind(gameId).run();

      const date = String(game.game_date).split("-").reverse().join(".");

      const result = await notifyGamePlayers(
        env,
        gameId,
        `❌ <b>Игра отменена</b>\n\n` +
        `${escapeHtml(game.title || "Открытая игра")}\n` +
        `📅 ${date}\n🕒 ${escapeHtml(game.game_time)}\n\n` +
        `К сожалению, игра отменена. Приносим извинения за неудобства.`
      );

      await send(
        env,
        chatId,
        `❌ Игра отменена.\n\nУведомлений отправлено: ${result.sent}\nОшибок доставки: ${result.failed}`,
        {
          inline_keyboard: [
            [{ text: "📋 К списку игр", callback_data: "admin:games" }],
            [{ text: "⚙️ В админ-панель", callback_data: "admin:menu" }]
          ]
        }
      );

      return;
    }
  }

  if (callbackData.startsWith("book:")) {
    return startBooking(
      env,
      chatId,
      userId,
      Number(callbackData.split(":")[1])
    );
  }

  if (callbackData.startsWith("editcount:")) {
    const id = Number(callbackData.split(":")[1]);

    const booking = await env.DB.prepare(
      "SELECT id FROM bookings WHERE id=? AND telegram_id=? AND status='active'"
    ).bind(id, String(userId)).first();

    if (!booking) return send(env, chatId, "Активная запись не найдена.");

    await state(env, userId, "edit_count", { bookingId: id });

    return send(env, chatId, "Введи новое общее количество участников (от 1 до 100).");
  }

  if (callbackData.startsWith("editphone:")) {
    const id = Number(callbackData.split(":")[1]);

    const booking = await env.DB.prepare(
      "SELECT id FROM bookings WHERE id=? AND telegram_id=? AND status='active'"
    ).bind(id, String(userId)).first();

    if (!booking) return send(env, chatId, "Активная запись не найдена.");

    await state(env, userId, "edit_phone", { bookingId: id });

    return send(env, chatId, "Введи новый номер телефона организатора.");
  }

  if (callbackData.startsWith("cancel:")) {
    const id = Number(callbackData.split(":")[1]);

    const booking = await env.DB.prepare(
      "SELECT * FROM bookings WHERE id=? AND telegram_id=? AND status='active'"
    ).bind(id, String(userId)).first();

    if (!booking) return send(env, chatId, "Активная запись не найдена.");

    await env.DB.prepare(
      "UPDATE bookings SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=?"
    ).bind(id).run();

    await env.DB.prepare(
      `INSERT INTO booking_history (booking_id,action,old_data)
       VALUES (?,'cancelled',?)`
    ).bind(id, JSON.stringify(booking)).run();

    await send(env, chatId, "Запись отменена.", mainMenu);

    await notifyAdmins(
      env,
      `❌ Отмена записи ID ${id}.\nОрганизатор: ${booking.organizer_name}\nУчастников: ${booking.participants}`
    );

    return;
  }

  if (
    callbackData.startsWith("approve:") ||
    callbackData.startsWith("reject:")
  ) {
    if (!(await isAdmin(env, userId))) {
      return send(env, chatId, "Недостаточно прав.");
    }

    const [action, idText] = callbackData.split(":");
    const id = Number(idText);

    const game = await env.DB.prepare(
      "SELECT * FROM games WHERE id=? AND status='pending'"
    ).bind(id).first();

    if (!game) return send(env, chatId, "Игра уже обработана.");

    if (action === "approve") {
      await env.DB.prepare(
        "UPDATE games SET status='open',updated_at=CURRENT_TIMESTAMP WHERE id=?"
      ).bind(id).run();

      return send(env, chatId, `✅ Игра ${id} опубликована в боте.`);
    }

    await env.DB.prepare(
      "UPDATE games SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=?"
    ).bind(id).run();

    return send(env, chatId, `Игра ${id} отклонена.`);
  }
}

async function handleChannelPost(env, post) {
  const text = post.text || post.caption || "";

  if (!text.toLowerCase().includes("#открытаяигра")) return;

  const parsed = parseGame(text);

  const admins = await env.DB.prepare(
    "SELECT telegram_id FROM admins"
  ).all();

  const recipients = [...new Set([
    String(env.OWNER_ID),
    ...admins.results.map(row => String(row.telegram_id))
  ])];

  if (!parsed) {
    for (const id of recipients) {
      await send(
        env,
        id,
        "⚠️ Найден пост с #открытаяигра, но не удалось распознать дату или время.\nУкажи дату в формате ДД.ММ.ГГГГ и время ЧЧ:ММ."
      );
    }
    return;
  }

  const result = await env.DB.prepare(
    `INSERT INTO games
     (title,description,game_date,game_time,price,status,channel_message_id)
     VALUES (?,?,?,?,?,'pending',?)`
  ).bind(
    parsed.title,
    parsed.description,
    parsed.date,
    parsed.time,
    parsed.price,
    String(post.message_id)
  ).run();

  for (const id of recipients) {
    await send(
      env,
      id,
      `🔎 <b>Найдена новая открытая игра</b>\n\n` +
      `🎯 ${escapeHtml(parsed.title)}\n📅 ${parsed.date}\n🕒 ${parsed.time}\n` +
      `💰 ${escapeHtml(parsed.price)}\n\n${escapeHtml(parsed.description)}`,
      {
        inline_keyboard: [[
          { text: "Подтвердить", callback_data: `approve:${result.meta.last_row_id}` },
          { text: "Отклонить", callback_data: `reject:${result.meta.last_row_id}` }
        ]]
      }
    );
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/setup" && request.method === "GET") {
      if (
        !url.searchParams.get("key") ||
        url.searchParams.get("key") !== env.WEBHOOK_SECRET
      ) {
        return new Response("Forbidden", { status: 403 });
      }

      const webhookUrl = `${url.origin}/telegram`;

      const result = await tg(env, "setWebhook", {
        url: webhookUrl,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: [
          "message",
          "callback_query",
          "channel_post"
        ]
      });

      return Response.json(result);
    }

    if (url.pathname !== "/telegram") {
  return env.ASSETS.fetch(request);
}

    if (
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") !==
      env.WEBHOOK_SECRET
    ) {
      return new Response("Forbidden", { status: 403 });
    }

    try {
      const update = await request.json();

      if (update.message) {
        await handleMessage(env, update.message);
      }

      if (update.callback_query) {
        await handleCallback(env, update.callback_query);
      }

      if (update.channel_post) {
        await handleChannelPost(env, update.channel_post);
      }

      return new Response("OK");
    } catch (error) {
      console.error("Webhook error:", error);
      return new Response("Internal error", { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    const due = await env.DB.prepare(
      `SELECT r.id,r.reminder_type,b.telegram_id
       FROM reminders r
       JOIN bookings b ON b.id=r.booking_id
       JOIN games g ON g.id=b.game_id
       WHERE r.sent=0 AND r.remind_at<=CURRENT_TIMESTAMP
         AND b.status='active' AND g.status='open'`
    ).all();

    for (const reminder of due.results) {
      await send(
        env,
        reminder.telegram_id,
        reminder.reminder_type === "24h"
          ? "⏰ Напоминаем: до игры осталось около 24 часов!"
          : "⏰ Напоминаем: игра скоро начнётся!"
      );

      await env.DB.prepare(
        "UPDATE reminders SET sent=1 WHERE id=?"
      ).bind(reminder.id).run();
    }
  }
};
