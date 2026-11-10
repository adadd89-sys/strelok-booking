
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
      "DELETE FROM games WHERE id=? AND status='pending'"
    ).bind(id).run();

    return send(env, chatId, `Игра ${id} отклонена и удалена из списка игр.`);
  }
}

async function handleChannelPost(env, post) {
  const text = post.text || post.caption || "";

  // Обрабатываем только посты, в названии/тексте которых есть нужный маркер открытой игры.
  // Регистр не важен; совпадение — отдельное слово, а не часть другого слова.
  const triggerPattern = /(?:^|[^\\p{L}\\p{N}_])(?:ВОСКРЕСКА|ВЕЧЕРКА)(?=$|[^\\p{L}\\p{N}_])/iu;
  if (!triggerPattern.test(text)) return;

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
        "⚠️ Найден пост с названием «ВОСКРЕСКА» или «ВЕЧЕРКА», но не удалось распознать дату или время.\nУкажи дату в формате ДД.ММ.ГГГГ и время ЧЧ:ММ."
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


async function verifyTelegramInitData(request, env) {
  const initData = request.headers.get("X-Telegram-Init-Data") || "";

  if (!initData || !env.TELEGRAM_BOT_TOKEN) return null;

  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get("hash");
    const authDate = Number(params.get("auth_date"));

    if (!receivedHash || !Number.isFinite(authDate)) return null;
    if (Math.abs(Date.now() / 1000 - authDate) > 86400) return null;

    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const encoder = new TextEncoder();

    const webAppDataKey = await crypto.subtle.importKey(
  "raw",
  encoder.encode("WebAppData"),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"]
);

const secretKey = await crypto.subtle.sign(
  "HMAC",
  webAppDataKey,
  encoder.encode(env.TELEGRAM_BOT_TOKEN)
);

    const dataKey = await crypto.subtle.importKey(
      "raw",
      secretKey,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const calculated = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        dataKey,
        encoder.encode(dataCheckString)
      )
    );

    const calculatedHash = [...calculated]
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");

    if (calculatedHash.length !== receivedHash.length) return null;

    let difference = 0;

    for (let i = 0; i < calculatedHash.length; i++) {
      difference |= calculatedHash.charCodeAt(i) ^
        receivedHash.toLowerCase().charCodeAt(i);
    }

    if (difference !== 0) return null;

    const userText = params.get("user");
    if (!userText) return null;

    const user = JSON.parse(userText);

    return user && user.id ? user : null;
  } catch (error) {
    console.error("Mini App authorization error:", error);
    return null;
  }
}

function miniJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

async function ensureMiniAppTables(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS order_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL,
      venue TEXT NOT NULL,
      game_type TEXT NOT NULL,
      game_date TEXT NOT NULL,
      game_time TEXT NOT NULL,
      participants INTEGER NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      comment TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Новая',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

async function ensureVenueTables(env){
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS venues(slug TEXT PRIMARY KEY,name TEXT NOT NULL,games TEXT NOT NULL,description TEXT DEFAULT '',address TEXT DEFAULT '',sort_order INTEGER DEFAULT 0)").run();
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS venue_photos(id INTEGER PRIMARY KEY AUTOINCREMENT,venue_slug TEXT NOT NULL,file_id TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP)").run();
 const venues=[
  ["bunker","Бункер","страйкбол, лазертаг",1,"ул. Академика Арбузова, 5, Казань (этаж цокольный) — Яндекс Карты: https://yandex.ru/profile/1397600367?lang=ru"],
  ["admiral","Адмирал","страйкбол, ребол, лазертаг",2,"улица 1 Мая, дом 5, 6 этаж"],
  ["glubokoe-ozero","Глубокое озеро","страйкбол, пейнтбол, лазертаг",3,"Территория Озеро Глубокое, Кировский район, Казань, Республика Татарстан (Татарстан)"]
 ];
 for(const x of venues){
  await env.DB.prepare("INSERT OR IGNORE INTO venues(slug,name,games,sort_order) VALUES(?,?,?,?)").bind(x[0],x[1],x[2],x[3]).run();
  await env.DB.prepare("UPDATE venues SET address=? WHERE slug=? AND (address IS NULL OR address='')").bind(x[4],x[0]).run();
 }
}
async function ensureGameFormatTables(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS game_formats(slug TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT DEFAULT '',equipment TEXT DEFAULT '',sort_order INTEGER DEFAULT 0)").run();
  const formats=[["airsoft","Страйкбол",1],["paintball","Пейнтбол",2],["reball","Ребол",3],["lasertag","Лазертаг",4],["hydroball","Гидробол с орбизами",5]];
  for(const x of formats) await env.DB.prepare("INSERT OR IGNORE INTO game_formats(slug,name,sort_order) VALUES(?,?,?)").bind(x[0],x[1],x[2]).run();
}
async function miniAppApi(request, env, url) {
  try {
    const user = await verifyTelegramInitData(request, env);

    if (!user) {
      return miniJson({ error: "Необходима авторизация Telegram" }, 401);
    }

    await ensureMiniAppTables(env);

    const uid = String(user.id);
    const method = request.method;
    const path = url.pathname;

    const readBody = async () => {
      try {
        return await request.json();
      } catch {
        return null;
      }
    };

    // Открытые игры
    if (path === "/api/games" && method === "GET") {
      const result = await env.DB.prepare(`
        SELECT g.*,
          COALESCE(SUM(
            CASE WHEN b.status = 'active'
            THEN b.participants ELSE 0 END
          ), 0) AS booked
        FROM games g
        LEFT JOIN bookings b ON b.game_id = g.id
        WHERE g.status = 'open'
          AND (
            g.game_date > date('now','localtime')
            OR (
              g.game_date = date('now','localtime')
              AND g.game_time >= time('now','localtime')
            )
          )
        GROUP BY g.id
        ORDER BY g.game_date, g.game_time
      `).all();

      return miniJson({ games: result.results || [] });
    }

    // Мои бронирования
    if (path === "/api/bookings" && method === "GET") {
      const result = await env.DB.prepare(`
        SELECT b.*, g.title, g.game_date, g.game_time, g.price
        FROM bookings b
        LEFT JOIN games g ON g.id = b.game_id
        WHERE b.telegram_id = ?
        ORDER BY b.created_at DESC
      `).bind(uid).all();

      return miniJson({ bookings: result.results || [] });
    }

    // Запись на открытую игру
    if (path === "/api/bookings" && method === "POST") {
      const body = await readBody();
      if (!body) return miniJson({ error: "Некорректные данные" }, 400);

      const gameId = Number(body.game_id);
      const participants = Number(body.participants);
      const name = String(body.organizer_name || "").trim();
      const phone = String(body.phone || "").trim();

      if (!Number.isInteger(gameId) || gameId < 1) {
  return miniJson({ error: "Ошибка: не определена игра" }, 400);
}

if (!Number.isInteger(participants) || participants < 1 || participants > 30) {
  return miniJson({ error: "Ошибка: количество участников должно быть от 1 до 30" }, 400);
}

if (!name) {
  return miniJson({ error: "Ошибка: не указано имя" }, 400);
}

if (!phone) {
  return miniJson({ error: "Ошибка: не указан телефон" }, 400);
}

      const game = await env.DB.prepare(`
        SELECT id, title FROM games
        WHERE id = ? AND status = 'open'
      `).bind(gameId).first();

      if (!game) return miniJson({ error: "Игра недоступна" }, 404);

      const existing = await env.DB.prepare(`
        SELECT id FROM bookings
        WHERE game_id = ? AND telegram_id = ? AND status = 'active'
      `).bind(gameId, uid).first();

      if (existing) {
        return miniJson({ error: "Вы уже записаны на эту игру" }, 409);
      }

      const inserted = await env.DB.prepare(`
        INSERT INTO bookings
          (game_id, telegram_id, organizer_name, phone, participants)
        VALUES (?, ?, ?, ?, ?)
      `).bind(gameId, uid, name, phone, participants).run();

      const bookingId = inserted.meta?.last_row_id;

      await env.DB.prepare(`
        INSERT INTO booking_history
          (booking_id, action, old_data, new_data)
        VALUES (?, 'created', NULL, ?)
      `).bind(
        bookingId,
        JSON.stringify({ game_id: gameId, participants, name, phone })
      ).run();

      await notifyAdmins(
        env,
        `Новая запись через Mini App\nИгра: ${escapeHtml(game.title)}\nИмя: ${escapeHtml(name)}\nТелефон: ${escapeHtml(phone)}\nУчастников: ${participants}`
      );

      return miniJson({ success: true, booking_id: bookingId });
    }

    // Отмена бронирования
    const cancelMatch = path.match(/^\/api\/bookings\/(\d+)$/);

    if (cancelMatch && method === "DELETE") {
      const bookingId = Number(cancelMatch[1]);

      const booking = await env.DB.prepare(`
        SELECT * FROM bookings
        WHERE id = ? AND telegram_id = ? AND status = 'active'
      `).bind(bookingId, uid).first();

      if (!booking) {
        return miniJson({ error: "Запись не найдена" }, 404);
      }

      await env.DB.prepare(`
        UPDATE bookings
        SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND telegram_id = ?
      `).bind(bookingId, uid).run();

      await env.DB.prepare(`
        INSERT INTO booking_history
          (booking_id, action, old_data, new_data)
        VALUES (?, 'cancelled', ?, NULL)
      `).bind(bookingId, JSON.stringify(booking)).run();

      await notifyAdmins(
        env,
        `Отмена записи через Mini App. Номер записи: ${bookingId}`
      );

      return miniJson({ success: true });
    }

    // Профиль пользователя
    if (path === "/api/profile" && method === "GET") {
      return miniJson({
        user: {
          id: user.id,
          first_name: user.first_name || "",
          last_name: user.last_name || "",
          username: user.username || ""
        }
      });
    }


if(path==="/api/venues"&&method==="GET"){await ensureVenueTables(env);const v=await env.DB.prepare("SELECT * FROM venues ORDER BY sort_order").all(),p=await env.DB.prepare("SELECT id,venue_slug FROM venue_photos").all();return miniJson({venues:(v.results||[]).map(x=>({...x,photos:(p.results||[]).filter(y=>y.venue_slug===x.slug).map(y=>"/venue-photo?id="+y.id)}))});}
if(path==="/api/admin/venues"&&method==="GET"){if(!(await isAdmin(env,uid)))return miniJson({error:"Нет доступа"},403);await ensureVenueTables(env);const v=await env.DB.prepare("SELECT * FROM venues ORDER BY sort_order").all(),p=await env.DB.prepare("SELECT id,venue_slug FROM venue_photos").all();return miniJson({venues:(v.results||[]).map(x=>({...x,photos:(p.results||[]).filter(y=>y.venue_slug===x.slug).map(y=>({id:y.id,url:"/venue-photo?id="+y.id}))}))});}
if(path.startsWith("/api/admin/venues/")&&method==="PUT"){if(!(await isAdmin(env,uid)))return miniJson({error:"Нет доступа"},403);await ensureVenueTables(env);const s=decodeURIComponent(path.split("/").pop()||""),b=await readBody();if(!["bunker","admiral","glubokoe-ozero"].includes(s)||!b)return miniJson({error:"Неверные данные"},400);const d=String(b.description||"").trim(),a=String(b.address||"").trim();if(d.length>5000||a.length>1000)return miniJson({error:"Слишком длинный текст"},400);await env.DB.prepare("UPDATE venues SET description=?,address=? WHERE slug=?").bind(d,a,s).run();return miniJson({success:true});}
if(path==="/api/admin/venues/photo"&&method==="POST"){if(!(await isAdmin(env,uid)))return miniJson({error:"Нет доступа"},403);await ensureVenueTables(env);const f=await request.formData(),s=String(f.get("venue_slug")||""),photo=f.get("photo");if(!["bunker","admiral","glubokoe-ozero"].includes(s)||!photo||typeof photo.arrayBuffer!=="function")return miniJson({error:"Не выбрана площадка или фотография"},400);if(!["image/jpeg","image/png","image/webp"].includes(photo.type)||photo.size>10*1024*1024)return miniJson({error:"Поддерживаются JPG, PNG и WebP до 10 МБ"},400);const up=new FormData();up.append("chat_id",String(env.OWNER_ID||"752535421"));up.append("photo",photo,photo.name||"venue-photo");const rr=await fetch(API(env.TELEGRAM_BOT_TOKEN,"sendPhoto"),{method:"POST",body:up}),t=await rr.json();if(!t.ok||!t.result?.photo?.length)return miniJson({error:"Telegram не принял фото. Сначала откройте диалог с ботом."},502);await env.DB.prepare("INSERT INTO venue_photos(venue_slug,file_id) VALUES(?,?)").bind(s,t.result.photo[t.result.photo.length-1].file_id).run();return miniJson({success:true});}
if(path.startsWith("/api/admin/venues/photo/")&&method==="DELETE"){if(!(await isAdmin(env,uid)))return miniJson({error:"Нет доступа"},403);await ensureVenueTables(env);const id=Number(path.split("/").pop());if(!Number.isInteger(id)||id<1)return miniJson({error:"Неверный идентификатор фото"},400);await env.DB.prepare("DELETE FROM venue_photos WHERE id=?").bind(id).run();return miniJson({success:true});}
    // Информация о клубе
    if(path==="/api/game-formats"&&method==="GET"){await ensureGameFormatTables(env);const r=await env.DB.prepare("SELECT slug,name,description,equipment FROM game_formats ORDER BY sort_order").all();return miniJson({formats:r.results||[]});}
    if(path==="/api/admin/game-formats"&&method==="GET"){if(!(await isAdmin(env,uid)))return miniJson({error:"Нет доступа"},403);await ensureGameFormatTables(env);const r=await env.DB.prepare("SELECT slug,name,description,equipment FROM game_formats ORDER BY sort_order").all();return miniJson({formats:r.results||[]});}
    if(path.startsWith("/api/admin/game-formats/")&&method==="PUT"){if(!(await isAdmin(env,uid)))return miniJson({error:"Нет доступа"},403);await ensureGameFormatTables(env);const slug=decodeURIComponent(path.split("/").pop()||"");const b=await readBody();if(!b||!["airsoft","paintball","reball","lasertag","hydroball"].includes(slug))return miniJson({error:"Неверные данные"},400);const description=String(b.description||"").trim(),equipment=String(b.equipment||"").trim();if(description.length>5000||equipment.length>5000)return miniJson({error:"Текст не должен превышать 5000 символов"},400);await env.DB.prepare("UPDATE game_formats SET description=?,equipment=? WHERE slug=?").bind(description,equipment,slug).run();return miniJson({success:true});}

    if (path === "/api/club" && method === "GET") {
      const club = await env.DB.prepare(`
        SELECT * FROM club_info ORDER BY id LIMIT 1
      `).first();

      return miniJson({ club: club || {} });
    }

    // Обновление информации о клубе — только администратор
    if (path === "/api/admin/club" && method === "PUT") {
      if (!(await isAdmin(env, uid))) return miniJson({ error: "Нет доступа" }, 403);

      const body = await readBody();
      if (!body || typeof body !== "object") {
        return miniJson({ error: "Некорректные данные" }, 400);
      }

      const fields = ["contacts", "telegram", "vk", "address", "rules", "age_restrictions"];
      const limits = {
        contacts: 500, telegram: 200, vk: 500,
        address: 1000, rules: 5000, age_restrictions: 1000
      };
      const values = {};
      for (const field of fields) {
        const value = String(body[field] ?? "").trim();
        if (value.length > limits[field]) {
          return miniJson({ error: "Слишком длинное значение: " + field }, 400);
        }
        values[field] = value;
      }

      const clubColumns = await env.DB.prepare("PRAGMA table_info(club_info)").all();
      const existingColumns = new Set((clubColumns.results || []).map(column => column.name));
      for (const [column, definition] of [
        ["telegram", "TEXT DEFAULT ''"],
        ["vk", "TEXT DEFAULT ''"]
      ]) {
        if (!existingColumns.has(column)) {
          await env.DB.prepare("ALTER TABLE club_info ADD COLUMN " + column + " " + definition).run();
        }
      }

      const existing = await env.DB.prepare(
        "SELECT id FROM club_info ORDER BY id LIMIT 1"
      ).first();

      if (existing?.id != null) {
        await env.DB.prepare(`
          UPDATE club_info
          SET contacts = ?, telegram = ?, vk = ?, address = ?, rules = ?, age_restrictions = ?
          WHERE id = ?
        `).bind(
          values.contacts, values.telegram, values.vk,
          values.address, values.rules, values.age_restrictions, existing.id
        ).run();
      } else {
        await env.DB.prepare(`
          INSERT INTO club_info
            (contacts, telegram, vk, address, rules, age_restrictions)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(
          values.contacts, values.telegram, values.vk,
          values.address, values.rules, values.age_restrictions
        ).run();
      }

      return miniJson({ success: true });
    }

    // Заявка на заказную игру
    if (path === "/api/order-requests" && method === "POST") {
      const body = await readBody();
      if (!body) return miniJson({ error: "Некорректные данные" }, 400);

      const venue = String(body.venue || "").trim();
      const gameType = String(body.game_type || "").trim();
      const gameDate = String(body.game_date || "").trim();
      const gameTime = String(body.game_time || "").trim();
      const participants = Number(body.participants);
      const name = String(body.name || "").trim();
      const phone = String(body.phone || "").trim();
      const comment = String(body.comment || "").trim();

      const allowed = {
        "Бункер": ["страйкбол", "лазертаг"],
        "Адмирал": ["страйкбол", "ребол", "лазертаг"],
        "Глубокое озеро": ["страйкбол", "пейнтбол", "лазертаг"]
      };

      if (!allowed[venue]) {
  return miniJson({ error: "Не выбрана или неверно указана площадка" }, 400);
}

if (!allowed[venue].includes(gameType)) {
  return miniJson({ error: "Не выбран или неверно указан тип игры" }, 400);
}

if (!/^\d{4}-\d{2}-\d{2}$/.test(gameDate)) {
  return miniJson({ error: "Неверно указана дата игры" }, 400);
}

if (!/^\d{2}:\d{2}$/.test(gameTime)) {
  return miniJson({ error: "Неверно указано время игры" }, 400);
}

if (!Number.isInteger(participants) || participants < 1 || participants > 100) {
  return miniJson({ error: "Количество участников должно быть от 1 до 100" }, 400);
}

if (!name) {
  return miniJson({ error: "Не указано имя" }, 400);
}

if (!phone) {
  return miniJson({ error: "Не указан телефон" }, 400);
}

      const result = await env.DB.prepare(`
        INSERT INTO order_requests
          (telegram_id, venue, game_type, game_date, game_time,
           participants, name, phone, comment)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        uid, venue, gameType, gameDate, gameTime,
        participants, name, phone, comment
      ).run();

      await notifyAdmins(
        env,
        `Новая заявка на игру!\nПлощадка: ${escapeHtml(venue)}\nИгра: ${escapeHtml(gameType)}\nДата: ${escapeHtml(gameDate)}\nВремя: ${escapeHtml(gameTime)}\nУчастников: ${participants}\nИмя: ${escapeHtml(name)}\nТелефон: ${escapeHtml(phone)}\nКомментарий: ${escapeHtml(comment)}`
      );

      return miniJson({
        success: true,
        request_id: result.meta?.last_row_id
      });
    }

    // Проверка прав администратора
    const role = await isAdmin(env, uid);

    if (path === "/api/admin" && method === "GET") {
      return miniJson({ isAdmin: !!role, role: role || null });
    }
        // Проверка доступа бота к каналу галереи
    if (path === "/api/admin/gallery/check" && method === "GET") {
      if (!role) return miniJson({ error: "Нет доступа" }, 403);

      if (!env.GALLERY_CHANNEL_ID) {
        return miniJson({ error: "Не задан ID канала" }, 500);
      }

      const chat = await tg(env, "getChat", {
        chat_id: env.GALLERY_CHANNEL_ID
      });

      if (!chat.ok) {
        return miniJson({
          error: "Бот не видит канал",
          details: chat.description || "Telegram не подтвердил доступ"
        }, 400);
      }

      const me = await tg(env, "getMe", {});
      if (!me.ok) {
        return miniJson({ error: "Не удалось получить данные бота" }, 500);
      }

      const member = await tg(env, "getChatMember", {
        chat_id: env.GALLERY_CHANNEL_ID,
        user_id: me.result.id
      });

      if (!member.ok) {
        return miniJson({
          error: "Не удалось проверить права бота",
          details: member.description || ""
        }, 400);
      }

      const canPost =
        member.result.status === "creator" ||
        (member.result.status === "administrator" &&
         member.result.can_post_messages === true);

      return miniJson({
        success: true,
        channel: chat.result.title || "Канал",
        bot_status: member.result.status,
        can_post_messages: canPost
      });
    }

    // Заявки на заказные игры
    if (path === "/api/admin/orders" && method === "GET") {
      if (!role) return miniJson({ error: "Нет доступа" }, 403);

      await env.DB.prepare(`
        DELETE FROM order_requests WHERE status = 'Отклонена'
      `).run();

      const result = await env.DB.prepare(`
        SELECT * FROM order_requests ORDER BY created_at DESC
      `).all();

      return miniJson({ orders: result.results || [] });
    }

    const orderMatch = path.match(/^\/api\/admin\/orders\/(\d+)$/);

    if (orderMatch && method === "PATCH") {
      if (!role) return miniJson({ error: "Нет доступа" }, 403);

      const body = await readBody();
      const status = String(body?.status || "");
      const allowedStatuses = [
        "Связались",
        "Подтверждена",
        "Отклонена"
      ];

      if (!allowedStatuses.includes(status)) {
        return miniJson({ error: "Недопустимый статус" }, 400);
      }

      let result;

      if (status === "Отклонена") {
        result = await env.DB.prepare(`
          DELETE FROM order_requests WHERE id = ?
        `).bind(Number(orderMatch[1])).run();
      } else {
        result = await env.DB.prepare(`
          UPDATE order_requests
          SET status = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(status, Number(orderMatch[1])).run();
      }

      if (!result.meta?.changes) {
        return miniJson({ error: "Заявка не найдена" }, 404);
      }

      return miniJson({ success: true, deleted: status === "Отклонена" });
    }

    return miniJson({ error: "Маршрут не найден" }, 404);

  } catch (error) {
    console.error("Mini App API error:", error);
    return miniJson({ error: "Внутренняя ошибка сервера" }, 500);
  }
}



async function publishScheduledOpenGamePost(env) {
  const channelId = env.POSTS_CHANNEL_ID || "@strelok_kzn";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Moscow",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  const weekday = p.weekday;
  const hour = Number(p.hour);
  const minute = Number(p.minute);

  // Cron runs every 15 minutes; publish only during the first quarter-hour after 10:00 MSK.
  if (hour !== 10 || minute >= 15) return;
  const isEvening = weekday === "Mon";
  const isSunday = weekday === "Thu";
  if (!isEvening && !isSunday) return;

  const offset = isEvening ? 2 : 3;
  const date = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + offset));
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const year = date.getUTCFullYear();
  const gameDate = `${year}-${month}-${day}`;
  const dateLabel = `${day}.${month}.${year}`;
  const title = isEvening ? "ВЕЧЕРКА" : "ВОСКРЕСКА";
  const gameTime = isEvening ? "19:00" : "09:30";

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS scheduled_channel_posts (
      game_date TEXT NOT NULL,
      post_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      telegram_message_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      published_at TEXT,
      PRIMARY KEY (game_date, post_type)
    )
  `).run();

  const claim = await env.DB.prepare(
    "INSERT OR IGNORE INTO scheduled_channel_posts (game_date,post_type,status) VALUES (?,?,'pending')"
  ).bind(gameDate, title).run();
  if (!claim.meta?.changes) return;

  const message =
    `🔥 ${title} | ОТКРЫТАЯ ИГРА\n\n` +
    `🎯 СТРАЙКБОЛ\n\n` +
    `📅 ${dateLabel}\n` +
    `🕒 Начало в ${gameTime}\n` +
    `⏱ Продолжительность — 3 часа\n\n` +
    `💰 Стоимость участия:\n` +
    `• Со своим оборудованием — 800 ₽\n` +
    `• С прокатом оборудования — 1 600 ₽\n\n` +
    `На базе есть хронограф для проверки оборудования, питьевая вода, санузел и другие удобства для игроков.\n\n` +
    `📝 Как записаться:\n` +
    `Перейдите в бота @StrelokBookingBot, нажмите «Бронирование игр» → «Открытые игры», заполните необходимые данные и отправьте заявку.\n\n` +
    `🔥 Ждём вас на игре клуба «Стрелок»!`;

  const result = await tg(env, "sendMessage", {
    chat_id: channelId,
    text: message,
    disable_web_page_preview: true
  });

  if (!result?.ok) {
    await env.DB.prepare(
      "UPDATE scheduled_channel_posts SET status='failed' WHERE game_date=? AND post_type=?"
    ).bind(gameDate, title).run();
    await notifyAdmins(env, `⚠️ Не удалось автоматически опубликовать пост ${title} на ${dateLabel}. Проверь права бота и настройки канала.`);
    return;
  }

  await env.DB.prepare(
    "UPDATE scheduled_channel_posts SET status='published',telegram_message_id=?,published_at=CURRENT_TIMESTAMP WHERE game_date=? AND post_type=?"
  ).bind(String(result.result.message_id), gameDate, title).run();
  await notifyAdmins(env, `✅ Пост ${title} на ${dateLabel} опубликован в канале @strelok_kzn.`);
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

    if(url.pathname==="/venue-photo"&&request.method==="GET"){const id=Number(url.searchParams.get("id"));if(!Number.isInteger(id)||id<1)return new Response("Not found",{status:404});const row=await env.DB.prepare("SELECT file_id FROM venue_photos WHERE id=?").bind(id).first();if(!row?.file_id)return new Response("Not found",{status:404});const f=await tg(env,"getFile",{file_id:row.file_id});if(!f.ok||!f.result?.file_path)return new Response("Photo unavailable",{status:502});const x=await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${f.result.file_path}`);if(!x.ok)return new Response("Photo unavailable",{status:502});return new Response(x.body,{headers:{"Content-Type":x.headers.get("Content-Type")||"image/jpeg","Cache-Control":"public, max-age=3600"}});}
    if (url.pathname.startsWith("/api/")) {
  return miniAppApi(request, env, url);
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
    await publishScheduledOpenGamePost(env);

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
