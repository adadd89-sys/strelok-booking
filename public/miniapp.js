
(() => {
  "use strict";

  const tg = window.Telegram?.WebApp;
  const API_BASE = "";
  const $ = (id) => document.getElementById(id);

  const state = {
    games: [],
    bookings: [],
    profile: null,
    club: null,
    admin: false,
    adminOrders: []
  };

  function initData() {
  return tg?.initData || "";
}

function checkTelegramAuth() {
  const data = initData();

  alert(
    "Проверка Telegram:\n" +
    "WebApp найден: " + Boolean(tg) + "\n" +
    "Данные авторизации получены: " + Boolean(data) + "\n" +
    "Длина данных: " + data.length
  );
}

  async function api(path, options = {}) {
    const headers = {
      "Content-Type": "application/json",
      "X-Telegram-Init-Data": initData(),
      ...(options.headers || {})
    };

    const response = await fetch(API_BASE + path, {
      ...options,
      headers
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.error) {
      throw new Error(data.error || data.message || "Ошибка сервера");
    }

    return data;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    })[char]);
  }

  function showMessage(container, message, isError = false) {
    if (!container) return;

    container.textContent = message;
    container.style.color = isError ? "#ff7777" : "#54c982";
  }

  function emptyMessage(message) {
    return `<div class="empty">${escapeHtml(message)}</div>`;
  }

  function formatDate(date) {
    if (!date) return "Дата не указана";

    const parsed = new Date(date + "T00:00:00");

    if (Number.isNaN(parsed.getTime())) return escapeHtml(date);

    return parsed.toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "long",
      year: "numeric"
    });
  }

  function getTelegramUser() {
    return tg?.initDataUnsafe?.user || null;
  }

  function userName(user) {
    if (!user) return "";

    return [
      user.first_name,
      user.last_name
    ].filter(Boolean).join(" ");
  }

  // ОТКРЫТЫЕ ИГРЫ

  async function loadGames() {
    const container = $("gamesList");
    if (!container) return;

    container.innerHTML = emptyMessage("Загружаем открытые игры...");

    try {
      const data = await api("/api/games");
      state.games = Array.isArray(data.games) ? data.games : [];

      if (!state.games.length) {
        container.innerHTML = emptyMessage("Пока нет открытых игр. Загляни позже!");
        return;
      }

      container.innerHTML = state.games.map(game => {
        const id = Number(game.id);
        const title = game.title || game.game_type || "Открытая игра";
        const date = game.game_date || game.date;
        const time = game.game_time || game.time || "";
        const booked = Number(game.booked || 0);
        const price = game.price ? `${escapeHtml(game.price)} ₽` : "Уточняется";

        return `
          <div class="card">
            <span class="status">● Запись открыта</span>
            <h3>${escapeHtml(title)}</h3>
            <p class="muted">📅 ${formatDate(date)}</p>
            <p class="muted">🕒 ${escapeHtml(time || "Время уточняется")}</p>
            <p class="muted">👥 Уже записалось: <b>${booked}</b></p>
            <p class="muted">💰 Цена: <b class="orange">${price}</b></p>
            ${game.description ? `<p class="muted">${escapeHtml(game.description)}</p>` : ""}
            <button class="primary" data-book-game="${id}">Записаться</button>
          </div>
        `;
      }).join("");

    } catch (error) {
      console.error("loadGames:", error);
      container.innerHTML = emptyMessage(
        "Не удалось загрузить игры. Возможно, серверная часть ещё подключается."
      );
    }
  }

      checkTelegramAuth();
  async function bookGame(gameId) {
    const game = state.games.find(item => Number(item.id) === gameId);

    if (!game) {
      alert("Игра не найдена. Обнови список.");
      return;
    }

    const user = getTelegramUser();
    const defaultName = userName(user);

    const name = prompt("Как тебя записать?", defaultName);
    if (!name || !name.trim()) return;

    const phone = prompt("Укажи номер телефона:");
    if (!phone || !phone.trim()) return;

    const participantsText = prompt("Сколько человек записать?", "1");
    if (participantsText === null) return;

    const participants = Number(participantsText);

    if (!Number.isInteger(participants) || participants < 1 || participants > 100) {
      alert("Укажи корректное количество участников от 1 до 100.");
      return;
    }

    try {
      await api("/api/bookings", {
        method: "POST",
        body: JSON.stringify({
          game_id: gameId,
          organizer_name: name.trim(),
          phone: phone.trim(),
          participants
        })
      });

      alert("Заявка на запись отправлена!");
      await loadGames();
      await loadBookings();

    } catch (error) {
      console.error("bookGame:", error);
      alert(error.message || "Не удалось записаться. Попробуй позже.");
    }
  }

  // МОИ БРОНИРОВАНИЯ

  async function loadBookings() {
    const container = $("bookingsList");
    if (!container) return;

    container.innerHTML = emptyMessage("Загружаем твои записи...");

    try {
      const data = await api("/api/bookings");
      state.bookings = Array.isArray(data.bookings) ? data.bookings : [];

      if (!state.bookings.length) {
        container.innerHTML = emptyMessage("У тебя пока нет бронирований.");
        return;
      }

      container.innerHTML = state.bookings.map(item => {
        const status = item.status || "active";
        const statusText = {
          active: "Активная запись",
          cancelled: "Отменена",
          completed: "Завершена"
        }[status] || status;

        return `
          <div class="card">
            <span class="status">${escapeHtml(statusText)}</span>
            <h3>${escapeHtml(item.title || item.game_title || "Игра")}</h3>
            <p class="muted">📅 ${formatDate(item.game_date)}</p>
            <p class="muted">🕒 ${escapeHtml(item.game_time || "")}</p>
            <p class="muted">👥 Участников: ${Number(item.participants || 1)}</p>
            ${status === "active" ? `
              <button class="secondary" data-cancel-booking="${Number(item.id)}">
                Отменить запись
              </button>
            ` : ""}
          </div>
        `;
      }).join("");

    } catch (error) {
      console.error("loadBookings:", error);
      container.innerHTML = emptyMessage("Не удалось загрузить бронирования.");
    }
  }

  async function cancelBooking(id) {
    if (!confirm("Точно отменить запись?")) return;

    try {
      await api("/api/bookings/" + id, {
        method: "DELETE"
      });

      alert("Запись отменена.");
      await loadBookings();
      await loadGames();

    } catch (error) {
      console.error("cancelBooking:", error);
      alert(error.message || "Не удалось отменить запись.");
    }
  }

  // ПРОФИЛЬ

  async function loadProfile() {
    const container = $("profileInfo");
    if (!container) return;

    try {
      const data = await api("/api/profile");
      const profile = data.user || data.profile || data;
      state.profile = profile;

      const telegramUser = getTelegramUser();

      const name =
        profile.first_name ||
        profile.name ||
        userName(telegramUser) ||
        "Пользователь Telegram";

      const username =
        profile.username ||
        telegramUser?.username ||
        "";

      container.innerHTML = `
        <h3>${escapeHtml(name)}</h3>
        <p class="muted">Telegram ID: ${escapeHtml(profile.telegram_id || telegramUser?.id || "—")}</p>
        ${username ? `<p class="muted">Username: @${escapeHtml(username)}</p>` : ""}
        <p class="muted">Здесь будет отображаться информация о твоём профиле.</p>
      `;

    } catch (error) {
      console.error("loadProfile:", error);
      container.innerHTML = emptyMessage("Не удалось загрузить профиль.");
    }
  }

  // О КЛУБЕ

  async function loadClub() {
    const container = $("clubInfo");
    if (!container) return;

    try {
      const data = await api("/api/club");
      const club = data.club || data;
      state.club = club;

      container.innerHTML = `
        <h3>Клуб «Стрелок»</h3>
        ${club.address ? `<p class="muted">📍 ${escapeHtml(club.address)}</p>` : ""}
        ${club.contacts ? `<p class="muted">☎️ ${escapeHtml(club.contacts)}</p>` : ""}
        ${club.age_restrictions ? `<p class="muted">🔞 ${escapeHtml(club.age_restrictions)}</p>` : ""}
        ${club.rules ? `<p class="muted">📋 ${escapeHtml(club.rules)}</p>` : ""}
        ${!club.address && !club.contacts && !club.rules
          ? `<p class="muted">Информация о клубе скоро появится.</p>`
          : ""}
      `;

    } catch (error) {
      console.error("loadClub:", error);
      container.innerHTML = emptyMessage("Информация о клубе пока недоступна.");
    }
  }

  // ЗАКАЗ ИГРЫ

  async function submitOrderRequest() {
    const message = $("orderMessage");
    const button = $("orderForm")?.querySelector('button[type="submit"]');

    const payload = {
      venue: $("orderVenue")?.value,
      game_type: $("orderType")?.value,
      game_date: $("orderDate")?.value,
      game_time: $("orderTime")?.value,
      participants: Number($("orderCount")?.value),
      name: $("orderName")?.value.trim(),
      phone: $("orderPhone")?.value.trim(),
      comment: $("orderComment")?.value.trim()
    };

    if (
      !payload.venue ||
      !payload.game_type ||
      !payload.game_date ||
      !payload.game_time ||
      !Number.isInteger(payload.participants) ||
      payload.participants < 1 ||
      !payload.name ||
      !payload.phone
    ) {
      showMessage(message, "Заполни все обязательные поля.", true);
      return;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (new Date(payload.game_date + "T00:00:00") < today) {
      showMessage(message, "Нельзя выбрать прошедшую дату.", true);
      return;
    }

    if (button) button.disabled = true;
    showMessage(message, "Отправляем заявку...");

    try {
      await api("/api/order-requests", {
        method: "POST",
        body: JSON.stringify(payload)
      });

      showMessage(
        message,
        "Заявка отправлена! Администратор свяжется с тобой для подтверждения."
      );

      $("orderForm").reset();
      $("orderType").disabled = true;
      $("orderType").innerHTML =
        '<option value="">Сначала выбери площадку</option>';

    } catch (error) {
      console.error("submitOrderRequest:", error);
      showMessage(message, error.message || "Не удалось отправить заявку.", true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  // АДМИНИСТРАТИВНЫЙ РАЗДЕЛ

  async function loadAdmin() {
    const info = $("adminInfo");
    const orders = $("adminOrders");

    if (!info) return;

    try {
      const data = await api("/api/admin");

      state.admin = Boolean(data.isAdmin);

      if (!state.admin) {
        info.innerHTML = emptyMessage("У тебя нет доступа к администрированию.");
        if (orders) orders.classList.add("hidden");

        $("adminHome")?.classList.add("hidden");
        return;
      }

      $("adminHome")?.classList.remove("hidden");

      info.innerHTML = `
        <span class="status">● Доступ разрешён</span>
        <h3>Панель администратора</h3>
        <p class="muted">Административный доступ подтверждён.</p>
      `;

      await loadAdminOrders();

    } catch (error) {
      console.error("loadAdmin:", error);
      info.innerHTML = emptyMessage("Не удалось проверить права администратора.");
    }
  }

  async function loadAdminOrders() {
    const container = $("adminOrders");
    if (!container || !state.admin) return;

    try {
      const data = await api("/api/admin/orders");
      state.adminOrders = Array.isArray(data.orders) ? data.orders : [];

      if (!state.adminOrders.length) {
        container.innerHTML = `
          <h3>Заявки на клиентские игры</h3>
          ${emptyMessage("Новых заявок пока нет.")}
        `;
        return;
      }

      container.innerHTML = `
        <h3>Заявки на клиентские игры</h3>
        ${state.adminOrders.map(order => `
          <div class="card">
            <span class="status">${escapeHtml(order.status || "Новая")}</span>
            <h3>${escapeHtml(order.venue)} — ${escapeHtml(order.game_type)}</h3>
            <p class="muted">📅 ${formatDate(order.game_date)}</p>
            <p class="muted">🕒 ${escapeHtml(order.game_time || "")}</p>
            <p class="muted">👥 Участников: ${Number(order.participants || 0)}</p>
            <p class="muted">👤 ${escapeHtml(order.name)}</p>
            <p class="muted">☎️ ${escapeHtml(order.phone)}</p>
            ${order.comment ? `<p class="muted">Комментарий: ${escapeHtml(order.comment)}</p>` : ""}
            <p class="muted">ID заявки: ${Number(order.id)}</p>
            <button class="secondary" data-order-status="${Number(order.id)}" data-status="Связались">
              Связались
            </button>
            <button class="secondary" data-order-status="${Number(order.id)}" data-status="Подтверждена">
              Подтвердить
            </button>
            <button class="secondary" data-order-status="${Number(order.id)}" data-status="Отклонена">
              Отклонить
            </button>
          </div>
        `).join("")}
      `;

    } catch (error) {
      console.error("loadAdminOrders:", error);
      container.innerHTML = `
        <h3>Заявки на клиентские игры</h3>
        ${emptyMessage("Не удалось загрузить заявки.")}
      `;
    }
  }

  async function updateOrderStatus(id, status) {
    if (!confirm("Изменить статус заявки на «" + status + "»?")) return;

    try {
      await api("/api/admin/orders/" + id, {
        method: "PATCH",
        body: JSON.stringify({ status })
      });

      alert("Статус заявки обновлён.");
      await loadAdminOrders();

    } catch (error) {
      console.error("updateOrderStatus:", error);
      alert(error.message || "Не удалось изменить статус.");
    }
  }

  // ПЕРЕКЛЮЧЕНИЕ РАЗДЕЛОВ

  window.loadMiniAppPage = function(page) {
    switch (page) {
      case "games":
        loadGames();
        break;
      case "bookings":
        loadBookings();
        break;
      case "profile":
        loadProfile();
        break;
      case "club":
        loadClub();
        break;
      case "admin":
        loadAdmin();
        break;
    }
  };

  // ОБРАБОТЧИКИ КНОПОК

  document.addEventListener("click", event => {
    const bookButton = event.target.closest("[data-book-game]");
    if (bookButton) {
      bookGame(Number(bookButton.dataset.bookGame));
      return;
    }

    const cancelButton = event.target.closest("[data-cancel-booking]");
    if (cancelButton) {
      cancelBooking(Number(cancelButton.dataset.cancelBooking));
      return;
    }

    const statusButton = event.target.closest("[data-order-status]");
    if (statusButton) {
      updateOrderStatus(
        Number(statusButton.dataset.orderStatus),
        statusButton.dataset.status
      );
    }
  });

  window.submitOrderRequest = submitOrderRequest;

  // СТАРТ

  if (tg) {
    tg.ready();
    tg.expand();

    try {
      tg.setHeaderColor("#111315");
      tg.setBackgroundColor("#111315");
    } catch (error) {}
  }

})();
