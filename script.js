"use strict";

const STORAGE_KEYS = Object.freeze({ data: "hrPlannerData", settings: "hrPlannerSettings" });
const DATA_VERSION = 1;
const EVENT_TYPES = Object.freeze({ hire: "Приём", dismissal: "Увольнение" });
const INITIAL_STATUSES = Object.freeze({ hire: "Прием", dismissal: "Увольнение" });
const STATUSES = Object.freeze({
  hire: Object.freeze(["Прием", "Принят", "Отменён", "Нет документов", "Не пришёл"]),
  dismissal: Object.freeze(["Увольнение", "Уволен", "Отменён"]),
});
const DEPARTMENTS = Object.freeze(["Подразделение 1", "Подразделение 2", "Подразделение 3", "Подразделение 4", "Подразделение 5", "Подразделение 6"]);
const POSITIONS = Object.freeze(["Должность 1", "Должность 2", "Должность 3", "Должность 4"]);

const state = {
  records: [], settings: null, calendar: null, lastFocusedElement: null, pendingDeletion: null,
  activeFormDirtyCheck: null, pendingExternalData: null,
};
const elements = {};

function padDatePart(value) { return String(value).padStart(2, "0"); }
function toDateKey(date) { return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`; }
function fromDateKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return toDateKey(date) === value ? date : null;
}
function getCurrentWeek(referenceDate = new Date()) {
  const date = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
  const start = new Date(date);
  start.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { start: toDateKey(start), end: toDateKey(end) };
}
function getDefaultSettings() {
  const week = getCurrentWeek();
  return { periodStart: week.start, periodEnd: week.end, activeTypeFilter: "all", calendarDate: toDateKey(new Date()) };
}
function formatDateRu(value) {
  const date = fromDateKey(value);
  return date ? new Intl.DateTimeFormat("ru-RU").format(date) : "";
}
function formatRateRu(value) {
  const rate = Number(value);
  return Number.isFinite(rate) ? new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(rate) : "";
}
function normalizeFullName(value) { return String(value || "").trim().replace(/\s+/g, " "); }
function normalizeFullNameForComparison(value) { return normalizeFullName(value).toLocaleLowerCase("ru-RU").replace(/ё/g, "е"); }
function parseRate(value) {
  const normalized = String(value ?? "").trim().replace(",", ".");
  return /^\d+(?:\.\d+)?$/.test(normalized) ? Number(normalized) : Number.NaN;
}
function generateId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `record-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function sortRecords(records) {
  return [...records].sort((left, right) => left.eventDate.localeCompare(right.eventDate)
    || left.fullName.localeCompare(right.fullName, "ru", { sensitivity: "base" }));
}
function isRecordInPeriod(record, start, end) { return record.eventDate >= start && record.eventDate <= end; }
function isDuplicate(candidate, records = state.records, ignoredId = null) {
  const name = normalizeFullNameForComparison(candidate.fullName);
  return records.some((record) => record.id !== ignoredId
    && normalizeFullNameForComparison(record.fullName) === name
    && record.eventType === candidate.eventType && record.eventDate === candidate.eventDate);
}
function validateRecord(input, options = {}) {
  const errors = {};
  const fullName = normalizeFullName(input.fullName);
  const rate = parseRate(input.rate);
  const today = options.today || toDateKey(new Date());
  if (!EVENT_TYPES[input.eventType]) errors.eventType = "Выберите кадровое событие.";
  if (!fullName) errors.fullName = "Введите ФИО.";
  else if (!/\p{L}/u.test(fullName)) errors.fullName = "ФИО должно содержать хотя бы одну букву.";
  if (!POSITIONS.includes(input.position)) errors.position = "Выберите должность из списка.";
  if (!DEPARTMENTS.includes(input.department)) errors.department = "Выберите подразделение из списка.";
  if (!fromDateKey(input.eventDate)) errors.eventDate = "Укажите корректную дату события.";
  else if (input.eventDate < today && !(options.allowPastUnchangedDate && input.eventDate === options.originalDate)) {
    errors.eventDate = options.allowPastUnchangedDate
      ? "Нельзя заменить дату на другую прошедшую дату."
      : "Для новой записи выберите текущую или будущую дату.";
  }
  if (!Number.isFinite(rate) || rate < 0.01 || rate > 1) errors.rate = "Введите ставку от 0,01 до 1.";
  const normalized = { ...input, fullName, rate, status: INITIAL_STATUSES[input.eventType] || "", comment: "" };
  if (!Object.keys(errors).length && isDuplicate(normalized, options.records || state.records, options.ignoredId || null)) {
    errors.duplicate = "Такое кадровое событие уже существует.";
  }
  return { isValid: Object.keys(errors).length === 0, errors, normalized };
}

function isStoredRecord(record) {
  return Boolean(record && typeof record === "object"
    && typeof record.id === "string" && record.id
    && EVENT_TYPES[record.eventType]
    && typeof record.fullName === "string"
    && typeof record.position === "string"
    && typeof record.department === "string"
    && fromDateKey(record.eventDate)
    && Number.isFinite(record.rate) && record.rate >= 0.01 && record.rate <= 1
    && STATUSES[record.eventType].includes(record.status)
    && typeof record.comment === "string"
    && typeof record.createdAt === "string"
    && typeof record.updatedAt === "string");
}
function parseStoredData(raw) {
  const fallback = { version: DATA_VERSION, records: [], issue: null, skipped: 0 };
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version !== DATA_VERSION || !Array.isArray(parsed.records)) {
      return { ...fallback, issue: "invalid-root" };
    }
    const seenIds = new Set();
    const records = parsed.records.filter((record) => {
      if (!isStoredRecord(record) || seenIds.has(record.id)) return false;
      seenIds.add(record.id); return true;
    });
    return { version: DATA_VERSION, records, issue: null, skipped: parsed.records.length - records.length };
  } catch (error) {
    console.warn("Не удалось прочитать кадровые записи.", error);
    return { ...fallback, issue: "invalid-json" };
  }
}
function loadData() {
  try { return parseStoredData(localStorage.getItem(STORAGE_KEYS.data)); }
  catch (error) {
    console.warn("Хранилище браузера недоступно.", error);
    return { version: DATA_VERSION, records: [], issue: "storage-unavailable", skipped: 0 };
  }
}
function saveData(records = state.records) {
  localStorage.setItem(STORAGE_KEYS.data, JSON.stringify({ version: DATA_VERSION, records }));
}
function loadSettings() {
  const defaults = getDefaultSettings();
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.settings);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    const settings = {
      periodStart: fromDateKey(parsed?.periodStart) ? parsed.periodStart : defaults.periodStart,
      periodEnd: fromDateKey(parsed?.periodEnd) ? parsed.periodEnd : defaults.periodEnd,
      activeTypeFilter: ["all", "hire", "dismissal"].includes(parsed?.activeTypeFilter) ? parsed.activeTypeFilter : "all",
      calendarDate: fromDateKey(parsed?.calendarDate) ? parsed.calendarDate : defaults.calendarDate,
    };
    return settings.periodStart <= settings.periodEnd ? settings : defaults;
  } catch (error) {
    console.warn("Не удалось прочитать настройки.", error);
    return defaults;
  }
}
function saveSettings() {
  try { localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(state.settings)); return true; }
  catch (error) {
    console.warn("Не удалось сохранить настройки.", error);
    if (elements.toastContainer) showToast("Не удалось сохранить настройки в браузере.", "error");
    return false;
  }
}

function cacheElements() {
  ["periodStart", "periodEnd", "periodError", "currentWeekButton", "showAllButton", "hireSummary", "dismissalSummary",
    "hireCount", "dismissalCount", "periodCaption", "recordsTableBody", "calendar", "calendarFallback", "modalRoot",
    "toastContainer", "createHireButton", "createDismissalButton"].forEach((id) => { elements[id] = document.getElementById(id); });
}
function getFilteredRecords({ includeTypeFilter = true } = {}) {
  const { periodStart, periodEnd, activeTypeFilter } = state.settings;
  return sortRecords(state.records.filter((record) => isRecordInPeriod(record, periodStart, periodEnd)
    && (!includeTypeFilter || activeTypeFilter === "all" || record.eventType === activeTypeFilter)));
}
function renderPeriod() {
  elements.periodStart.value = state.settings.periodStart;
  elements.periodEnd.value = state.settings.periodEnd;
  elements.periodCaption.textContent = `${formatDateRu(state.settings.periodStart)} — ${formatDateRu(state.settings.periodEnd)}`;
}
function renderSummary() {
  const records = getFilteredRecords({ includeTypeFilter: false });
  elements.hireCount.textContent = String(records.filter((record) => record.eventType === "hire").length);
  elements.dismissalCount.textContent = String(records.filter((record) => record.eventType === "dismissal").length);
  const filter = state.settings.activeTypeFilter;
  elements.hireSummary.setAttribute("aria-pressed", String(filter === "hire"));
  elements.dismissalSummary.setAttribute("aria-pressed", String(filter === "dismissal"));
  elements.showAllButton.setAttribute("aria-pressed", String(filter === "all"));
}
function createCell(label, content, className = "") {
  const cell = document.createElement("td");
  cell.dataset.label = label;
  if (className) cell.className = className;
  if (content instanceof Node) cell.append(content); else cell.textContent = content;
  return cell;
}
function createBadge(text, className) {
  const badge = document.createElement("span");
  badge.className = className;
  badge.textContent = text;
  return badge;
}
function createActionButton(label, action, recordId) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "table-action";
  button.dataset.action = action;
  button.dataset.recordId = recordId;
  button.textContent = label;
  return button;
}
function createStatusSelect(record) {
  const select = document.createElement("select");
  select.className = "status-select";
  select.dataset.action = "status";
  select.dataset.recordId = record.id;
  select.setAttribute("aria-label", `Статус: ${record.fullName}`);
  STATUSES[record.eventType].forEach((status) => {
    const option = document.createElement("option");
    option.value = status; option.textContent = status; option.selected = status === record.status;
    select.append(option);
  });
  return select;
}
function renderTable() {
  const fragment = document.createDocumentFragment();
  getFilteredRecords().forEach((record) => {
    const row = document.createElement("tr");
    const eventBadge = createBadge(EVENT_TYPES[record.eventType], `event-badge event-badge--${record.eventType}`);
    const actions = document.createElement("div");
    actions.className = "table-actions";
    actions.append(
      createActionButton("Просмотреть", "view", record.id),
      createActionButton("Изменить", "edit", record.id),
      createActionButton("Дублировать", "duplicate", record.id),
      createActionButton("Удалить", "delete", record.id),
    );
    row.dataset.recordId = record.id;
    row.append(
      createCell("Дата события", formatDateRu(record.eventDate)), createCell("Кадровое событие", eventBadge),
      createCell("ФИО", record.fullName), createCell("Должность", record.position),
      createCell("Подразделение", record.department), createCell("Ставка", formatRateRu(record.rate)),
      createCell("Статус", createStatusSelect(record)), createCell("Комментарий", record.comment || "", "comment-cell"),
      createCell("Действия", actions, "actions-cell"),
    );
    fragment.append(row);
  });
  elements.recordsTableBody.replaceChildren(fragment);
}
function getCalendarRecords() {
  const filter = state.settings.activeTypeFilter;
  return sortRecords(state.records.filter((record) => filter === "all" || record.eventType === filter));
}
function getCalendarEvents() {
  return getCalendarRecords().map((record) => ({
    id: record.id, title: `${record.fullName} · ${EVENT_TYPES[record.eventType]} · ${record.status}`,
    start: record.eventDate, allDay: true,
    classNames: record.status === "Отменён" ? ["calendar-event--cancelled"] : [],
    backgroundColor: record.eventType === "hire" ? "#2eaa86" : "#f7faf9",
    borderColor: record.eventType === "hire" ? "#62e6bd" : "#aebbb7",
    textColor: record.eventType === "hire" ? "#07110e" : "#080b0a",
  }));
}
function renderCalendar() {
  if (!state.calendar) return;
  state.calendar.removeAllEvents();
  state.calendar.addEventSource(getCalendarEvents());
}
function renderAll() { renderPeriod(); renderSummary(); renderTable(); renderCalendar(); }

function showToast(message, type = "success", options = {}) {
  const toast = document.createElement("div");
  toast.className = `toast${type === "error" ? " toast--error" : ""}`;
  const text = document.createElement("span"); text.textContent = message; toast.append(text);
  if (options.actionLabel && options.onAction) {
    const action = document.createElement("button");
    action.type = "button"; action.className = "toast__action"; action.textContent = options.actionLabel;
    action.addEventListener("click", () => { options.onAction(); toast.remove(); });
    toast.append(action);
  }
  elements.toastContainer.append(toast);
  const timer = window.setTimeout(() => { toast.remove(); options.onExpire?.(); }, options.duration || 4000);
  toast.addEventListener("remove", () => window.clearTimeout(timer), { once: true });
  return toast;
}
function closeModal({ restoreFocus = true } = {}) {
  elements.modalRoot.replaceChildren();
  document.body.style.overflow = "";
  state.activeFormDirtyCheck = null;
  if (restoreFocus && state.lastFocusedElement?.isConnected) state.lastFocusedElement.focus();
  if (state.pendingExternalData) {
    const external = state.pendingExternalData;
    state.pendingExternalData = null;
    if (external.issue) openStorageIssueModal(external.issue);
    else {
      state.records = external.records;
      renderAll();
      showToast("Данные обновлены из другой вкладки");
    }
  }
}
function getFocusableElements(container) {
  return [...container.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}
function createModal(title, { small = false } = {}) {
  if (!elements.modalRoot.contains(document.activeElement)) state.lastFocusedElement = document.activeElement;
  let closeGuard = () => true;
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const modal = document.createElement("section");
  modal.className = `modal${small ? " modal--small" : ""}`;
  modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true");
  const titleId = `modal-title-${Date.now()}`;
  modal.setAttribute("aria-labelledby", titleId);
  const header = document.createElement("header"); header.className = "modal__header";
  const heading = document.createElement("h2"); heading.id = titleId; heading.textContent = title;
  const closeButton = document.createElement("button");
  closeButton.type = "button"; closeButton.className = "icon-button"; closeButton.setAttribute("aria-label", "Закрыть окно"); closeButton.textContent = "×";
  const requestClose = () => { if (closeGuard()) closeModal(); };
  closeButton.addEventListener("click", requestClose);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) requestClose(); });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); requestClose(); return; }
    if (event.key !== "Tab") return;
    const focusable = getFocusableElements(modal);
    if (!focusable.length) { event.preventDefault(); modal.focus(); return; }
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  header.append(heading, closeButton);
  const body = document.createElement("div"); body.className = "modal__body";
  modal.append(header, body); overlay.append(modal); elements.modalRoot.replaceChildren(overlay);
  document.body.style.overflow = "hidden";
  requestAnimationFrame(() => closeButton.focus());
  return { modal, body, requestClose, setCloseGuard(guard) { closeGuard = guard; } };
}
function fieldMarkup({ name, label, type = "text", hint = "", wide = false, attributes = "" }) {
  return `<div class="form-field${wide ? " form-field--wide" : ""}"><label for="record-${name}">${label}</label>
    <input id="record-${name}" name="${name}" type="${type}" ${attributes} aria-describedby="record-${name}-error${hint ? ` record-${name}-hint` : ""}">
    ${hint ? `<p class="input-hint" id="record-${name}-hint">${hint}</p>` : ""}<p class="input-error" id="record-${name}-error"></p></div>`;
}
function selectMarkup(name, label, options) {
  return `<div class="form-field"><label for="record-${name}">${label}</label><select id="record-${name}" name="${name}" aria-describedby="record-${name}-error">
    <option value="">Выберите значение</option>${options.map((option) => `<option value="${option}">${option}</option>`).join("")}</select>
    <p class="input-error" id="record-${name}-error"></p></div>`;
}
function updateRecordFormType(form, eventType, { resetStatus = false } = {}) {
  form.querySelector("#record-date-label").textContent = eventType === "hire" ? "Дата приёма" : "Дата увольнения";
  const statusControl = form.querySelector("#record-status");
  if (statusControl.tagName === "SELECT") {
    const selected = resetStatus ? INITIAL_STATUSES[eventType] : statusControl.value;
    statusControl.replaceChildren(...STATUSES[eventType].map((status) => {
      const option = document.createElement("option"); option.value = status; option.textContent = status;
      option.selected = status === selected; return option;
    }));
  } else {
    statusControl.textContent = INITIAL_STATUSES[eventType];
  }
}
function clearFormErrors(form) {
  form.querySelectorAll("[aria-invalid]").forEach((field) => field.removeAttribute("aria-invalid"));
  form.querySelectorAll(".input-error").forEach((error) => { error.textContent = ""; });
  const alert = form.querySelector(".form-alert"); alert.hidden = true; alert.textContent = "";
}
function displayFormErrors(form, errors) {
  clearFormErrors(form);
  const alert = form.querySelector(".form-alert"); alert.hidden = false; alert.textContent = errors.duplicate || "Проверьте заполнение полей.";
  Object.entries(errors).forEach(([name, message]) => {
    if (name === "duplicate") return;
    const field = form.elements[name]; const error = form.querySelector(`#record-${name}-error`);
    if (field) field.setAttribute("aria-invalid", "true");
    if (error) error.textContent = message;
  });
  const firstErrorName = Object.keys(errors).find((name) => name !== "duplicate");
  (firstErrorName ? form.elements[firstErrorName] : form.elements.fullName)?.focus();
}
function createRecord(input) {
  const validation = validateRecord(input);
  if (!validation.isValid) return { ok: false, errors: validation.errors };
  const timestamp = new Date().toISOString();
  const record = { id: generateId(), ...validation.normalized, createdAt: timestamp, updatedAt: timestamp };
  const nextRecords = [...state.records, record];
  try { saveData(nextRecords); } catch (error) { return { ok: false, storageError: error }; }
  state.records = nextRecords;
  return { ok: true, record };
}
function updateRecord(id, input) {
  const current = state.records.find((record) => record.id === id);
  if (!current) return { ok: false, notFound: true };
  const validation = validateRecord(input, {
    records: state.records,
    ignoredId: id,
    allowPastUnchangedDate: true,
    originalDate: current.eventDate,
  });
  if (!validation.isValid) return { ok: false, errors: validation.errors };
  const updated = {
    ...current,
    ...validation.normalized,
    status: input.status,
    comment: String(input.comment || ""),
    updatedAt: new Date().toISOString(),
  };
  if (!STATUSES[updated.eventType]?.includes(updated.status)) {
    return { ok: false, errors: { status: "Выберите допустимый статус." } };
  }
  const nextRecords = state.records.map((record) => record.id === id ? updated : record);
  try { saveData(nextRecords); } catch (error) { return { ok: false, storageError: error }; }
  state.records = nextRecords;
  return { ok: true, record: updated };
}
function changeStatus(id, status, comment) {
  const current = state.records.find((record) => record.id === id);
  if (!current) return { ok: false, notFound: true };
  if (!STATUSES[current.eventType].includes(status)) return { ok: false, invalidStatus: true };
  const updated = { ...current, status, comment: String(comment ?? current.comment), updatedAt: new Date().toISOString() };
  const nextRecords = state.records.map((record) => record.id === id ? updated : record);
  try { saveData(nextRecords); } catch (error) { return { ok: false, storageError: error }; }
  state.records = nextRecords;
  return { ok: true, record: updated };
}
function deleteRecord(id) {
  const index = state.records.findIndex((record) => record.id === id);
  if (index < 0) return { ok: false, notFound: true };
  const record = state.records[index];
  const nextRecords = state.records.filter((item) => item.id !== id);
  try { saveData(nextRecords); } catch (error) { return { ok: false, storageError: error }; }
  state.records = nextRecords;
  return { ok: true, record, index };
}
function restoreRecord(record, index) {
  if (!record || state.records.some((item) => item.id === record.id)) return { ok: false, duplicate: true };
  const nextRecords = [...state.records];
  nextRecords.splice(Math.min(Math.max(index, 0), nextRecords.length), 0, record);
  try { saveData(nextRecords); } catch (error) { return { ok: false, storageError: error }; }
  state.records = nextRecords;
  return { ok: true, record };
}
function serializeForm(form) { return JSON.stringify(Object.fromEntries(new FormData(form).entries())); }
function openRecordForm({ mode, eventType = "hire", presetDate = "", record = null }) {
  const isEdit = mode === "edit";
  const isDuplicate = mode === "duplicate";
  const safeType = record?.eventType || (EVENT_TYPES[eventType] ? eventType : "hire");
  const title = isEdit ? "Изменить кадровое событие"
    : isDuplicate ? "Дублировать кадровое событие"
      : safeType === "hire" ? "Запланировать приём" : "Запланировать увольнение";
  const modalApi = createModal(title);
  const { modal, body } = modalApi;
  const form = document.createElement("form");
  form.id = `record-form-${generateId()}`;
  form.className = "record-form";
  form.noValidate = true;
  const statusMarkup = isEdit
    ? `<div class="form-field form-field--wide"><label for="record-status">Статус</label><select id="record-status" name="status" aria-describedby="record-status-error"></select><p class="input-error" id="record-status-error"></p></div>
       <div class="form-field form-field--wide"><label for="record-comment">Комментарий</label><textarea id="record-comment" name="comment" rows="4" aria-describedby="record-comment-error"></textarea><p class="input-error" id="record-comment-error"></p></div>`
    : `<div class="form-field form-field--wide"><span class="form-field__label">Статус</span><div class="readonly-value" id="record-status"></div></div>`;
  form.innerHTML = `<p class="form-alert" role="alert" tabindex="-1" hidden></p>
    <div class="form-field form-field--wide"><span class="form-field__label">Кадровое событие</span><div class="event-type-control">
      <label><input type="radio" name="eventType" value="hire" ${safeType === "hire" ? "checked" : ""}><span>Приём</span></label>
      <label><input type="radio" name="eventType" value="dismissal" ${safeType === "dismissal" ? "checked" : ""}><span>Увольнение</span></label>
    </div><p class="input-error" id="record-eventType-error"></p></div>
    <div class="form-grid">${fieldMarkup({ name: "fullName", label: "ФИО", wide: true, attributes: "autocomplete=\"name\"" })}
      ${selectMarkup("position", "Должность", POSITIONS)}${selectMarkup("department", "Подразделение", DEPARTMENTS)}
      <div class="form-field"><label id="record-date-label" for="record-eventDate"></label>
        <input id="record-eventDate" name="eventDate" type="date" ${isEdit ? "" : `min="${toDateKey(new Date())}"`} aria-describedby="record-eventDate-error">
        <p class="input-error" id="record-eventDate-error"></p></div>
      ${fieldMarkup({ name: "rate", label: "Ставка", hint: "Число от 0,01 до 1", attributes: "inputmode=\"decimal\" placeholder=\"Например, 0,5\"" })}
      ${statusMarkup}
    </div>`;
  const footer = document.createElement("footer"); footer.className = "modal__footer";
  const cancelButton = document.createElement("button"); cancelButton.type = "button"; cancelButton.className = "button button--ghost"; cancelButton.textContent = "Отмена";
  cancelButton.addEventListener("click", modalApi.requestClose);
  const submitButton = document.createElement("button");
  submitButton.type = "submit";
  submitButton.setAttribute("form", form.id);
  submitButton.className = "button button--primary";
  submitButton.textContent = "Сохранить";
  footer.append(cancelButton, submitButton); modal.append(footer); body.append(form);
  updateRecordFormType(form, safeType, { resetStatus: true });
  if (record) {
    form.elements.fullName.value = record.fullName;
    form.elements.position.value = record.position;
    form.elements.department.value = record.department;
    form.elements.rate.value = formatRateRu(record.rate);
    if (isEdit) {
      form.elements.eventDate.value = record.eventDate;
      form.elements.status.value = record.status;
      form.elements.comment.value = record.comment;
    }
  }
  if (!isEdit) form.elements.eventDate.value = isDuplicate ? "" : presetDate;
  let baseline = serializeForm(form);
  state.activeFormDirtyCheck = () => serializeForm(form) !== baseline;
  modalApi.setCloseGuard(() => serializeForm(form) === baseline
    || window.confirm("Есть несохранённые изменения. Закрыть форму и потерять изменения?"));
  form.elements.eventType.forEach((radio) => radio.addEventListener("change", () => {
    const previousType = radio.value === "hire" ? "dismissal" : "hire";
    if (isEdit && !window.confirm("При смене типа события статус будет сброшен. Продолжить?")) {
      form.elements.eventType.value = previousType;
      return;
    }
    updateRecordFormType(form, radio.value, { resetStatus: true });
    if (!isEdit && !isDuplicate) {
      modal.querySelector("h2").textContent = radio.value === "hire" ? "Запланировать приём" : "Запланировать увольнение";
    }
  }));
  form.addEventListener("input", () => clearFormErrors(form));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.pendingExternalData) {
      const alert = form.querySelector(".form-alert");
      alert.hidden = false;
      alert.textContent = "Данные изменились в другой вкладке. Закройте форму, чтобы обновить список, затем повторите изменение.";
      alert.focus();
      return;
    }
    const input = Object.fromEntries(new FormData(form).entries());
    const result = isEdit ? updateRecord(record.id, input) : createRecord(input);
    if (!result.ok) {
      if (result.storageError) showToast("Не удалось сохранить данные в браузере.", "error");
      else if (result.notFound) showToast("Запись больше не существует.", "error");
      else displayFormErrors(form, result.errors);
      return;
    }
    baseline = serializeForm(form); state.activeFormDirtyCheck = null; closeModal(); renderAll();
    showToast(isEdit ? "Изменения сохранены" : "Событие сохранено");
  });
  requestAnimationFrame(() => form.elements.fullName.focus());
}
function openCreateModal(eventType, presetDate = "") { openRecordForm({ mode: "create", eventType, presetDate }); }
function openEditModal(record) { openRecordForm({ mode: "edit", record }); }
function duplicateRecord(record) { openRecordForm({ mode: "duplicate", record }); }
function openDateChoice(date) {
  const { body } = createModal(`Событие на ${formatDateRu(date)}`, { small: true });
  const list = document.createElement("div"); list.className = "choice-list";
  Object.entries(EVENT_TYPES).forEach(([type, label]) => {
    const button = document.createElement("button"); button.type = "button";
    button.className = type === "hire" ? "button button--primary" : "button button--secondary";
    button.textContent = `Запланировать ${label.toLocaleLowerCase("ru-RU")}`;
    button.addEventListener("click", () => openCreateModal(type, date)); list.append(button);
  });
  body.append(list);
}
function openDayEvents(date) {
  const records = getCalendarRecords().filter((record) => record.eventDate === date);
  const { body } = createModal(`События на ${formatDateRu(date)}`, { small: true });
  const list = document.createElement("div"); list.className = "day-event-list";
  records.forEach((record) => {
    const item = document.createElement("button"); item.type = "button"; item.className = "day-event";
    const name = document.createElement("strong"); name.textContent = record.fullName;
    const meta = document.createElement("span"); meta.className = "day-event__meta";
    meta.textContent = `${EVENT_TYPES[record.eventType]} · ${record.status} · ${record.position}`;
    item.append(name, meta); item.addEventListener("click", () => openViewModal(record)); list.append(item);
  });
  body.append(list);
}
function createDetail(label, value) {
  const wrapper = document.createElement("div"); wrapper.className = "record-detail";
  const term = document.createElement("dt"); term.textContent = label;
  const description = document.createElement("dd"); description.textContent = value || "—";
  wrapper.append(term, description); return wrapper;
}
function createFooterButton(label, className, handler) {
  const button = document.createElement("button"); button.type = "button"; button.className = className; button.textContent = label;
  button.addEventListener("click", handler); return button;
}
function openViewModal(recordOrId) {
  const record = typeof recordOrId === "string" ? state.records.find((item) => item.id === recordOrId) : recordOrId;
  if (!record) { showToast("Запись больше не существует.", "error"); return; }
  const { modal, body } = createModal("Кадровое событие");
  const details = document.createElement("dl"); details.className = "record-details";
  details.append(
    createDetail("Дата события", formatDateRu(record.eventDate)), createDetail("Кадровое событие", EVENT_TYPES[record.eventType]),
    createDetail("ФИО", record.fullName), createDetail("Должность", record.position),
    createDetail("Подразделение", record.department), createDetail("Ставка", formatRateRu(record.rate)),
    createDetail("Статус", record.status), createDetail("Комментарий", record.comment),
  );
  const quickStatus = document.createElement("div"); quickStatus.className = "view-status";
  const label = document.createElement("label"); label.htmlFor = "view-status-select"; label.textContent = "Быстро изменить статус";
  const select = createStatusSelect(record); select.id = "view-status-select";
  select.addEventListener("change", () => requestStatusChange(record.id, select.value, {
    onCancel: () => { select.value = record.status; },
    onSuccess: () => openViewModal(record.id),
  }));
  quickStatus.append(label, select); body.append(details, quickStatus);
  const footer = document.createElement("footer"); footer.className = "modal__footer modal__footer--wrap";
  footer.append(
    createFooterButton("Изменить", "button button--primary", () => openEditModal(record)),
    createFooterButton("Дублировать", "button button--secondary", () => duplicateRecord(record)),
    createFooterButton("Удалить", "button button--danger", () => requestDelete(record.id)),
    createFooterButton("Закрыть", "button button--ghost", () => closeModal()),
  );
  modal.append(footer);
}
function applyStatusChange(id, status, comment, callbacks = {}) {
  const result = changeStatus(id, status, comment);
  if (!result.ok) {
    showToast("Не удалось изменить статус.", "error"); callbacks.onCancel?.(); return;
  }
  closeModal(); renderAll(); showToast("Статус изменён"); callbacks.onSuccess?.(result.record);
}
function requestStatusChange(id, nextStatus, callbacks = {}) {
  const record = state.records.find((item) => item.id === id);
  if (!record || nextStatus === record.status) { callbacks.onCancel?.(); return; }
  if (nextStatus === INITIAL_STATUSES[record.eventType]) {
    applyStatusChange(id, nextStatus, record.comment, callbacks); return;
  }
  const modalApi = createModal("Изменить статус", { small: true });
  const { modal, body } = modalApi;
  modalApi.setCloseGuard(() => { callbacks.onCancel?.(); return true; });
  const field = document.createElement("div"); field.className = "form-field";
  const label = document.createElement("label"); label.htmlFor = "status-comment"; label.textContent = `Комментарий к статусу «${nextStatus}»`;
  const textarea = document.createElement("textarea"); textarea.id = "status-comment"; textarea.rows = 4; textarea.value = record.comment;
  field.append(label, textarea); body.append(field);
  const footer = document.createElement("footer"); footer.className = "modal__footer modal__footer--wrap";
  footer.append(
    createFooterButton("Отмена", "button button--ghost", () => { closeModal(); callbacks.onCancel?.(); }),
    createFooterButton("Без комментария", "button button--secondary", () => applyStatusChange(id, nextStatus, "", callbacks)),
    createFooterButton("Сохранить", "button button--primary", () => applyStatusChange(id, nextStatus, textarea.value, callbacks)),
  );
  modal.append(footer); requestAnimationFrame(() => textarea.focus());
}
function requestDelete(id) {
  const record = state.records.find((item) => item.id === id);
  if (!record) { showToast("Запись больше не существует.", "error"); return; }
  const approved = window.confirm(`Удалить запись «${record.fullName} — ${EVENT_TYPES[record.eventType]} — ${formatDateRu(record.eventDate)}»?`);
  if (!approved) return;
  const result = deleteRecord(id);
  if (!result.ok) { showToast("Не удалось удалить запись.", "error"); return; }
  closeModal(); renderAll();
  if (state.pendingDeletion?.toast) state.pendingDeletion.toast.remove();
  const token = generateId();
  const pending = { ...result, token, toast: null };
  state.pendingDeletion = pending;
  pending.toast = showToast("Запись удалена", "success", {
    actionLabel: "Отменить", duration: 7000,
    onAction: () => {
      if (state.pendingDeletion?.token !== token) return;
      const restored = restoreRecord(result.record, result.index);
      state.pendingDeletion = null;
      if (restored.ok) { renderAll(); showToast("Запись восстановлена"); }
      else showToast("Не удалось восстановить запись.", "error");
    },
    onExpire: () => { if (state.pendingDeletion?.token === token) state.pendingDeletion = null; },
  });
}
function openStorageIssueModal(issue) {
  const title = issue === "storage-unavailable" ? "Хранилище недоступно" : "Не удалось прочитать данные";
  const modalApi = createModal(title, { small: true });
  modalApi.setCloseGuard(() => false);
  const closeButton = modalApi.modal.querySelector(".icon-button");
  closeButton.hidden = true;
  const message = document.createElement("p");
  message.textContent = issue === "storage-unavailable"
    ? "Браузер не разрешает доступ к локальному хранилищу. Повторите загрузку после изменения настроек браузера."
    : "Сохранённые данные повреждены или имеют неизвестный формат. Можно повторить загрузку либо очистить их и начать заново.";
  modalApi.body.append(message);
  const footer = document.createElement("footer"); footer.className = "modal__footer modal__footer--wrap";
  const retry = createFooterButton("Повторить загрузку", "button button--secondary", () => {
    const data = loadData();
    if (data.issue) { showToast("Данные по-прежнему недоступны.", "error"); return; }
    state.records = data.records; closeModal(); renderAll(); showToast("Данные загружены");
  });
  const clear = createFooterButton("Очистить и продолжить", "button button--danger", () => {
    if (!window.confirm("Очистить повреждённые данные? Восстановить их через приложение будет невозможно.")) return;
    try {
      localStorage.removeItem(STORAGE_KEYS.data);
      state.records = []; closeModal(); renderAll(); showToast("Повреждённые данные очищены");
    } catch (error) { showToast("Не удалось очистить данные браузера.", "error"); }
  });
  if (issue === "storage-unavailable") clear.hidden = true;
  footer.append(retry, clear); modalApi.modal.append(footer); requestAnimationFrame(() => retry.focus());
}
function handleStorageEvent(event) {
  if (event.storageArea && event.storageArea !== localStorage) return;
  if (event.key === STORAGE_KEYS.settings) {
    state.settings = loadSettings(); renderAll(); return;
  }
  if (event.key !== STORAGE_KEYS.data) return;
  const external = parseStoredData(event.newValue);
  if (state.activeFormDirtyCheck?.()) {
    state.pendingExternalData = external;
    showToast("Данные изменились в другой вкладке. Завершите работу с формой, чтобы обновить список.", "error", { duration: 7000 });
    return;
  }
  if (external.issue) { openStorageIssueModal(external.issue); return; }
  state.records = external.records; renderAll(); showToast("Данные обновлены из другой вкладки");
}
function initializeCalendar() {
  if (!globalThis.FullCalendar?.Calendar) {
    elements.calendar.hidden = true; elements.calendarFallback.hidden = false; return;
  }
  state.calendar = new FullCalendar.Calendar(elements.calendar, {
    initialView: "dayGridMonth", initialDate: state.settings.calendarDate, locale: "ru", firstDay: 1,
    height: "auto", dayMaxEvents: 3, buttonText: { today: "Сегодня" },
    headerToolbar: { left: "prev,next today", center: "title", right: "" },
    datesSet() {
      const current = state.calendar?.getDate();
      if (current) { state.settings.calendarDate = toDateKey(current); saveSettings(); }
    },
    dateClick(info) { openDateChoice(info.dateStr); },
    eventClick(info) { openViewModal(info.event.id); },
    moreLinkClick(info) { openDayEvents(toDateKey(info.date)); return "none"; },
    events: getCalendarEvents(),
  });
  state.calendar.render();
}
function setTypeFilter(nextFilter) {
  state.settings.activeTypeFilter = state.settings.activeTypeFilter === nextFilter ? "all" : nextFilter;
  saveSettings(); renderSummary(); renderTable(); renderCalendar();
}
function applyPeriod() {
  const start = elements.periodStart.value; const end = elements.periodEnd.value;
  if (!fromDateKey(start) || !fromDateKey(end) || start > end) {
    elements.periodError.textContent = "Дата начала не может быть позже даты окончания."; elements.periodError.hidden = false; return;
  }
  elements.periodError.hidden = true;
  Object.assign(state.settings, { periodStart: start, periodEnd: end, calendarDate: start });
  saveSettings(); if (state.calendar) state.calendar.gotoDate(start); renderAll();
}
function bindEvents() {
  elements.periodStart.addEventListener("change", applyPeriod); elements.periodEnd.addEventListener("change", applyPeriod);
  elements.currentWeekButton.addEventListener("click", () => {
    const week = getCurrentWeek();
    Object.assign(state.settings, { periodStart: week.start, periodEnd: week.end, calendarDate: toDateKey(new Date()) });
    elements.periodError.hidden = true; saveSettings(); if (state.calendar) state.calendar.today(); renderAll();
  });
  elements.hireSummary.addEventListener("click", () => setTypeFilter("hire"));
  elements.dismissalSummary.addEventListener("click", () => setTypeFilter("dismissal"));
  elements.showAllButton.addEventListener("click", () => { state.settings.activeTypeFilter = "all"; saveSettings(); renderSummary(); renderTable(); renderCalendar(); });
  elements.createHireButton.addEventListener("click", () => openCreateModal("hire"));
  elements.createDismissalButton.addEventListener("click", () => openCreateModal("dismissal"));
  window.addEventListener("storage", handleStorageEvent);
  elements.recordsTableBody.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]");
    if (action?.dataset.action === "status") return;
    const id = action?.dataset.recordId || event.target.closest("tr")?.dataset.recordId;
    if (!id) return;
    const record = state.records.find((item) => item.id === id);
    if (!record) return;
    const handlers = { view: () => openViewModal(record), edit: () => openEditModal(record),
      duplicate: () => duplicateRecord(record), delete: () => requestDelete(record.id) };
    (handlers[action?.dataset.action] || handlers.view)();
  });
  elements.recordsTableBody.addEventListener("change", (event) => {
    const select = event.target.closest('[data-action="status"]');
    if (!select) return;
    const record = state.records.find((item) => item.id === select.dataset.recordId);
    if (!record) return;
    requestStatusChange(record.id, select.value, { onCancel: () => { select.value = record.status; } });
  });
}
function initApp() {
  cacheElements();
  const data = loadData();
  state.records = data.records; state.settings = loadSettings();
  renderPeriod(); renderSummary(); renderTable(); initializeCalendar(); bindEvents();
  if (data.issue) openStorageIssueModal(data.issue);
  else if (data.skipped) showToast(`Пропущено некорректных записей: ${data.skipped}`, "error", { duration: 7000 });
}
document.addEventListener("DOMContentLoaded", initApp);

globalThis.hrPlanner = Object.freeze({
  constants: Object.freeze({ DATA_VERSION, EVENT_TYPES, INITIAL_STATUSES, STATUSES, DEPARTMENTS, POSITIONS }),
  helpers: Object.freeze({ formatDateRu, formatRateRu, fromDateKey, getCurrentWeek, isDuplicate, isRecordInPeriod,
    normalizeFullName, normalizeFullNameForComparison, parseRate, parseStoredData, sortRecords, toDateKey, validateRecord }),
  storage: Object.freeze({ loadData, loadSettings, saveData, saveSettings }),
  operations: Object.freeze({ changeStatus, createRecord, deleteRecord, restoreRecord, updateRecord }),
  queries: Object.freeze({ getCalendarEvents, getCalendarRecords, getFilteredRecords }),
  events: Object.freeze({ handleStorageEvent }), state,
});
