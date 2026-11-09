
(() => {
  const tg = window.Telegram?.WebApp;
  const initData = tg?.initData || "";

  const $ = (id) => document.getElementById(id);

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[char]));
  }

  async function api(path) {
    const response = await fetch(path, {
      method: "GET",
      headers: {
        "X-Telegram-Init-Data": initData
      }
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.ok === false) {
      throw new Error(data.error || "Не удалось загрузить данные");
    }

    return data;
  }

  function setContent(pageId, html) {
    const page = $(pageId);
    if (!page) return;

    page.querySelectorAll(".dynamic-content").forEach((element) => {
      element.remove();
    });

    const block = document.createElement("div");
    block.className = "dynamic-content";
    block.innerHTML = html;

    page.appendChild(block);
  }

  function loading(pageId, message = "Загружаем данные…") {
    setContent(
      pageId,
      `<div class="info-card empty">${escapeHtml(message)}</div>`
    );
  }

  function showError(pageId, error) {
    setContent(
      pageId,
      `<div class="info-card empty">
        ⚠️ ${escapeHtml(error.message || error)}
        <br><br>
        <button class="miniapp-retry"
          onclick="window.StrelokMiniApp.reloadCurrent()">
          Повторить
        </button>
      </div>`
    );
  }

  // ОТКРЫТЫЕ ИГРЫ

  async function loadGames() {
    loading("games");

    try {
      const data = await api("/api/games");
      const games = Array.isArray(data.games) ? data.games : [];

      if (!games.length) {
        setContent(
          "games",
          `<div class="info-card empty">
            Сейчас нет открытых игр. Загляни позже!
          </div>`
        );
        return;
      }

      const html = games.map((game) => `
        <article class="info-card game-card">
          <h2>${escapeHtml(game.title || "Открытая игра")}</h2>

          <p>
            📅 ${escapeHtml(game.date || game.game_date || "Дата уточняется")}
          </p>

          <p>
            🕒 ${escapeHtml(game.time || game.game_time || "")}
          </p>

          <p>
            💰 ${escapeHtml(game.price || "Цена уточняется")}
          </p>

          <p>
            👥 Уже записались:
            <b>${escapeHtml(game.booked ?? 0)}</b>
          </p>

          ${
            game.description
              ? `<p>${escapeHtml(game.description)}</p>`
              : ""
          }
        </article>
      `).join("");

      setContent("games", html);

    } catch (error) {
      showError("games", error);
    }
  }

  // МОИ БРОНИРОВАНИЯ

  async function loadBookings() {
    loading("bookings");

    try {
      const data = await api("/api/bookings");
      const bookings = Array.isArray(data.bookings)
        ? data.bookings
        : [];

      if (!bookings.length) {
        setContent(
          "bookings",
          `<div class="info-card empty">
            У тебя пока нет активных записей.
          </div>`
        );
        return;
      }

      const html = bookings.map((booking) => `
        <article class="info-card">
          <h2>${escapeHtml(booking.title || "Игра")}</h2>

          <p>
            📅 ${escapeHtml(booking.date || booking.game_date || "")}
          </p>

          <p>
            🕒 ${escapeHtml(booking.time || booking.game_time || "")}
          </p>

          <p>
            👥 Участников:
            <b>${escapeHtml(booking.participants)}</b>
          </p>

          <p>
            Организатор:
            ${escapeHtml(booking.organizer_name || "")}
          </p>
        </article>
      `).join("");

      setContent("bookings", html);

    } catch (error) {
      showError("bookings", error);
    }
  }

  // ПРОФИЛЬ

  async function loadProfile() {
    loading("profile");

    try {
      const data = await api("/api/profile");
      const user = data.user || data.profile || {};

      setContent(
        "profile",
        `<div class="info-card">
          <p>
            <b>${escapeHtml(
              user.name || user.first_name || "Игрок"
            )}</b>
          </p>

          ${
            user.username
              ? `<p>Telegram: @${escapeHtml(user.username)}</p>`
              : ""
          }

          <p>
            ID: ${escapeHtml(user.id || user.telegram_id || "")}
          </p>
        </div>`
      );

    } catch (error) {
      showError("profile", error);
    }
  }

  // ИНФОРМАЦИЯ О КЛУБЕ

  async function loadClub() {
    loading("club");

    try {
      const data = await api("/api/club");
      const club = data.club || data;

      const html = `
        <div class="info-card">

          ${
            club.address
              ? `<p><b>Адрес:</b><br>${escapeHtml(club.address)}</p>`
              : ""
          }

          ${
            club.contacts
              ? `<p><b>Контакты:</b><br>${escapeHtml(club.contacts)}</p>`
              : ""
          }

          ${
            club.age_restrictions
              ? `<p><b>Возрастные ограничения:</b><br>
                  ${escapeHtml(club.age_restrictions)}</p>`
              : ""
          }

          ${
            club.rules
              ? `<p><b>Правила:</b><br>${escapeHtml(club.rules)}</p>`
              : ""
          }

          ${
            !club.address &&
            !club.contacts &&
            !club.rules
              ? "Информация пока не заполнена."
              : ""
          }

        </div>
      `;

      setContent("club", html);

    } catch (error) {
      showError("club", error);
    }
  }

  // АДМИНИСТРИРОВАНИЕ

  async function loadAdmin() {
    loading("admin");

    try {
      const data = await api("/api/admin");

      if (!data.isAdmin) {
        setContent(
          "admin",
          `<div class="info-card empty">
            Раздел доступен только администраторам клуба.
          </div>`
        );
        return;
      }

      setContent(
        "admin",
        `<div class="info-card">
          <h2>Доступ администратора подтверждён</h2>
          <p>
            Управление играми пока выполняется через Telegram-бота.
          </p>
        </div>`
      );

    } catch (error) {
      showError("admin", error);
    }
  }

  // ЗАГРУЗЧИКИ РАЗДЕЛОВ

  const loaders = {
    games: loadGames,
    bookings: loadBookings,
    profile: loadProfile,
    club: loadClub,
    admin: loadAdmin
  };

  let currentPage = "home";

  const originalShowPage = window.showPage;

  window.showPage = function(page, button) {
    currentPage = page;

    if (typeof originalShowPage === "function") {
      originalShowPage(page, button);
    }

    if (loaders[page]) {
      loaders[page]();
    }
  };

  // КНОПКА ПОВТОРНОЙ ЗАГРУЗКИ

  window.StrelokMiniApp = {
    reloadCurrent() {
      if (loaders[currentPage]) {
        loaders[currentPage]();
      }
    }
  };

  // НАСТРОЙКИ TELEGRAM MINI APP

  if (tg) {
    tg.ready();
    tg.expand();
    tg.setHeaderColor("#101010");
    tg.setBackgroundColor("#101010");
  }

})();
