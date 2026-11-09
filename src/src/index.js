
const API = (token, method) =>
  `https://api.telegram.org/bot${token}/${method}`;

async function tg(env, method, data = {}) {
  const response = await fetch(API(env.TELEGRAM_BOT_TOKEN, method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  return response.json();
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

async function state(env, id, value, data = {}) {
  await env.DB.prepare(
    `INSERT INTO user_states (telegram_id,state,data)
     VALUES (?,?,?)
     ON CONFLICT(telegram_id) DO UPDATE SET
     state=excluded.state,data=excluded.data,updated_at=CURRENT_TIMESTAMP`
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

function parseGame(text) {
  const date = text.match(/\b(\d{2}\.\d{2}\.\d{4})\b/);
  const time = text.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/);
  const price = text.match(/(\d[\d ]*)\s*₽/i);
  if (!date || !time) return null;

  const [day, month, year] = date[1].split(".");
  return {
    date: `${year}-${month}-${day}`,
    time: time[0],
    price: price ? `${price[1].trim()} ₽` : "Уточняется",
    description: text.slice(0, 3500)
  };
}

async function showGames(env, chatId) {
  const rows = await env.DB.prepare(
    `SELECT g.*,
      COALESCE(SUM(CASE WHEN b.status='active' THEN b.participants ELSE 0 END),0) AS booked
     FROM games g LEFT JOIN bookings b ON b.game_id=g.id
     WHERE g.status='open' AND
       (g.game_date > date('now') OR
       (g.game_date = date('now') AND g.game_time >= time('now')))
     GROUP BY g.id ORDER BY g.game_date,g.game_time`
  ).all();

  if (!rows.results.length) {
    return send(env, chatId, "Пока нет опубликованных открытых игр.", mainMenu);
  }

  for (const g of rows.results) {
    const date = g.game_date.split("-").reverse().join(".");
    await send(env, chatId,
      `🎯 <b>${g.title}</b>\n\n📅 ${date}\n🕒 ${g.game_time}\n💰 ${g.price || "Уточняется"}\n👥 Записано: ${g.booked}\n\n${g.description || ""}`,
      { inline_keyboard: [[{ text: "Записаться", callback_data: `book:${g.id}` }]] }
    );
  }
}

async function showMyBookings(env, chatId, userId) {
  const rows = await env.DB.prepare(
    `SELECT b.*,g.title,g.game_date,g.game_time
     FROM bookings b JOIN games g ON g.id=b.game_id
     WHERE b.telegram_id=? AND b.status='active'
     ORDER BY g.game_date,g.game_time`
  ).bind(String(userId)).all();

  if (!rows.results.length) {
    return send(env, chatId, "У тебя пока нет активных записей.", mainMenu);
  }

  for (const b of rows.results) {
    await send(env, chatId,
      `🎯 ${b.title}\n📅 ${b.game_date.split("-").reverse().join(".")} в ${b.game_time}\n👤 ${b.organizer_name}\n📞 ${b.phone}\n👥 Участников: ${b.participants}`,
      { inline_keyboard: [
        [{ text: "Изменить количество", callback_data: `edit:${b.id}` }],
        [{ text: "Отменить запись", callback_data: `cancel:${b.id}` }]
      ]}
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
    return send(env, chatId,
      "Добро пожаловать в клуб «Стрелок»!\nЗдесь можно посмотреть открытые игры и записаться на участие.",
      mainMenu
    );
  }

  if (text === "🎯 Открытые игры") return showGames(env, chatId);
  if (text === "📝 Мои записи") return showMyBookings(env, chatId, userId);

  if (text === "ℹ️ Информация о клубе") {
    const info = await env.DB.prepare(
      "SELECT * FROM club_info ORDER BY id DESC LIMIT 1"
    ).first();
    return send(env, chatId,
      info
        ? `ℹ️ <b>Информация о клубе</b>\n\n📍 ${info.address || "Не указано"}\n☎️ ${info.contacts || "Не указано"}\n\n📋 ${info.rules || "Правила уточняйте у организатора"}\n\n🔞 ${info.age_restrictions || "Возрастные ограничения уточняйте у организатора"}` 
        : "Информация о клубе пока не добавлена.",
      mainMenu
    );
  }

  const current = await getState(env, userId);
  if (!current) return;

  const data = JSON.parse(current.data || "{}");

  if (current.state === "name") {
    await state(env, userId, "phone", { ...data, name: text });
    return send(env, chatId, "Теперь введи номер телефона организатора.");
  }

  if (current.state === "phone") {
    await state(env, userId, "count", { ...data, phone: text });
    return send(env, chatId, "Сколько всего человек будет в вашей группе? Введи число.");
  }

  if (current.state === "count") {
    const count = Number(text);
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      return send(env, chatId, "Введи целое число от 1 до 100.");
    }

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
    ).bind(data.gameId, String(userId), data.name, data.phone, count).run();

    await env.DB.prepare(
      `INSERT INTO booking_history (booking_id,action,new_data)
       VALUES (?,'created',?)`
    ).bind(result.meta.last_row_id, JSON.stringify({
      name: data.name, phone: data.phone, participants: count
    })).run();

    await clearState(env, userId);

    const admins = await env.DB.prepare(
      "SELECT telegram_id FROM admins"
    ).all();

    const adminIds = [String(env.OWNER_ID), ...admins.results.map(a => a.telegram_id)];
    for (const adminId of [...new Set(adminIds)]) {
      await send(env, adminId,
        `📝 Новая запись!\nИгра ID: ${data.gameId}\nОрганизатор: ${data.name}\nТелефон: ${data.phone}\nУчастников: ${count}`
      );
    }

    return send(env, chatId, "✅ Запись принята! Ждём тебя на игре.", mainMenu);
  }
}

async function handleCallback(env, query) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data || "";

  await tg(env, "answerCallbackQuery", { callback_query_id: query.id });

  if (data.startsWith("book:")) {
    return startBooking(env, chatId, userId, Number(data.split(":")[1]));
  }

  if (data.startsWith("cancel:")) {
    const id = Number(data.split(":")[1]);
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

    const admins = await env.DB.prepare(
      "SELECT telegram_id FROM admins"
    ).all();
    for (const adminId of [String(env.OWNER_ID), ...admins.results.map(a => a.telegram_id)]) {
      await send(env, adminId, `❌ Отмена записи ID ${id}. Участников: ${booking.participants}`);
    }
    return;
  }

  if (data.startsWith("edit:")) {
    const id = Number(data.split(":")[1]);
    const booking = await env.DB.prepare(
      "SELECT id FROM bookings WHERE id=? AND telegram_id=? AND status='active'"
    ).bind(id, String(userId)).first();

    if (!booking) return send(env, chatId, "Активная запись не найдена.");
    await state(env, userId, "edit_count", { bookingId: id });
    return send(env, chatId, "Введи новое общее количество участников.");
  }

  if (data.startsWith("approve:") || data.startsWith("reject:")) {
    if (!(await isAdmin(env, userId))) return send(env, chatId, "Недостаточно прав.");
    const [action, idText] = data.split(":");
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
  const recipients = [String(env.OWNER_ID), ...admins.results.map(a => a.telegram_id)];

  if (!parsed) {
    for (const id of [...new Set(recipients)]) {
      await send(env, id,
        "⚠️ Найден пост с #открытаяигра, но не удалось распознать дату или время.\nУкажи дату в формате ДД.ММ.ГГГГ и время ЧЧ:ММ."
      );
    }
    return;
  }

  const result = await env.DB.prepare(
    `INSERT INTO games
     (description,game_date,game_time,price,status,channel_message_id)
     VALUES (?,?,?,?,'pending',?)`
  ).bind(parsed.description, parsed.date, parsed.time, parsed.price, String(post.message_id)).run();

  for (const id of [...new Set(recipients)]) {
    await send(env, id,
      `🔎 <b>Найдена новая открытая игра</b>\n\n📅 ${parsed.date}\n🕒 ${parsed.time}\n💰 ${parsed.price}\n\n${parsed.description}`,
      { inline_keyboard: [[
        { text: "Подтвердить", callback_data: `approve:${result.meta.last_row_id}` },
        { text: "Отклонить", callback_data: `reject:${result.meta.last_row_id}` }
      ]]}
    );
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/setup" && request.method === "GET") {
      if (!url.searchParams.get("key") ||
          url.searchParams.get("key") !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const webhookUrl = `${url.origin}/telegram`;
      const result = await tg(env, "setWebhook", {
        url: webhookUrl,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query", "channel_post"]
      });
      return Response.json(result);
    }

    if (url.pathname !== "/telegram") {
      return new Response("Strelok bot is running");
    }

    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }

    const update = await request.json();

    if (update.message) await handleMessage(env, update.message);
    if (update.callback_query) await handleCallback(env, update.callback_query);
    if (update.channel_post) await handleChannelPost(env, update.channel_post);

    return new Response("OK");
  },

  async scheduled(event, env, ctx) {
    const due = await env.DB.prepare(
      `SELECT r.id,r.reminder_type,b.telegram_id,g.game_date,g.game_time
       FROM reminders r
       JOIN bookings b ON b.id=r.booking_id
       JOIN games g ON g.id=b.game_id
       WHERE r.sent=0 AND r.remind_at<=CURRENT_TIMESTAMP
       AND b.status='active' AND g.status='open'`
    ).all();

    for (const r of due.results) {
      await send(env, r.telegram_id,
        r.reminder_type === "24h"
          ? "⏰ Напоминаем: до игры осталось около 24 часов!"
          : "⏰ Напоминаем: игра скоро начнётся!"
      );
      await env.DB.prepare(
        "UPDATE reminders SET sent=1 WHERE id=?"
      ).bind(r.id).run();
    }
  }
};
