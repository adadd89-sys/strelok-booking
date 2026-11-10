
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
    adminOrders: [], venues: [], activeVenue: null
  };

  function initData() {
  return tg?.initData || "";
}



  async function api(path, options = {}) {
    const headers = {
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
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

  function formatMultiline(value) {
    return escapeHtml(value).replace(/\r?\n/g, "<br>");
  }

  function formatParagraphs(value) {
    return String(value ?? "")
      .trim()
      .split(/\r?\n\s*\r?\n/)
      .filter(paragraph => paragraph.trim())
      .map(paragraph => `<p class="game-description-paragraph">${escapeHtml(paragraph.trim()).replace(/\r?\n/g, "<br>")}</p>`)
      .join("");
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


  let galleryFilter = "all";
  async function loadGallery() {
    const list = $("galleryList");
    if (!list) return;
    list.innerHTML = emptyMessage("Загружаем галерею...");
    try {
      const data = await api("/api/gallery?type=" + encodeURIComponent(galleryFilter));
      const groups = Array.isArray(data.items) ? data.items : [];
      if (!groups.length) {
        list.innerHTML = emptyMessage("Пока в галерее нет публикаций. Новые фото и видео появятся здесь автоматически.");
        return;
      }
      list.innerHTML = '<div class="gallery-grid">' + groups.map(group => {
        const media = group.items.map(item => item.type === "video"
          ? `<video controls playsinline preload="metadata" src="${escapeHtml(item.url)}"></video>`
          : `<img loading="lazy" src="${escapeHtml(item.url)}" alt="Фото с игры">`).join("");
        return `<article class="gallery-card">${group.items.length > 1 ? `<div class="gallery-album">${media}</div>` : media}${group.caption ? `<div class="gallery-caption">${escapeHtml(group.caption)}</div>` : ""}</article>`;
      }).join("") + "</div>";
    } catch (error) {
      console.error("loadGallery:", error);
      list.innerHTML = emptyMessage("Не удалось загрузить галерею. Попробуй обновить страницу.");
    }
  }

  // ОПИСАНИЕ ФОРМАТОВ ИГР
  const gameFormatNames = {airsoft:"Страйкбол",paintball:"Пейнтбол",reball:"Ребол",lasertag:"Лазертаг",hydroball:"Гидробол с орбизами"};
  let gameFormats = [];
  let activeGameFormat = null;

  async function loadGameFormats() {
    const list = $("gameFormatsList");
    if (!list) return;
    try {
      const data = await api("/api/game-formats");
      gameFormats = Array.isArray(data.formats) ? data.formats : [];
      list.hidden = false;
      list.innerHTML = gameFormats.map(f => `<button class="secondary" style="width:100%;text-align:left" data-open-game-format="${escapeHtml(f.slug)}">🎮 <b>${escapeHtml(f.name)}</b><span class="muted" style="display:block">Описание и комплект участника</span></button>`).join("");
      if (activeGameFormat) renderGameFormat(activeGameFormat);
    } catch (e) {
      list.innerHTML = emptyMessage("Не удалось загрузить описание игр.");
    }
  }

  function renderGameFormat(slug) {
    const item = gameFormats.find(x => x.slug === slug);
    const box = $("gameFormatDetails");
    const list = $("gameFormatsList");
    if (!item || !box || !list) return;
    activeGameFormat = slug;
    list.hidden = true;
    box.hidden = false;
    box.innerHTML = `<button class="back" type="button" data-game-formats-back>← Все форматы</button><h3>🎮 ${escapeHtml(item.name)}</h3><h4>Об игре</h4><div class="muted">${item.description ? formatMultiline(item.description) : "Описание пока не добавлено."}</div><h4 style="margin-top:20px">Что выдаём перед игрой</h4><div class="muted">${item.equipment ? formatMultiline(item.equipment) : "Информация о комплекте пока не добавлена."}</div>`;
  }

  async function loadAdminGameFormats() {
    const box = $("adminGameFormatsEditor");
    if (!box || !state.admin) return;
    try {
      const data = await api("/api/admin/game-formats");
      box.innerHTML = "<h3>Описание форматов игр</h3>" + (data.formats || []).map(f => `<form data-game-format-form="${escapeHtml(f.slug)}"><h4>${escapeHtml(f.name)}</h4><div class="field"><label>Описание игры</label><textarea name="description" rows="5" maxlength="5000" placeholder="Расскажи, как проходит игра...">${escapeHtml(f.description || "")}</textarea></div><div class="field"><label>Что выдаём участникам перед игрой</label><textarea name="equipment" rows="4" maxlength="5000" placeholder="Перечисли оборудование, экипировку и защиту...">${escapeHtml(f.equipment || "")}</textarea></div><button class="primary" type="submit">Сохранить</button><p class="muted" id="game-format-msg-${escapeHtml(f.slug)}"></p></form><hr>`).join("");
    } catch (e) {
      box.innerHTML = emptyMessage("Не удалось загрузить форматы игр для редактирования: " + (e.message || ""));
    }
  }

  async function saveGameFormat(event) {
    event.preventDefault();
    const form = event.target;
    const slug = form.dataset.gameFormatForm;
    const message = $("game-format-msg-" + slug);
    const button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = true;
    try {
      await api("/api/admin/game-formats/" + encodeURIComponent(slug), {method:"PUT",body:JSON.stringify({description:form.elements.description.value,equipment:form.elements.equipment.value})});
      showMessage(message, "Сохранено.");
      await loadGameFormats();
    } catch (e) {
      showMessage(message, e.message || "Не удалось сохранить.", true);
    } finally {
      if (button) button.disabled = false;
    }
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
            ${game.description ? `<div class="muted game-description">${formatParagraphs(game.description)}</div>` : ""}
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

  let pendingGameId = null;

  function openBookingModal(gameId) {
    const game = state.games.find(item => Number(item.id) === gameId);
    const modal = $("bookingModal");
    const form = $("bookingForm");
    const message = $("bookingMessage");
    if (!game || !modal || !form) return;
    pendingGameId = gameId;
    form.reset();
    const user = getTelegramUser();
    form.elements.organizer_name.value = userName(user);
    message.textContent = "";
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    setTimeout(() => form.elements.organizer_name.focus(), 50);
  }

  function closeBookingModal() {
    const modal = $("bookingModal");
    if (modal) modal.hidden = true;
    document.body.style.overflow = "";
    pendingGameId = null;
  }

  async function submitBooking(event) {
    event.preventDefault();
    const form = $("bookingForm");
    const button = form.querySelector('button[type="submit"]');
    const message = $("bookingMessage");
    const name = form.elements.organizer_name.value.trim();
    const phone = form.elements.phone.value.trim();
    const participants = Number(form.elements.participants.value);

    if (!name || !phone || !Number.isInteger(participants) || participants < 1 || participants > 100) {
      showMessage(message, "Проверь заполнение всех полей.", true);
      return;
    }

    if (button) button.disabled = true;
    showMessage(message, "Отправляем заявку...");
    try {
      await api("/api/bookings", {
        method: "POST",
        body: JSON.stringify({
          game_id: pendingGameId,
          organizer_name: name,
          phone,
          participants
        })
      });
      showMessage(message, "Заявка на запись отправлена!");
      await loadGames();
      await loadBookings();
      setTimeout(closeBookingModal, 1100);
    } catch (error) {
      showMessage(message, error.message || "Не удалось записаться. Попробуй позже.", true);
    } finally {
      if (button) button.disabled = false;
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


async function loadVenues(){try{const d=await api("/api/venues");state.venues=d.venues||[];const l=$("venuesList");if(l)l.innerHTML=state.venues.map(v=>`<button class="secondary" style="width:100%;margin:6px 0;text-align:left" data-open-venue="${escapeHtml(v.slug)}"><b>${escapeHtml(v.name)}</b><br><span class="muted">${escapeHtml(v.games)}</span></button>`).join("");if(state.activeVenue)renderVenueDetails(state.activeVenue);}catch(e){const l=$("venuesList");if(l)l.innerHTML=emptyMessage("Не удалось загрузить площадки.");}}
function renderVenueDetails(s){const v=state.venues.find(x=>x.slug===s),d=$("venueDetails"),l=$("venuesList");if(!v||!d)return;state.activeVenue=s;if(l)l.hidden=true;d.hidden=false;const p=v.photos||[];d.innerHTML=`<button class="back" type="button" data-venues-back>← Все площадки</button><h3>${escapeHtml(v.name)}</h3><p class="muted">🎮 ${escapeHtml(v.games)}</p><div>${p.length?p.map(x=>`<img src="${escapeHtml(x)}" alt="${escapeHtml(v.name)}" style="width:100%;max-height:260px;object-fit:cover;border-radius:12px;margin:5px 0">`).join(""):'<p class="muted">Фотографии пока не добавлены.</p>'}</div><p>${formatMultiline(v.description||"Описание пока не добавлено.")}</p><p class="muted">📍 ${escapeHtml(v.address||"Адрес пока не добавлен.")}</p>`;}
async function loadAdminVenues(){const box=$("adminVenuesEditor");if(!box||!state.admin)return;try{const d=await api("/api/admin/venues");state.venues=d.venues||[];box.innerHTML='<h3>Редактирование площадок</h3>'+state.venues.map(v=>`<form data-venue-form="${escapeHtml(v.slug)}"><h4>${escapeHtml(v.name)} — ${escapeHtml(v.games)}</h4><label>Описание</label><textarea name="description" rows="3" maxlength="5000">${escapeHtml(v.description||"")}</textarea><label>Адрес</label><textarea name="address" rows="2" maxlength="1000">${escapeHtml(v.address||"")}</textarea><button class="primary" type="submit">Сохранить площадку</button><label>Фотографии (JPG, PNG или WebP, до 10 МБ каждая)</label><input type="file" accept="image/jpeg,image/png,image/webp" multiple data-venue-upload="${escapeHtml(v.slug)}"><div>${(v.photos||[]).map(p=>`<span style="display:inline-block;margin:5px"><img src="${escapeHtml(p.url)}" style="width:90px;height:70px;object-fit:cover;border-radius:8px"><button type="button" data-delete-venue-photo="${p.id}">Удалить</button></span>`).join("")||'<p class="muted">Фотографии пока не добавлены.</p>'}</div><p class="muted" id="venue-msg-${escapeHtml(v.slug)}"></p></form><hr>`).join("");}catch(e){console.error("loadAdminVenues:",e);box.innerHTML=emptyMessage("Не удалось загрузить площадки для редактирования: "+(e?.message||"неизвестная ошибка"));}}
async function saveVenue(e){e.preventDefault();const f=e.target,s=f.dataset.venueForm,m=$("venue-msg-"+s);try{await api("/api/admin/venues/"+encodeURIComponent(s),{method:"PUT",body:JSON.stringify({description:f.elements.description.value.trim(),address:f.elements.address.value.trim()})});showMessage(m,"Сохранено.");await loadVenues();}catch(x){showMessage(m,x.message,true);}}
async function uploadVenuePhotos(i){const s=i.dataset.venueUpload,files=Array.from(i.files||[]),m=$("venue-msg-"+s);if(!files.length)return;try{for(const file of files){const f=new FormData();f.append("venue_slug",s);f.append("photo",file);await api("/api/admin/venues/photo",{method:"POST",body:f});}showMessage(m,"Фотографии загружены.");await loadAdminVenues();await loadVenues();}catch(e){showMessage(m,e.message,true);}finally{i.value="";}}
  async function loadClub() {
    const container = $("clubInfo");
    if (!container) return;

    try {
      const data = await api("/api/club");
      const club = data.club || data;
      state.club = club;

      window.CLUB_TELEGRAM_USERNAME = String(club.telegram || "").trim().replace(/^@/, "").replace("https://t.me/", "").replace("http://t.me/", "");
      const contactsPage = $("contacts");
      const contactCard = contactsPage?.querySelector(".card");
      if (contactCard) {
        contactCard.innerHTML = `
          <h3>Связаться с клубом «Стрелок»</h3>
          <p class="muted">По вопросам игр, бронирования и организации мероприятий.</p>
          ${club.contacts ? `<p class="muted">☎️ ${escapeHtml(club.contacts)}</p>` : ""}
          ${club.telegram ? `<p class="muted">✈️ <a href="https://t.me/${escapeHtml(window.CLUB_TELEGRAM_USERNAME)}" target="_blank" rel="noopener">Telegram</a></p>` : ""}
          ${club.vk ? `<p class="muted">🔵 <a href="${escapeHtml(club.vk)}" target="_blank" rel="noopener">ВКонтакте</a></p>` : ""}
          ${club.address ? `<p class="muted">📍 ${escapeHtml(club.address)}</p>` : ""}
          ${!club.contacts && !club.telegram && !club.vk ? `<p class="muted">Контактная информация скоро появится.</p>` : ""}
        `;
      }

      container.innerHTML = `
        <h3>Клуб «Стрелок»</h3>
        ${club.address ? `<p class="muted">📍 ${escapeHtml(club.address)}</p>` : ""}
        ${club.contacts ? `<p class="muted">☎️ ${escapeHtml(club.contacts)}</p>` : ""}
        ${club.telegram ? `<p class="muted">✈️ Telegram: ${escapeHtml(club.telegram)}</p>` : ""}
        ${club.vk ? `<p class="muted">🔵 ВКонтакте: ${escapeHtml(club.vk)}</p>` : ""}
        ${club.age_restrictions ? `<p class="muted">🔞 ${escapeHtml(club.age_restrictions)}</p>` : ""}
        ${club.rules ? `<p class="muted">📋 ${formatMultiline(club.rules)}</p>` : ""}
        ${!club.address && !club.contacts && !club.rules && !club.telegram && !club.vk
          ? `<p class="muted">Информация о клубе скоро появится.</p>`
          : ""}
      `;
      await loadVenues();

    } catch (error) {
      console.error("loadClub:", error);
      container.innerHTML = emptyMessage("Информация о клубе пока недоступна.");
    }
  }

  
  // Выбор видов игры в зависимости от площадки
  function updateOrderTypes() {
    const venue = $("orderVenue")?.value;
    const typeSelect = $("orderType");

    if (!typeSelect) return;

    const types = {
      "Бункер": ["страйкбол", "лазертаг", "гидробол с орбизами"],
      "Адмирал": ["страйкбол", "ребол", "лазертаг", "гидробол с орбизами"],
      "Глубокое озеро": ["страйкбол", "пейнтбол", "лазертаг", "гидробол с орбизами"]
    };

    typeSelect.innerHTML = '<option value="">Выбери вид игры</option>';

    (types[venue] || []).forEach(type => {
      const option = document.createElement("option");
      option.value = type;
      option.textContent = type.charAt(0).toUpperCase() + type.slice(1);
      typeSelect.appendChild(option);
    });

    typeSelect.disabled = !types[venue];
  }

  $("orderVenue")?.addEventListener("change", updateOrderTypes);\n  $("orderDate")?.addEventListener("change", updateOrderTimeOptions);\n  updateOrderTimeOptions();


  function moscowDateTimeParts() {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Moscow", year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(new Date());
    return Object.fromEntries(parts.map(part => [part.type, part.value]));
  }

  function updateOrderTimeOptions() {
    const dateInput = $("orderDate");
    const timeSelect = $("orderTime");
    if (!dateInput || !timeSelect) return;

    const now = moscowDateTimeParts();
    const today = `${now.year}-${now.month}-${now.day}`;
    dateInput.min = today;
    dateInput.setAttribute("min", today);

    // Clear any previously selected date that is now in the past.
    if (dateInput.value && dateInput.value < today) {
      dateInput.value = "";
    }

    const selectedDate = dateInput.value;
    timeSelect.replaceChildren();

    if (!selectedDate) {
      timeSelect.add(new Option("Сначала выбери дату", ""));
      timeSelect.disabled = true;
      return;
    }

    let firstMinute = 0;
    if (selectedDate === today) {
      const currentMinute = Number(now.hour) * 60 + Number(now.minute);
      firstMinute = Math.ceil(currentMinute / 30) * 30;
    }

    for (let minute = firstMinute; minute < 24 * 60; minute += 30) {
      const hour = String(Math.floor(minute / 60)).padStart(2, "0");
      const mins = String(minute % 60).padStart(2, "0");
      timeSelect.add(new Option(`${hour}:${mins}`, `${hour}:${mins}`));
    }

    if (!timeSelect.options.length) {
      timeSelect.add(new Option("На сегодня свободных временных слотов нет", ""));
      timeSelect.disabled = true;
      return;
    }

    timeSelect.disabled = false;
  }

  // Keep date restrictions fresh whenever the calendar is opened or edited.
  $("orderDate")?.addEventListener("focus", updateOrderTimeOptions);
  $("orderDate")?.addEventListener("click", updateOrderTimeOptions);
  $("orderDate")?.addEventListener("input", updateOrderTimeOptions);
  $("orderDate")?.addEventListener("change", updateOrderTimeOptions);
  updateOrderTimeOptions();

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

    const now = moscowDateTimeParts();
    const today = `${now.year}-${now.month}-${now.day}`;
    if (payload.game_date < today) {
      showMessage(message, "Нельзя выбрать дату раньше сегодняшней.", true);
      return;
    }
    if (!/^(?:[01]\\d|2[0-3]):(?:00|30)$/.test(payload.game_time)) {
      showMessage(message, "Выбери время с шагом 30 минут.", true);
      return;
    }
    const currentTime = `${now.hour}:${now.minute}`;
    if (payload.game_date === today && payload.game_time < currentTime) {
      showMessage(message, "Нельзя выбрать время раньше текущего.", true);
      updateOrderTimeOptions();
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
        "Заявка успешно отправлена! В скором времени с тобой свяжется администратор и уточнит детали."
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
        <button class="secondary" id="checkGalleryChannel">
          Проверить канал галереи
        </button>
        <p id="galleryCheckResult" class="muted"></p>
      `;

      await loadAdminClubEditor();
      await loadAdminVenues();
      await loadAdminGameFormats();
      await loadAdminOrders();

    } catch (error) {
      console.error("loadAdmin:", error);
      info.innerHTML = emptyMessage("Не удалось проверить права администратора.");
    }
  }

  async function loadAdminClubEditor() {
    const container = $("adminClubEditor");
    if (!container || !state.admin) return;

    try {
      const data = await api("/api/club");
      const club = data.club || {};
      container.innerHTML = `
        <h3>Редактирование информации о клубе</h3>
        <form id="clubInfoForm">
          <div class="field"><label for="clubContacts">Телефон и другие контакты</label><input id="clubContacts" type="text" maxlength="500" value="${escapeHtml(club.contacts || "")}" placeholder="+7..."></div>
          <div class="field"><label for="clubTelegram">Telegram (ссылка или @username)</label><input id="clubTelegram" type="text" maxlength="200" value="${escapeHtml(club.telegram || "")}" placeholder="@username или https://t.me/username"></div>
          <div class="field"><label for="clubVk">ВКонтакте (ссылка)</label><input id="clubVk" type="url" maxlength="500" value="${escapeHtml(club.vk || "")}" placeholder="https://vk.com/..."></div>
          <div class="field"><label for="clubAddress">Адрес клуба</label><textarea id="clubAddress" rows="2" maxlength="1000">${escapeHtml(club.address || "")}</textarea></div>
          <div class="field"><label for="clubRules">Правила</label><textarea id="clubRules" rows="5" maxlength="5000">${escapeHtml(club.rules || "")}</textarea></div>
          <div class="field"><label for="clubAgeRestrictions">Возрастные ограничения</label><textarea id="clubAgeRestrictions" rows="2" maxlength="1000">${escapeHtml(club.age_restrictions || "")}</textarea></div>
          <button class="primary" type="submit">Сохранить изменения</button>
          <p id="clubInfoMessage" class="muted"></p>
        </form>
      `;
    } catch (error) {
      console.error("loadAdminClubEditor:", error);
      container.innerHTML = emptyMessage("Не удалось загрузить информацию клуба.");
    }
  }

  async function saveClubInfo(event) {
    event.preventDefault();
    const form = $("clubInfoForm");
    const button = form?.querySelector('button[type="submit"]');
    const message = $("clubInfoMessage");
    if (!form || !state.admin) return;

    const payload = {
      contacts: $("clubContacts").value.trim(),
      telegram: $("clubTelegram").value.trim(),
      vk: $("clubVk").value.trim(),
      address: $("clubAddress").value.trim(),
      rules: $("clubRules").value.trim(),
      age_restrictions: $("clubAgeRestrictions").value.trim()
    };

    if (button) button.disabled = true;
    showMessage(message, "Сохраняем изменения...");
    try {
      await api("/api/admin/club", {
        method: "PUT",
        body: JSON.stringify(payload)
      });
      showMessage(message, "Изменения сохранены.");
      await loadClub();
    } catch (error) {
      showMessage(message, error.message || "Не удалось сохранить изменения.", true);
    } finally {
      if (button) button.disabled = false;
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
      case "gameFormats":
        loadGameFormats();
        break;
      case "gallery":\n        loadGallery();\n        break;\n      case "bookings":
        loadBookings();
        break;
      case "profile":
        loadProfile();
        break;
      case "club":
      case "contacts":
        loadClub();
        break;
      case "admin":
        loadAdmin();
        break;
    }
  };

  // ОБРАБОТЧИКИ КНОПОК

  document.addEventListener("click", event => {\n    const filter = event.target.closest("[data-gallery-filter]");\n    if (!filter) return;\n    galleryFilter = filter.dataset.galleryFilter;\n    document.querySelectorAll("[data-gallery-filter]").forEach(button => button.classList.toggle("active", button === filter));\n    loadGallery();\n  });\n\n  document.addEventListener("submit", event => {
    if (event.target?.id === "bookingForm") submitBooking(event);
    if (event.target?.id === "clubInfoForm") saveClubInfo(event);
    if (event.target?.matches("[data-venue-form]")) saveVenue(event);
    if (event.target?.matches("[data-game-format-form]")) saveGameFormat(event);
  });

  document.addEventListener("change",e=>{const i=e.target.closest("[data-venue-upload]");if(i)uploadVenuePhotos(i);});
  document.addEventListener("click", async event => {
    if (event.target.closest("[data-booking-close]")) { closeBookingModal(); return; }
    const gf=event.target.closest("[data-open-game-format]");if(gf){renderGameFormat(gf.dataset.openGameFormat);return;}
    if(event.target.closest("[data-game-formats-back]")){activeGameFormat=null;$("gameFormatDetails").hidden=true;$("gameFormatsList").hidden=false;return;}
    const o=event.target.closest("[data-open-venue]");if(o){renderVenueDetails(o.dataset.openVenue);return;}
    if(event.target.closest("[data-venues-back]")){state.activeVenue=null;$("venueDetails").hidden=true;$("venuesList").hidden=false;return;}
    const del=event.target.closest("[data-delete-venue-photo]");if(del){try{await api("/api/admin/venues/photo/"+del.dataset.deleteVenuePhoto,{method:"DELETE"});await loadAdminVenues();await loadVenues();}catch(e){alert(e.message);}return;}
    const galleryButton = event.target.closest("#checkGalleryChannel");
    if (galleryButton) {
      const result = $("galleryCheckResult");
      galleryButton.disabled = true;
      result.textContent = "Проверяем канал...";

      try {
        const data = await api("/api/admin/gallery/check");

        result.textContent =
          "Канал: " + data.channel +
          "\nСтатус бота: " + data.bot_status +
          "\nПубликация: " +
          (data.can_post_messages ? "разрешена ✅" : "не разрешена ❌");
      } catch (error) {
        result.textContent = "Ошибка: " + error.message;
      } finally {
        galleryButton.disabled = false;
      }
      return;
    }

    const bookButton = event.target.closest("[data-book-game]");
    if (bookButton) {
      openBookingModal(Number(bookButton.dataset.bookGame));
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

  // Кнопка администрирования показывается только после подтверждения прав.
async function checkAdminAccess() {
  const adminButton = $("adminHome");
  if (!adminButton) return;
  adminButton.classList.add("hidden");
  try {
    const data = await api("/api/admin");
    if (data.isAdmin === true) adminButton.classList.remove("hidden");
  } catch (error) {
    console.error("Проверка прав администратора:", error);
  }
}

// СТАРТ

if (tg) {
  tg.ready();
  tg.expand();

  try {
    tg.setHeaderColor("#111315");
    tg.setBackgroundColor("#111315");
  } catch (error) {}
}

checkAdminAccess();

// Подгружаем площадки сразу, а не только при открытии раздела «О клубе».
loadVenues();

})();
