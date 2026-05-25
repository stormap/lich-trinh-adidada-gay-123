import { getContext } from '../../../extensions.js';
import { generateQuietPrompt, eventSource, event_types, substituteParams } from '../../../../script.js';

const PLUGIN_ID  = 'schedule-planner';
const MODAL_ID   = 'sp-modal-root';
const FAB_ID     = 'sp-fab';
const THEME_KEY  = 'sp-theme';
const API_KEY    = 'sp-api-cfg';
const POS_KEY    = 'sp-pos';
const SIZE_KEY    = 'sp-size';
const FAB_KEY     = 'sp-fab-show';

// view: 'user' (người dùng) | 'char' (nhân vật)   charName: tên nhân vật đã xác nhận
function getCacheKey(view, charName) {
    const chatId = getContext().chatId;
    if (!chatId) return null;
    const v = view ?? currentView;
    const c = charName ?? charViewName;
    if (v === 'char' && c) return `sp-cache-${chatId}-char-${c}`;
    return `sp-cache-${chatId}-user`;
}

function loadCachedForCurrentChat(view, charName) {
    const key = getCacheKey(view, charName);
    if (!key) return null;
    try {
        const saved = JSON.parse(localStorage.getItem(key) || 'null');
        if (saved?.raw) return renderSchedule(saved.raw, saved.userName || 'Người dùng', view ?? currentView);
    } catch { /* bỏ qua bộ nhớ đệm bị lỗi */ }
    return null;
}

let currentTheme   = localStorage.getItem(THEME_KEY) || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'day' : 'night');
let cachedSchedule = null;
let isGenerating   = false;
let settingsOpen   = false;
let dragState      = null;
let resizeState    = null;
let resizeRAF      = null;
let fabDragged     = false;
let fabDragState   = null;
let currentView        = 'user';  // 'user' | 'char'
let charViewName       = null;    // tên nhân vật đã xác nhận; được bảo lưu khi chuyển sang chế độ xem người dùng
let outlineMode         = false;
let isGeneratingOutline = false;
let cachedOutline       = null;
let outlineChatHistory  = [];
let isOutlineChatting   = false;
let isFullscreen        = false;
let scheduleAbortController = null;
let outlineAbortController  = null;
const _injectTexts      = {};
let   _injectIdSeq      = 0;
let viewportSyncBound   = false;

const isMobile = () => window.innerWidth <= 640;

// ─── Khởi tạo ─────────────────────────────────────────────────────────────────────

jQuery(async () => {
    injectExtButton();
    injectModal();
    injectFab();
    injectToastContainer();
    // Đặt lại trạng thái chế độ xem và tải lại bộ nhớ đệm khi đổi cuộc trò chuyện
    eventSource.on(event_types.CHAT_CHANGED, () => {
        currentView  = 'user';
        charViewName = null;
        outlineMode  = false;
        cachedOutline = null;
        outlineChatHistory = [];
        $('.sp-view-btn').removeClass('sp-view-active');
        $(`.sp-view-btn[data-view="user"]`).addClass('sp-view-active');
        cachedSchedule = loadCachedForCurrentChat();
        if ($(`#${MODAL_ID}`).is(':visible') && !isGenerating) {
            $('#sp-outline-wrap').hide();
            $('#sp-body').show();
            $(`#${MODAL_ID} .sp-outline-btn`).removeClass('sp-btn-active');
            $('#sp-chat-msgs').empty();
            if (cachedSchedule) setBody(cachedSchedule);
            else setBody(`<div class="sp-empty"><i class="fa-regular fa-calendar"></i><p>Chưa có lịch trình, nhấn nút góc dưới bên phải để tạo</p></div>`);
        }
    });
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', e => {
        if (!localStorage.getItem(THEME_KEY)) applyTheme(e.matches ? 'day' : 'night');
    });
});

// ─── Trình hỗ trợ cấu hình ───────────────────────────────────────────────────────────

function loadCfg() { try { return JSON.parse(localStorage.getItem(API_KEY)) || {}; } catch { return {}; } }
function saveCfg(c) { localStorage.setItem(API_KEY, JSON.stringify(c)); }
function maskKey(k) { return k.length <= 8 ? '•'.repeat(k.length) : '•'.repeat(k.length - 4) + k.slice(-4); }
function fabEnabled() { return localStorage.getItem(FAB_KEY) !== 'false'; }

// ─── Bảng tiện ích mở rộng ─────────────────────────────────────────────────────────

function injectExtButton() {
    const html = `
        <div id="${PLUGIN_ID}-settings" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Lịch trình</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="sp-ext-row">
                    <button id="sp-open-btn" class="menu_button menu_button_icon">
                        <i class="fa-solid fa-calendar-days"></i>
                        <span>Mở lịch trình</span>
                    </button>
                    <label class="sp-toggle-label">
                        <input type="checkbox" id="sp-fab-check" ${fabEnabled() ? 'checked' : ''}>
                        Nút nổi
                    </label>
                </div>
            </div>
        </div>`;
    $('#extensions_settings').append(html);

    const wandHtml = `
        <div id="sp_open_wand" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-calendar-days extensionsMenuExtensionButton" title="Mở lịch trình"></div>
            <span>Lịch trình</span>
        </div>`;

    function mountWandBtn() {
        const c = document.getElementById('sp_wand_container') || document.getElementById('extensionsMenu');
        if (!c || document.getElementById('sp_open_wand')) return false;
        c.insertAdjacentHTML('beforeend', wandHtml);
        document.getElementById('sp_open_wand')?.addEventListener('click', openSchedule);
        return true;
    }
    if (!mountWandBtn()) {
        const obs = new MutationObserver(() => { if (mountWandBtn()) obs.disconnect(); });
        obs.observe(document.body, { childList: true, subtree: true });
    }

    $('#sp-open-btn').on('click', openSchedule);
    $('#sp-fab-check').on('change', function () {
        localStorage.setItem(FAB_KEY, this.checked ? 'true' : 'false');
        $(`#${FAB_ID}`).toggle(this.checked);
    });
}

function setExtBtnState(state) {
    const $btn = $('#sp-open-btn');
    $btn.removeClass('sp-btn-generating sp-btn-done');
    if (state) $btn.addClass(`sp-btn-${state}`);

    const $wandBtn = $('#sp_open_wand');
    $wandBtn.removeClass('sp-btn-generating sp-btn-done');
    if (state) $wandBtn.addClass(`sp-btn-${state}`);

    const $fab = $(`#${FAB_ID} .sp-fab-btn`);
    $fab.removeClass('sp-btn-generating sp-btn-done');
    if (state) $fab.addClass(`sp-btn-${state}`);
    $('.sp-view-toggle').toggleClass('sp-locked', state === 'generating');
}

// ─── Nút nổi (FAB) ─────────────────────────────────────────────────────────────────────

function injectFab() {
    const savedPos = JSON.parse(localStorage.getItem('sp-fab-pos') || 'null');
    const mobile = isMobile();
    const posStyle = (!mobile && savedPos)
        ? `left:${savedPos.left}px;top:${savedPos.top}px;right:auto;bottom:auto;`
        : '';
    const html = `<div id="${FAB_ID}" style="position:fixed;z-index:2000000;${posStyle}${fabEnabled() ? '' : 'display:none'}">
        <button class="sp-fab-btn sp-${currentTheme}" title="Lịch trình"
            style="width:44px;height:44px;border-radius:50%;background:#3a3648;color:#d0bcff;border:1.5px solid rgba(208,188,255,0.35);display:flex;align-items:center;justify-content:center;font-size:1rem;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,0.5);transform:translateZ(0);clip:auto;">
            <i class="fa-solid fa-calendar-days"></i>
        </button>
    </div>`;
    document.documentElement.insertAdjacentHTML('beforeend', html);

    let wasMobile = isMobile();
    window.addEventListener('resize', () => {
        const nowMobile = isMobile();
        if (nowMobile && !wasMobile) {
            const fab = document.getElementById(FAB_ID);
            if (fab) { fab.style.left = ''; fab.style.top = ''; fab.style.right = ''; fab.style.bottom = ''; }
            const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
            if (sheet) { sheet.style.left = ''; sheet.style.top = ''; sheet.style.right = '';
                         sheet.style.transform = ''; sheet.style.width = ''; sheet.style.height = ''; sheet.style.maxHeight = ''; }
        } else if (!nowMobile && wasMobile) {
            const fab = document.getElementById(FAB_ID);
            if (fab) {
                const sp = JSON.parse(localStorage.getItem('sp-fab-pos') || 'null');
                if (sp) {
                    fab.style.left   = Math.min(sp.left, window.innerWidth  - 60) + 'px';
                    fab.style.top    = Math.min(sp.top,  window.innerHeight - 60) + 'px';
                    fab.style.right  = 'auto';
                    fab.style.bottom = 'auto';
                }
            }
        }
        wasMobile = nowMobile;
    });

    $(`#${FAB_ID}`).on('mousedown', function (e) {
        fabDragged = false;
        const el   = document.getElementById(FAB_ID);
        const rect = el.getBoundingClientRect();
        fabDragState = { startX: e.clientX, startY: e.clientY, origLeft: rect.left, origTop: rect.top };
        $(document)
            .on('mousemove.fabdrag', function (ev) {
                if (!fabDragState) return;
                if (Math.abs(ev.clientX - fabDragState.startX) > 5 || Math.abs(ev.clientY - fabDragState.startY) > 5) fabDragged = true;
                if (!fabDragged) return;
                const f = document.getElementById(FAB_ID);
                f.style.left   = Math.max(0, Math.min(fabDragState.origLeft + ev.clientX - fabDragState.startX, window.innerWidth  - f.offsetWidth))  + 'px';
                f.style.top    = Math.max(0, Math.min(fabDragState.origTop  + ev.clientY - fabDragState.startY, window.innerHeight - f.offsetHeight)) + 'px';
                f.style.right  = 'auto';
                f.style.bottom = 'auto';
            })
            .on('mouseup.fabdrag', onFabDragEnd);
    });
    document.getElementById(FAB_ID).addEventListener('touchstart', function (e) {
        fabDragged = false;
        const el   = document.getElementById(FAB_ID);
        const rect = el.getBoundingClientRect();
        fabDragState = { startX: e.touches[0].clientX, startY: e.touches[0].clientY, origLeft: rect.left, origTop: rect.top };
        document.addEventListener('touchmove', onFabTouchMove, { passive: false });
        document.addEventListener('touchend', onFabDragEnd);
    }, { passive: true });

    $(`#${FAB_ID} .sp-fab-btn`).on('click', function () {
        if (!fabDragged) {
            $(`#${MODAL_ID}`).is(':visible') ? closePanel() : openSchedule();
        }
    });
}

function onFabTouchMove(ev) {
    if (!fabDragState) return;
    const ex = ev.touches[0].clientX;
    const ey = ev.touches[0].clientY;
    if (Math.abs(ex - fabDragState.startX) > 5 || Math.abs(ey - fabDragState.startY) > 5) fabDragged = true;
    if (!fabDragged) return;
    ev.preventDefault();
    const f = document.getElementById(FAB_ID);
    f.style.left   = Math.max(0, Math.min(fabDragState.origLeft + ex - fabDragState.startX, window.innerWidth  - f.offsetWidth))  + 'px';
    f.style.top    = Math.max(0, Math.min(fabDragState.origTop  + ey - fabDragState.startY, window.innerHeight - f.offsetHeight)) + 'px';
    f.style.right  = 'auto';
    f.style.bottom = 'auto';
}
function onFabDragEnd() {
    if (fabDragged) {
        const f = document.getElementById(FAB_ID);
        const r = f.getBoundingClientRect();
        localStorage.setItem('sp-fab-pos', JSON.stringify({ left: r.left, top: r.top }));
    }
    fabDragState = null;
    $(document).off('mousemove.fabdrag mouseup.fabdrag');
    document.removeEventListener('touchmove', onFabTouchMove);
    document.removeEventListener('touchend',  onFabDragEnd);
}

function injectModal() {
    const cfg = loadCfg();
    const hasCustomApi = !!(cfg.url && cfg.key);
    const html = `
        <div id="${MODAL_ID}" class="sp-root sp-${currentTheme}" style="display:none;position:fixed;z-index:2000001">
            <div class="sp-backdrop"></div>
            <div class="sp-sheet">
                <div class="sp-topbar" id="sp-drag-handle">
                    <span class="sp-topbar-title"><i class="fa-solid fa-calendar-days"></i></span>
                    <div class="sp-view-toggle">
                        <button class="sp-view-btn sp-view-active" data-view="user">Tôi</button>
                        <button class="sp-view-btn" data-view="char">TA</button>
                        <button class="sp-view-btn" data-view="outline">Đề cương</button>
                    </div>
                    <div class="sp-topbar-actions">
                        <button class="sp-icon-btn sp-maximize-btn" title="Toàn màn hình"><i class="fa-solid fa-expand"></i></button>
                        <button class="sp-icon-btn sp-settings-btn" title="Cài đặt"><i class="fa-solid fa-gear"></i></button>
                        <button class="sp-icon-btn sp-theme-btn"    title="Đổi chủ đề"><i class="fa-solid fa-circle-half-stroke"></i></button>
                        <button class="sp-icon-btn sp-regen-btn"    title="Tạo lại"><i class="fa-solid fa-rotate-right"></i></button>
                        <button class="sp-icon-btn sp-close-btn"    title="Đóng"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                </div>

                <div id="sp-settings-panel" class="sp-settings-panel" style="display:none">
                    <div class="sp-api-notice ${hasCustomApi ? 'sp-notice-ok' : 'sp-notice-warn'}">
                        <i class="fa-solid ${hasCustomApi ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i>
                        ${hasCustomApi
                            ? 'Đã cấu hình API riêng, việc tạo ngầm không ảnh hưởng đến trò chuyện'
                            : 'Chưa cấu hình API riêng: Trong lúc tạo sẽ <b>chiếm dụng kênh chat</b>, không thể trò chuyện đồng thời'}
                    </div>
                    <p class="sp-cfg-hint">API tùy chỉnh (để trống nếu dùng mô hình hiện tại của quán)</p>
                    <input id="sp-cfg-url"   class="sp-input" type="url"
                           placeholder="Base URL, ví dụ https://api.openai.com/v1"
                           value="${escapeAttr(cfg.url || '')}">
                    <div class="sp-key-row">
                        <input id="sp-cfg-key" class="sp-input sp-key-input" type="password"
                               placeholder="API Key" value="${escapeAttr(cfg.key || '')}">
                        <button id="sp-key-toggle" class="sp-eye-btn"><i class="fa-solid fa-eye"></i></button>
                    </div>
                    <div class="sp-model-row">
                        <input id="sp-cfg-model" class="sp-input sp-model-input" type="text"
                               placeholder="Tên mô hình, ví dụ gpt-4o-mini"
                               value="${escapeAttr(cfg.model || '')}">
                        <button id="sp-fetch-models" class="sp-fetch-btn" title="Lấy danh sách mô hình">
                            <i class="fa-solid fa-list"></i>
                        </button>
                    </div>
                    <button id="sp-cfg-save" class="sp-save-btn"><i class="fa-solid fa-floppy-disk"></i> Lưu</button>
                    <span id="sp-cfg-msg" class="sp-cfg-msg"></span>
                </div>

                <div class="sp-body" id="sp-body">
                    <div class="sp-empty"><i class="fa-regular fa-calendar"></i><p>Nhấn nút làm mới ở góc trên bên phải để tạo lịch trình</p></div>
                </div>

                <div class="sp-outline-wrap" id="sp-outline-wrap" style="display:none">
                    <div class="sp-outline-beats" id="sp-outline-beats">
                        <div class="sp-empty"><i class="fa-solid fa-scroll"></i><p>Nhấn nút tạo ở góc trên bên phải để tạo đề cương</p></div>
                    </div>
                    <div class="sp-outline-divider" id="sp-outline-divider">
                        <i class="fa-solid fa-grip-lines"></i>
                    </div>
                    <div class="sp-outline-chat" id="sp-outline-chat">
                        <div class="sp-chat-msgs" id="sp-chat-msgs"></div>
                        <div class="sp-chat-input-row">
                            <input type="text" id="sp-chat-input" class="sp-input" placeholder="Thảo luận đề cương với AI…">
                            <button id="sp-chat-send" class="sp-icon-btn" title="Gửi"><i class="fa-solid fa-paper-plane"></i></button>
                        </div>
                    </div>
                </div>

                <div class="sp-resize-handle" id="sp-resize-handle">
                    <i class="fa-solid fa-up-right-and-down-left-from-center"></i>
                </div>
            </div>
        </div>`;
    document.documentElement.insertAdjacentHTML('beforeend', html);

    if (cfg.key) $('#sp-cfg-key').val(maskKey(cfg.key)).data('real', cfg.key);

    $(`#${MODAL_ID} .sp-close-btn`).on('click',    closePanel);
    $(`#${MODAL_ID} .sp-theme-btn`).on('click',    toggleTheme);
    $(`#${MODAL_ID} .sp-regen-btn`).on('click',    onRegenClick);
    $(`#${MODAL_ID} .sp-maximize-btn`).on('click', toggleFullscreen);
    $(`#${MODAL_ID} .sp-settings-btn`).on('click', toggleSettings);
    $(`#${MODAL_ID} .sp-backdrop`).on('click',     closePanel);

    // Trò chuyện về đề cương
    function doSendChat() {
        const msg = $('#sp-chat-input').val().trim();
        if (msg && !isOutlineChatting) { $('#sp-chat-input').val(''); sendOutlineChat(msg); }
    }
    $('#sp-chat-send').on('click', doSendChat);
    $('#sp-chat-input').on('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSendChat(); } });

    // Tiêm các nút (ủy quyền sự kiện)
    $(`#sp-body, #sp-outline-wrap`).on('click', '.sp-inject-btn', function () {
        const text = _injectTexts[$(this).data('iid')];
        if (text) injectToST(text);
    });

    // Các nút hủy (ủy quyền sự kiện)
    $('#sp-body').on('click', '#sp-abort-generate', () => scheduleAbortController?.abort());
    $('#sp-outline-beats').on('click', '#sp-abort-outline', () => outlineAbortController?.abort());

    // Chuyển đổi chế độ xem: Tôi / TA / Đề cương
    $(`#${MODAL_ID} .sp-view-toggle`).on('click', '.sp-view-btn', function () {
        if (isGenerating) return;
        const view = $(this).data('view');

        if (view === 'outline') {
            if (outlineMode) return;
            outlineMode = true;
            $('.sp-view-btn').removeClass('sp-view-active');
            $(this).addClass('sp-view-active');
            $('#sp-body').hide();
            $('#sp-outline-wrap').css('display', 'flex');
            cachedOutline = loadCachedOutlineForCurrentChat();
            if (cachedOutline) setOutlineBody(cachedOutline);
            return;
        }

        // Thoát khỏi chế độ đề cương
        let wasOutline = false;
        if (outlineMode) {
            outlineMode = false;
            wasOutline = true;
            $('#sp-outline-wrap').hide();
            $('#sp-body').show();
        }

        if (view === currentView && !wasOutline) return;
        if (view === 'char') {
            if (charViewName) {
                setView('char', charViewName);
                if (cachedSchedule) setBody(cachedSchedule);
                else showEmptyGenerate();
            } else {
                switchToCharView();
            }
        } else {
            setView('user');
            if (cachedSchedule) setBody(cachedSchedule);
            else showEmptyGenerate();
        }
    });

    $('#sp-cfg-save').on('click',      saveSettings);
    $('#sp-key-toggle').on('click',    toggleKeyVisibility);
    $('#sp-fetch-models').on('click',  fetchModels);
    $('#sp-cfg-key')
        .on('focus', () => { const r = $('#sp-cfg-key').data('real'); if (r) $('#sp-cfg-key').val(r); })
        .on('blur',  () => { const r = $('#sp-cfg-key').val().trim() || $('#sp-cfg-key').data('real') || ''; if (r) $('#sp-cfg-key').data('real', r).val(maskKey(r)); });

    $('#sp-body').on('click', '.sp-tab', function () {
        const idx   = parseInt($(this).data('day'));
        const total = parseInt($('.sp-days-track').data('total')) || 4;
        $('.sp-tab').removeClass('sp-tab-active');
        $(this).addClass('sp-tab-active');
        $('.sp-days-track').css('transform', `translateX(-${idx * 100 / total}%)`);
    });

    $('#sp-drag-handle').on('mousedown', onDragStart);
    document.getElementById('sp-drag-handle').addEventListener('touchstart', onDragStart, { passive: false });
    $('#sp-resize-handle').on('mousedown', onResizeStart);
    document.getElementById('sp-resize-handle').addEventListener('touchstart', onResizeStart, { passive: false });

    // Kéo thanh chia đề cương
    let divState = null;
    const divEl  = document.getElementById('sp-outline-divider');
    const chatEl = document.getElementById('sp-outline-chat');
    function onDivStart(e) {
        e.preventDefault();
        const savedH = parseInt(localStorage.getItem('sp-outline-chat-h')) || 210;
        chatEl.style.height = savedH + 'px';
        divState = { startY: e.touches ? e.touches[0].clientY : e.clientY, startH: chatEl.offsetHeight };
        document.addEventListener('mousemove', onDivMove);
        document.addEventListener('mouseup',   onDivEnd);
        document.addEventListener('touchmove', onDivMove, { passive: false });
        document.addEventListener('touchend',  onDivEnd);
    }
    function onDivMove(e) {
        if (!divState) return;
        e.preventDefault();
        const cy   = e.touches ? e.touches[0].clientY : e.clientY;
        const newH = Math.max(80, Math.min(420, divState.startH + divState.startY - cy));
        chatEl.style.height = newH + 'px';
    }
    function onDivEnd() {
        if (!divState) return;
        localStorage.setItem('sp-outline-chat-h', chatEl.offsetHeight);
        divState = null;
        document.removeEventListener('mousemove', onDivMove);
        document.removeEventListener('mouseup',   onDivEnd);
        document.removeEventListener('touchmove', onDivMove);
        document.removeEventListener('touchend',  onDivEnd);
    }
    divEl.addEventListener('mousedown',  onDivStart);
    divEl.addEventListener('touchstart', onDivStart, { passive: false });
    restoreOutlineChatHeight();
}

// ─── Chế độ xem (Tôi / TA) ───────────────────────────────────────────────────────────

function onRegenClick() {
    if (outlineMode) {
        triggerGenerateOutline();
        return;
    }
    if (isGenerating) return;
    if (currentView === 'char') {
        // Xóa bộ nhớ đệm nhân vật và hiển thị lại trình chọn để người dùng chọn nhân vật khác.
        const key = getCacheKey();
        if (key) localStorage.removeItem(key);
        cachedSchedule = null;
        switchToCharView();   // điền trước với charViewName hiện tại
        charViewName   = null; // xóa sau khi trình chọn được hiển thị
    } else {
        triggerGenerate();
    }
}

function guessCharName(ctx) {
    // Ưu tiên 1: tên trên thẻ nhân vật
    if (ctx.name2) return ctx.name2;
    // Ưu tiên 2: mẫu "Tên:" xuất hiện thường xuyên nhất trong các tin nhắn AI gần đây
    const NOISE = new Set(['series','chapter','note','summary','part','vol','act','scene',
                           'title','author','narrator','system','user','assistant','ai']);
    const msgs = (ctx.chat || []).filter(m => !m.is_user).slice(-20);
    const counts = {};
    for (const m of msgs) {
        const matches = [...(m.mes || '').matchAll(/^([^\s：:「」【\[\n*#]{1,12})[：:]/gm)];
        for (const match of matches) {
            const name = match[1].trim();
            if (name && !/[*#<>{}\[\]|\\]/.test(name) && !NOISE.has(name.toLowerCase()))
                counts[name] = (counts[name] || 0) + 1;
        }
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return sorted[0]?.[0] || '';
}

function setView(view, charName) {
    currentView = view;
    if (view === 'char') charViewName = charName || null;
    $('.sp-view-btn').removeClass('sp-view-active');
    $(`.sp-view-btn[data-view="${view}"]`).addClass('sp-view-active');
    cachedSchedule = loadCachedForCurrentChat();
    cachedOutline  = loadCachedOutlineForCurrentChat();
    outlineChatHistory = [];
    $('#sp-chat-msgs').empty();
    if (outlineMode && cachedOutline) setOutlineBody(cachedOutline);
}

function switchToCharView() {
    currentView = 'char';
    const ctx     = getContext();
    // Ưu tiên tên đã xác nhận trước đó; nếu không thì đoán từ tin nhắn chat
    const guessed = charViewName || guessCharName(ctx);
    setBody(`<div class="sp-char-picker">
        <p class="sp-char-picker-hint"><i class="fa-solid fa-user-pen"></i> Nhập tên nhân vật bạn muốn xem lịch trình</p>
        <div class="sp-char-picker-row">
            <input id="sp-char-name-input" class="sp-input" type="text"
                   placeholder="Tên nhân vật" value="${escapeAttr(guessed)}">
            <button id="sp-char-name-confirm" class="sp-save-btn">Xác nhận</button>
        </div>
        ${guessed ? `<p class="sp-char-picker-sub">Đã điền trước dựa trên hội thoại gần đây, có thể sửa trực tiếp</p>` : ''}
    </div>`);
    $('.sp-view-btn').removeClass('sp-view-active');
    $(`.sp-view-btn[data-view="char"]`).addClass('sp-view-active');
    
    $('#sp-char-name-input').off('keydown.charview').on('keydown.charview', e => { if (e.key === 'Enter') confirmCharView(); });
    $('#sp-char-name-confirm').off('click.charview').on('click.charview', confirmCharView);
    setTimeout(() => { $('#sp-char-name-input').focus().select(); }, 50);
}

function confirmCharView() {
    const name = $('#sp-char-name-input').val().trim();
    if (!name) { $('#sp-char-name-input').focus(); return; }
    setView('char', name);
    if (cachedSchedule) {
        setBody(cachedSchedule);
    } else {
        setBody(`<div class="sp-loading"><div class="sp-spinner"></div><p class="sp-loading-text">Đang lập kế hoạch…</p><button class="sp-abort-btn" id="sp-abort-generate"><i class="fa-solid fa-stop"></i>Hủy tạo</button></div>`);
        if (!isGenerating) {
            isGenerating = true;
            setExtBtnState('generating');
            runGenerate();
        }
    }
}

// ─── Mở / Đóng ─────────────────────────────────────────────────────────────

function openSchedule() {
    showPanel();
    if (isGenerating) {
        setBody(`<div class="sp-loading"><div class="sp-spinner"></div><p class="sp-loading-text">Đang lập kế hoạch…</p><button class="sp-abort-btn" id="sp-abort-generate"><i class="fa-solid fa-stop"></i>Hủy tạo</button></div>`);
    } else if (cachedSchedule) {
        setBody(cachedSchedule);
    } else {
        showEmptyGenerate();
    }
}

function showEmptyGenerate() {
    setBody(`<div class="sp-empty">
        <i class="fa-regular fa-calendar"></i>
        <button class="sp-gen-btn" id="sp-gen-now">Tạo lịch trình</button>
    </div>`);
    $('#sp-gen-now').on('click', triggerGenerate);
}

function showPanel() {
    const $root  = $(`#${MODAL_ID}`);
    const sheet  = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    if (sheet) sheet.style.animation = '';
    $root.stop(true).css({ display: 'block', opacity: 0 })
         .animate({ opacity: 1 }, 180);
    setTimeout(() => {
        positionPanel();
        syncMobileViewport();
    }, 0);
}

function closePanel() {
    $(`#${MODAL_ID}`).stop(true).animate({ opacity: 0 }, 150, function () {
        $(this).css('display', 'none');
    });
}

function setBody(html) { $('#sp-body').html(html); }

// ─── Quá trình tạo (Generation) ───────────────────────────────────────────────────────────────

function triggerGenerate() {
    if (isGenerating) return;
    const key = getCacheKey();
    if (key) localStorage.removeItem(key);
    cachedSchedule = null;
    isGenerating = true;
    setExtBtnState('generating');
    if (!$(`#${MODAL_ID}`).is(':visible')) showPanel();
    setBody(`<div class="sp-loading"><div class="sp-spinner"></div><p class="sp-loading-text">Đang lập kế hoạch…</p><button class="sp-abort-btn" id="sp-abort-generate"><i class="fa-solid fa-stop"></i>Hủy tạo</button></div>`);
    runGenerate();
}

async function runGenerate() {
    const viewSnap = currentView;
    const charSnap = charViewName;
    scheduleAbortController = new AbortController();
    try {
        const ctx      = getContext();
        const userName = ctx.name1 || 'Người dùng';
        const charName = viewSnap === 'char' ? (charSnap || ctx.name2 || 'Nhân vật') : (ctx.name2 || 'Nhân vật');
        const subject  = viewSnap === 'char' ? charName : userName;
        const raw      = await generate(ctx, userName, charName, viewSnap, scheduleAbortController.signal);
        const html     = renderSchedule(raw, subject, viewSnap);

        const cacheKey = getCacheKey(viewSnap, charSnap);
        if (cacheKey) localStorage.setItem(cacheKey, JSON.stringify({ raw, userName: subject, ts: Date.now() }));
        isGenerating = false;
        scheduleAbortController = null;
        setExtBtnState('done');

        if (viewSnap === 'char') charViewName = charSnap;

        const stillOnView = currentView === viewSnap &&
            (viewSnap !== 'char' || charViewName === charSnap);
        if (stillOnView) {
            cachedSchedule = html;
            if ($(`#${MODAL_ID}`).is(':visible')) setBody(html);
            else showToast('Đã tạo lịch trình, nhấn để xem', () => { showPanel(); setBody(html); });
        } else {
            showToast('Đã tạo lịch trình, nhấn để xem', () => {
                setView(viewSnap, charSnap);
                cachedSchedule = html;
                showPanel();
                setBody(html);
            });
        }
        setTimeout(() => setExtBtnState(null), 6000);
    } catch (err) {
        isGenerating = false;
        scheduleAbortController = null;
        setExtBtnState(null);
        if (err.name === 'AbortError') {
            if ($(`#${MODAL_ID}`).is(':visible') && currentView === viewSnap) showEmptyGenerate();
            return;
        }
        const errHtml = `<div class="sp-error"><i class="fa-solid fa-circle-exclamation"></i><p>Tạo thất bại: ${escapeHtml(err.message || 'Lỗi không xác định')}</p></div>`;
        if ($(`#${MODAL_ID}`).is(':visible') && currentView === viewSnap) setBody(errHtml);
        else showToast('Tạo lịch trình thất bại, vui lòng thử lại', null, true);
    }
}

async function generate(ctx, userName, charName, perspective = 'user', signal = null) {
    const cfg = loadCfg();
    if (!cfg.url || !cfg.key) {
        if (!settingsOpen) toggleSettings();
        throw new Error('Vui lòng điền URL và Key của API tùy chỉnh trong phần cài đặt');
    }
    const prompt = buildPrompt(userName, charName, perspective);
    return callCustomApi(ctx, prompt, cfg, userName, charName, signal);
}

async function callCustomApi(ctx, prompt, cfg, userName, charName, signal = null) {
    const messages = await buildMessages(ctx, prompt, userName, charName);
    const res = await fetch(`${cfg.url}/chat/completions`, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.key}` },
        body   : JSON.stringify({ model: cfg.model || 'gpt-4o-mini', messages, max_tokens: 4096 }),
        signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 120)}`);
    return (await res.json()).choices?.[0]?.message?.content ?? '';
}

async function buildWorldInfoContext(ctx) {
    const parts = [];
    // 1. Sách thế giới tích hợp trong thẻ nhân vật (character_book)
    const char = ctx.characters?.[ctx.characterId] ?? {};
    const charBook = char.data?.character_book;
    if (charBook?.entries?.length) {
        const entries = charBook.entries
            .filter(e => !e.disabled)
            .map(e => e.content)
            .filter(Boolean);
        if (entries.length) parts.push(`【Sách thế giới của nhân vật】\n${entries.join('\n\n')}`);
    }
    // 2. Sách thế giới được kích hoạt toàn cục
    try {
        const wiData = await ctx.getWorldInfoPrompt(ctx.chat ?? [], 999999, true);
        if (wiData?.worldInfoString) parts.push(`【Sách thế giới】\n${wiData.worldInfoString}`);
    } catch { /* ignore */ }
    return parts.join('\n\n');
}

async function buildMessages(ctx, prompt, userName, charName) {
    const char = ctx.characters?.[ctx.characterId] ?? {};
    const wiContext = await buildWorldInfoContext(ctx);
    const sys  = [
        `Bạn là một trợ lý phân tích tự sự và người quan sát, có nhiệm vụ phân tích câu chuyện giữa ${userName} và ${charName} từ góc nhìn ngôi thứ ba.`,
        `Không đóng vai bất kỳ nhân vật nào, không sử dụng ngôi thứ nhất. Mọi đầu ra phải là lời kể ở ngôi thứ ba.`,
        char.description ? `【Thông tin bối cảnh của ${charName}】\n${char.description}` : '',
        char.personality ? `【Tính cách】${char.personality}` : '',
        char.scenario    ? `【Kịch bản】${char.scenario}`    : '',
        wiContext,
    ].filter(Boolean).join('\n\n');
    
    const allMsgs = ctx.chat ?? [];
    let aiCount = 0;
    let startIdx = allMsgs.length;
    for (let i = allMsgs.length - 1; i >= 0; i--) {
        if (!allMsgs[i].is_user) aiCount++;
        if (aiCount >= 10) { startIdx = i; break; }
    }
    const history = allMsgs.slice(startIdx).map(m => ({
        role   : m.is_user ? 'user' : 'assistant',
        content: substituteParams(m.mes ?? ''),
    }));
    return [{ role: 'system', content: sys }, ...history, { role: 'user', content: prompt }];
}

// ─── Trình hỗ trợ bộ nhớ đệm đề cương ────────────────────────────────────────────────────

function getOutlineCacheKey(view, charName) {
    const chatId = getContext().chatId;
    if (!chatId) return null;
    const v = view ?? currentView;
    const c = charName ?? charViewName;
    if (v === 'char' && c) return `sp-cache-${chatId}-outline-char-${c}`;
    return `sp-cache-${chatId}-outline-user`;
}

function loadCachedOutlineForCurrentChat(view, charName) {
    const key = getOutlineCacheKey(view, charName);
    if (!key) return null;
    try {
        const saved = JSON.parse(localStorage.getItem(key) || 'null');
        if (saved?.raw) return renderOutline(saved.raw);
    } catch { /* ignore */ }
    return null;
}

// ─── Tiêm nội dung (Inject) ───────────────────────────────────────────────────────────────────

function makeInjectBtn(text) {
    const id = ++_injectIdSeq;
    _injectTexts[id] = text;
    return `<button class="sp-inject-btn" data-iid="${id}" title="Tiêm vào khung nhập"><i class="fa-solid fa-arrow-right-to-bracket"></i></button>`;
}

function injectToST(text) {
    const $ta = $('#send_textarea');
    if (!$ta.length) { showToast('Không tìm thấy khung nhập liệu', null, true); return; }
    $ta.val(text).trigger('input');
    showToast('Đã tiêm vào khung nhập');
}

// ─── Chat đề cương ─────────────────────────────────────────────────────────────

function appendChatMsg(role, content) {
    const display = content.replace(/<outline_widget[\s\S]*?<\/outline_widget>/gi, '[↑ Đã tạo đề cương mới]');
    const cls = role === 'user' ? 'sp-chat-msg-user' : role === 'ai' ? 'sp-chat-msg-ai' : 'sp-chat-msg-system';
    $('<div>').addClass(`sp-chat-msg ${cls}`)
        .html(escapeHtml(display).replace(/\n/g, '<br>'))
        .appendTo('#sp-chat-msgs');
    const el = document.getElementById('sp-chat-msgs');
    if (el) el.scrollTop = el.scrollHeight;
}

async function buildOutlineChatMessages(userMsg) {
    const ctx      = getContext();
    const userName = ctx.name1 || 'Người dùng';
    const charName = currentView === 'char' ? (charViewName || ctx.name2 || 'Nhân vật') : (ctx.name2 || 'Nhân vật');
    let outlineCtx = '';
    try {
        const key  = getOutlineCacheKey();
        const saved = key && JSON.parse(localStorage.getItem(key) || 'null');
        if (saved?.raw) outlineCtx = `\nĐề cương hiện tại:\n${saved.raw}\n`;
    } catch { /* ignore */ }
    const wiContext = await buildWorldInfoContext(ctx);
    const sys = [`Bạn là một cố vấn sáng tác câu chuyện, đang giúp người dùng hoàn thiện đề cương câu chuyện giữa ${userName} và ${charName}. ${outlineCtx}`,
        wiContext,
        `Hãy trả lời với tư cách là cố vấn sáng tác, không đóng vai bất kỳ nhân vật nào. Nếu người dùng yêu cầu sửa đổi đề cương, hãy xuất đề cương mới đầy đủ ở cuối câu trả lời (định dạng giống hệt đề cương cũ, bọc trong thẻ <outline_widget>...</outline_widget>).`,
    ].filter(Boolean).join('\n');
    return [{ role: 'system', content: sys }, ...outlineChatHistory, { role: 'user', content: userMsg }];
}

async function sendOutlineChat(userMsg) {
    if (isOutlineChatting) return;
    appendChatMsg('user', userMsg);
    outlineChatHistory.push({ role: 'user', content: userMsg });
    isOutlineChatting = true;
    const $dots = $('<div>').addClass('sp-chat-msg sp-chat-msg-ai sp-chat-thinking').text('…').appendTo('#sp-chat-msgs');
    const el = document.getElementById('sp-chat-msgs');
    if (el) el.scrollTop = el.scrollHeight;
    try {
        const cfg = loadCfg();
        if (!cfg.url || !cfg.key) { if (!settingsOpen) toggleSettings(); throw new Error('Vui lòng cấu hình API'); }
        const res = await fetch(`${cfg.url}/chat/completions`, {
            method : 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.key}` },
            body   : JSON.stringify({ model: cfg.model || 'gpt-4o-mini', messages: await buildOutlineChatMessages(userMsg), max_tokens: 4096 }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const reply = (await res.json()).choices?.[0]?.message?.content ?? '';
        outlineChatHistory.push({ role: 'assistant', content: reply });
        $dots.remove();
        appendChatMsg('ai', reply);
        if (/<outline_widget/i.test(reply)) {
            const pendingRaw = reply;
            const $btn = $('<button class="sp-apply-outline-btn">Áp dụng đề cương này</button>');
            $btn.on('click', () => {
                const html = renderOutline(pendingRaw);
                setOutlineBody(html);
                cachedOutline = html;
                const key = getOutlineCacheKey();
                if (key) localStorage.setItem(key, JSON.stringify({ raw: pendingRaw, ts: Date.now() }));
                $btn.text('✓ Đã áp dụng').prop('disabled', true);
            });
            $('<div class="sp-chat-msg sp-chat-msg-system sp-apply-row"></div>').append($btn).appendTo('#sp-chat-msgs');
            const el2 = document.getElementById('sp-chat-msgs');
            if (el2) el2.scrollTop = el2.scrollHeight;
        }
    } catch (err) {
        $dots.remove();
        appendChatMsg('system', `Gửi thất bại: ${err.message}`);
    }
    isOutlineChatting = false;
}

function toggleOutlineMode() {
    outlineMode = !outlineMode;
    $('.sp-view-btn').removeClass('sp-view-active');
    if (outlineMode) {
        $(`.sp-view-btn[data-view="outline"]`).addClass('sp-view-active');
        $('#sp-body').hide();
        $('#sp-outline-wrap').css('display', 'flex');
        cachedOutline = loadCachedOutlineForCurrentChat();
        if (cachedOutline) setOutlineBody(cachedOutline);
    } else {
        $(`.sp-view-btn[data-view="${currentView}"]`).addClass('sp-view-active');
        $('#sp-outline-wrap').hide();
        $('#sp-body').show();
    }
}

function setOutlineBody(html) { $('#sp-outline-beats').html(html); }

// ─── Tạo đề cương ───────────────────────────────────────────────────────

function triggerGenerateOutline() {
    if (isGeneratingOutline) return;
    const key = getOutlineCacheKey();
    if (key) localStorage.removeItem(key);
    cachedOutline = null;
    isGeneratingOutline = true;
    setOutlineBody(`<div class="sp-loading"><div class="sp-spinner"></div><p class="sp-loading-text">Đang phác thảo đề cương…</p><button class="sp-abort-btn" id="sp-abort-outline"><i class="fa-solid fa-stop"></i>Hủy tạo</button></div>`);
    runGenerateOutline();
}

async function runGenerateOutline() {
    const viewSnap = currentView;
    const charSnap = charViewName;
    outlineAbortController = new AbortController();
    try {
        const ctx      = getContext();
        const userName = ctx.name1 || 'Người dùng';
        const charName = viewSnap === 'char' ? (charSnap || ctx.name2 || 'Nhân vật') : (ctx.name2 || 'Nhân vật');
        const cfg = loadCfg();
        if (!cfg.url || !cfg.key) {
            if (!settingsOpen) toggleSettings();
            throw new Error('Vui lòng điền URL và Key của API tùy chỉnh trong phần cài đặt');
        }
        const prompt   = buildOutlinePrompt(userName, charName, viewSnap);
        const raw      = await callCustomApi(ctx, prompt, cfg, userName, charName, outlineAbortController.signal);
        const html     = renderOutline(raw);
        const cacheKey = getOutlineCacheKey(viewSnap, charSnap);
        if (cacheKey) localStorage.setItem(cacheKey, JSON.stringify({ raw, ts: Date.now() }));
        isGeneratingOutline = false;
        outlineAbortController = null;
        cachedOutline = html;
        if (outlineMode) setOutlineBody(html);
        else showToast('Đã tạo đề cương, nhấn để xem', () => { if (!outlineMode) toggleOutlineMode(); showPanel(); });
    } catch (err) {
        isGeneratingOutline = false;
        outlineAbortController = null;
        if (err.name === 'AbortError') {
            if (outlineMode) setOutlineBody(`<div class="sp-empty"><i class="fa-solid fa-scroll"></i><p>Đã hủy</p></div>`);
            return;
        }
        const errHtml = `<div class="sp-error"><i class="fa-solid fa-circle-exclamation"></i><p>Tạo thất bại: ${escapeHtml(err.message || 'Lỗi không xác định')}</p></div>`;
        if (outlineMode) setOutlineBody(errHtml);
        else showToast('Tạo đề cương thất bại, vui lòng thử lại', null, true);
    }
}

function buildOutlinePrompt(userName, charName, perspective = 'user') {
    const subject = perspective === 'char' ? charName : userName;
    return `Vui lòng tạm dừng đóng vai, với tư cách cố vấn biên kịch dựa trên cốt truyện trên, hãy tạo đề cương cho câu chuyện hiện tại.
【Quan trọng】Mọi nội dung phải sử dụng tiếng Việt (tên người, địa danh có thể giữ nguyên gốc).

【Bước 1: Phân tích nền tảng câu chuyện】
Trước khi tạo các nút thắt, hãy tóm lược các nội dung sau trong phần chú thích (trên 300 chữ):
① Trạng thái hiện tại: Tình hình hiện tại của các nhân vật chính (bao gồm ${subject} và các nhân vật then chốt khác), mục tiêu của mỗi người, các mâu thuẫn chưa được giải quyết.
② Quan hệ chính phụ: Nhân vật chính yếu, nhân vật phụ quan trọng, thế lực đối lập và trọng số của họ trong cốt truyện.
③ Điểm hấp dẫn/Sức hút cốt lõi: Căng thẳng kịch tính thu hút nhất trong câu chuyện này là gì? (ví dụ: "lợi dụng lẫn nhau nhưng nảy sinh tình cảm", "cùng chống kẻ thù nhưng bất đồng quan điểm", "cứu rỗi và được cứu rỗi")
④ Hiện trạng và xu hướng môi trường bên ngoài: Cân bằng thế lực hiện tại, khủng hoảng xã hội, các sự kiện lớn sắp xảy ra, v.v., và diễn biến tự nhiên nếu không có sự can thiệp.
⑤ Mô hình cốt truyện: Đây là loại câu chuyện gì? Động lực nội tại là gì? (ví dụ: "đấu tranh sinh tồn dưới áp lực bên ngoài + sự tiến hóa của các mối quan hệ nội bộ" hoặc "hành trình trả thù cá nhân và cứu rỗi")
⑥ Tổng hợp các tuyến truyện: Liệt kê ít nhất hai tuyến truyện - 【Tuyến chính】(mục tiêu bên ngoài, nhiệm vụ, đối đầu thế lực ngoại lai) và 【Tuyến tình cảm】(thay đổi quan hệ tình cảm giữa các nhân vật chính). Nếu cần thiết có thể thêm tuyến phát triển cá nhân, tuyến đấu tranh thế lực, v.v.
⑦ Đặc điểm hành vi và phong cách ngôn ngữ của các nhân vật chính, đảm bảo biểu hiện của nhân vật trong các nút thắt phù hợp với thiết lập gốc.

【Bước 2: Tạo các nút thắt then chốt, mục tiêu 8 nút】
Các nút thắt phải dựa trên phân tích nêu trên, thể hiện mô hình cốt truyện bạn đã xác định.
- Tuyến truyện cần tiến triển theo hình xoắn ốc (tiến → lùi → tái tiến), không phát triển theo đường thẳng.
- Các nút thắt bao quát toàn bộ vòng cung câu chuyện: Trạng thái mở đầu → Ma sát/Thăm dò → Tiến triển lần đầu → Thất bại/Rút lui → Khủng hoảng bùng phát → Bước ngoặt then chốt → Dư chấn → Cân bằng mới. Mỗi giai đoạn 1 nút thắt.
- Nội dung Scene và Think của mỗi nút thắt phải phong phú, không nén chất lượng.

【Yêu cầu tiêu đề】Dưới 10 chữ, mang cảm giác văn học - trích từ thơ văn cổ, lời bài hát thực tế hoặc danh ngôn tiểu thuyết/phim ảnh. Phong cách tiêu đề các nút thắt không được giống hệt nhau, ít nhất sử dụng thơ cổ/lời nhạc/tiểu thuyết mỗi loại một lần. Không tự tạo các cụm từ hoa mỹ không có nguồn gốc.

【Giải thích các trường】
Beat: Thời gian suy diễn|Tiêu đề|Loại|Tuyến truyện thuộc về|Kết quả
Scene: Điều gì thực sự đã xảy ra trong cảnh này (80-120 chữ)
Subtext: Câu nói chưa thốt ra hoặc cảm xúc ẩn giấu trong một hành động vô thức của ai đó trong cảnh này (không quá 40 chữ)
Think: Suy nghĩ sáng tác (100-150 chữ), phải bao gồm:
 ① Cách thể hiện sức hút cốt lõi và mô hình cốt truyện.
 ② Trạng thái tâm lý của nhân vật chính (ít nhất một người) tại thời điểm này.
 ③ Tác dụng thúc đẩy đối với các tuyến truyện.
 ④ Đang ở vị trí nào trong tiến trình xoắn ốc (so với nút thắt trước đó).

【Định dạng đầu ra (tuân thủ nghiêm ngặt)】
<outline_widget>
Beat: Thời gian suy diễn|Tiêu đề|Loại|Tuyến truyện thuộc về|Kết quả
Scene: …
Subtext: …
Think: …
(Tổng cộng 8 nút thắt, mỗi nút lặp lại cấu trúc trên)
</outline_widget>`;}

// ─── Phân tích / Hiển thị đề cương ───────────────────────────────────────────────────

function parseOutline(raw) {
    const m = raw.match(/<outline_widget[^>]*>([\s\S]*?)<\/outline_widget>/i);
    const content = m ? m[1] : raw;  // dự phòng: phân tích trực tiếp nếu không có thẻ widget
    const beats = []; let cur = null;
    for (const line of content.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        if (/^Beat\s*:/i.test(t)) {
            if (cur) beats.push(cur);
            const parts = t.replace(/^Beat\s*:\s*/i, '').split('|');
            cur = {
                time   : (parts[0] || '').trim(),
                title  : (parts[1] || '').trim(),
                type   : (parts[2] || '').trim(),
                line   : (parts[3] || '').trim(),
                outcome: (parts[4] || '').trim(),
                scene  : '',
                subtext: '',
                think  : '',
            };
        } else if (/^Scene\s*:/i.test(t) && cur) {
            cur.scene = t.replace(/^Scene\s*:\s*/i, '').trim();
        } else if (/^Subtext\s*:/i.test(t) && cur) {
            cur.subtext = t.replace(/^Subtext\s*:\s*/i, '').trim();
        } else if (/^Think\s*:/i.test(t) && cur) {
            cur.think = t.replace(/^Think\s*:\s*/i, '').trim();
        }
    }
    if (cur) beats.push(cur);
    return beats;
}

function renderOutline(raw) {
    const beats = parseOutline(raw);
    if (beats.length === 0) return `<div class="sp-raw">${escapeHtml(raw).replace(/\n/g, '<br>')}</div>`;
    return beats.map((b, i) => {
        const injectParts = [`【Tham khảo nút thắt cốt truyện】`, `${b.time}·《${b.title}》${b.type ? '·' + b.type : ''}${b.line ? '（' + b.line + '）' : ''}`];
        if (b.scene)   injectParts.push(b.scene);
        if (b.outcome) injectParts.push(`Kết quả: ${b.outcome}`);
        const injectBtn = makeInjectBtn(injectParts.join('\n'));
        return `
        <div class="sp-beat">
            <div class="sp-beat-head">
                <span class="sp-beat-index">${i + 1}</span>
                <span class="sp-beat-time">${escapeHtml(b.time)}</span>
                ${b.type ? `<span class="sp-beat-type">${escapeHtml(b.type)}</span>` : ''}
                ${b.line ? `<span class="sp-beat-line">${escapeHtml(b.line)}</span>` : ''}
                ${injectBtn}
            </div>
            <div class="sp-beat-title">${escapeHtml(b.title)}</div>
            ${b.outcome ? `<div class="sp-beat-outcome">${escapeHtml(cleanText(b.outcome))}</div>` : ''}
            ${b.scene   ? `<div class="sp-beat-scene">${escapeHtml(cleanText(b.scene))}</div>` : ''}
            ${b.subtext ? `<div class="sp-beat-subtext">"${escapeHtml(cleanText(b.subtext))}"</div>` : ''}
            ${b.think   ? `<details class="sp-beat-think"><summary>Suy nghĩ sáng tác</summary><p>${escapeHtml(cleanText(b.think))}</p></details>` : ''}
        </div>`;
    }).join('');
}

function buildPrompt(userName, charName, perspective = 'user') {
    const subject   = perspective === 'char' ? charName : userName;
    const companion = perspective === 'char' ? userName : charName;
    return `Vui lòng tạm dừng đóng vai, với tư cách người quan sát dựa trên cốt truyện trên, hãy tạo lịch trình cho ${subject}.
【Quan trọng】Mọi nội dung phải sử dụng tiếng Việt (tên người, địa danh có thể giữ nguyên gốc).

Các sự kiện chia làm 3 loại:
- main (tuyến sáng): Các sự kiện ${subject} trực tiếp tham gia hoặc đang thúc đẩy.
- hidden (tuyến tối): Các phục bút ngầm, các diễn biến chưa có lời giải.
- bond (tuyến hồng): Các sự kiện có thể xảy ra hoặc làm sâu sắc thêm quan hệ giữa ${subject} và ai đó (không giới hạn ở ${companion}, có thể là bất kỳ nhân vật quan trọng nào).

Cả ${subject} và ${companion} đều có cuộc sống độc lập riêng, các sự kiện có thể liên quan đến bất kỳ NPC hoặc bên thứ ba nào, không nhất thiết mọi mục đều phải xoay quanh sự tương tác giữa hai người.

Ngày 1-3 mỗi ngày tạo từ 1 đến 3 sự kiện; khối Future (Tương lai) tạo từ 5 đến 10 sự kiện, không giới hạn khoảng thời gian.

【Giải thích các trường】
Định dạng: Event: type|title|description|time|location|diễn biến liên đới
- type chỉ có thể là main / hidden / bond
- description: Góc nhìn của ${subject}, giọng điệu đời thường, trên 30 chữ.
- diễn biến liên đới: Diễn biến đồng thời của các nhân vật khác liên quan đến sự kiện này, có thể là bất kỳ NPC hoặc bên thứ ba nào, trên 30 chữ; nếu không có nhân vật liên quan có thể để trống.

【Giải thích ngày tháng】
Ngày 1 nên bắt đầu từ mốc thời gian hiện tại của cốt truyện, suy diễn về sau. Nếu có thể suy đoán rõ ràng ngày hiện tại từ cốt truyện thì điền StartDate, nếu không thì bỏ qua. Không điền lại các ngày đã xảy ra, Ngày 1 phải là thời gian "hiện tại" hoặc sau đó trong cốt truyện.

【Định dạng đầu ra (tuân thủ nghiêm ngặt, chỉ xuất cấu trúc sau)】
<calendar_widget>
StartDate: YYYY-MM-DD (Điền nếu suy đoán được từ cốt truyện, nếu không hãy bỏ qua dòng này)
Day: 1
Event: type|title|description|time|location|diễn biến liên đới
Event: type|title|description|time|location|diễn biến liên đới
Day: 2
Event: type|title|description|time|location|diễn biến liên đới
Event: type|title|description|time|location|diễn biến liên đới
Day: 3
Event: type|title|description|time|location|diễn biến liên đới
Event: type|title|description|time|location|diễn biến liên đới
Future:
Event: type|title|description|time|location|diễn biến liên đới
</calendar_widget>

【Giải thích Future】
Khối Future ghi lại các vấn đề tương lai xuất hiện trong cốt truyện, thời gian không giới hạn.
Cho phép suy đoán hợp lý dựa trên diễn biến cốt truyện, nhưng không được bịa đặt các cuộc hẹn hoặc lời hứa chưa từng được nhắc đến trong câu chuyện.`;
}

// ─── Cài đặt (Settings) ─────────────────────────────────────────────────────────────────

async function fetchModels() {
    const url = $('#sp-cfg-url').val().trim().replace(/\/$/, '');
    const key = ($('#sp-cfg-key').data('real') || $('#sp-cfg-key').val()).trim();
    if (!url || !key) { showToast('Vui lòng điền URL và Key trước', null, true); return; }

    const $btn = $('#sp-fetch-models');
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i>');
    try {
        const res = await fetch(`${url}/models`, {
            headers: { 'Authorization': `Bearer ${key}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const models = (data.data || data.models || [])
            .map(m => (typeof m === 'string' ? m : m.id))
            .filter(Boolean).sort();
        if (!models.length) throw new Error('Giao diện không trả về bất kỳ mô hình nào');

        const current = loadCfg().model || '';
        const opts = models.map(m =>
            `<option value="${escapeAttr(m)}"${m === current ? ' selected' : ''}>${escapeHtml(m)}</option>`
        ).join('');
        $('#sp-cfg-model').replaceWith(
            `<select id="sp-cfg-model" class="sp-input sp-model-input">${opts}</select>`
        );
        if (!current) $('#sp-cfg-model').val(models[0]);
        showToast(`Đã tải ${models.length} mô hình`);
    } catch (err) {
        showToast(`Lấy danh sách mô hình thất bại: ${err.message}`, null, true);
    } finally {
        $btn.prop('disabled', false).html('<i class="fa-solid fa-list"></i>');
    }
}

function toggleSettings() {
    settingsOpen = !settingsOpen;
    $('#sp-settings-panel').slideToggle(200, () => {
        syncMobileViewport();
    });
    $(`#${MODAL_ID} .sp-settings-btn`).toggleClass('sp-btn-active', settingsOpen);
    syncMobileViewport();
}

function toggleKeyVisibility() {
    const $el = $('#sp-cfg-key'), $icon = $('#sp-key-toggle i');
    if ($el.attr('type') === 'password') {
        $el.attr('type', 'text').val($el.data('real') || $el.val());
        $icon.removeClass('fa-eye').addClass('fa-eye-slash');
    } else {
        const r = $el.val(); $el.data('real', r).attr('type', 'password').val(maskKey(r));
        $icon.removeClass('fa-eye-slash').addClass('fa-eye');
    }
}

function saveSettings() {
    const $k = $('#sp-cfg-key'), key = ($k.data('real') || $k.val()).trim();
    saveCfg({ url: $('#sp-cfg-url').val().trim().replace(/\/$/, ''), key, model: $('#sp-cfg-model').val().trim() });
    $k.data('real', key).val(maskKey(key)).attr('type', 'password');
    const $m = $('#sp-cfg-msg'); $m.text('Đã lưu ✓'); setTimeout(() => $m.text(''), 2000);
    const hasApi = !!(loadCfg().url && loadCfg().key);
    $('.sp-api-notice')
        .removeClass('sp-notice-ok sp-notice-warn')
        .addClass(hasApi ? 'sp-notice-ok' : 'sp-notice-warn')
        .html(`<i class="fa-solid ${hasApi ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i>
            ${hasApi ? 'Đã cấu hình API riêng, việc tạo ngầm không ảnh hưởng đến trò chuyện'
                     : 'Chưa cấu hình API riêng: Trong lúc tạo sẽ <b>chiếm dụng kênh chat</b>'}`);
    setTimeout(() => { if (settingsOpen) toggleSettings(); }, 400);
}

function applyTheme(theme) {
    currentTheme = theme;
    $(`#${MODAL_ID}`).removeClass('sp-night sp-day').addClass(`sp-${theme}`);
    $(`#${FAB_ID} .sp-fab-btn`).removeClass('sp-night sp-day').addClass(`sp-${theme}`);
}

function toggleFullscreen() {
    isFullscreen = !isFullscreen;
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    const $icon = $(`#${MODAL_ID} .sp-maximize-btn i`);
    if (isFullscreen) {
        sheet.dataset.prevLeft    = sheet.style.left;
        sheet.dataset.prevTop     = sheet.style.top;
        sheet.dataset.prevWidth   = sheet.style.width;
        sheet.dataset.prevHeight  = sheet.style.height;
        sheet.dataset.prevMaxH    = sheet.style.maxHeight;
        sheet.style.animation     = 'none';
        sheet.style.left          = '10px';
        sheet.style.top           = '10px';
        sheet.style.right         = 'auto';
        sheet.style.transform     = 'none';
        sheet.style.width         = (window.innerWidth  - 20) + 'px';
        sheet.style.height        = (window.innerHeight - 20) + 'px';
        sheet.style.maxHeight     = (window.innerHeight - 20) + 'px';
        $icon.removeClass('fa-expand').addClass('fa-compress');
    } else {
        sheet.style.left      = sheet.dataset.prevLeft     || '';
        sheet.style.top       = sheet.dataset.prevTop      || '';
        sheet.style.width     = sheet.dataset.prevWidth    || '';
        sheet.style.height    = sheet.dataset.prevHeight   || '';
        sheet.style.maxHeight = sheet.dataset.prevMaxH     || '';
        $icon.removeClass('fa-compress').addClass('fa-expand');
    }
}

function toggleTheme() {
    applyTheme(currentTheme === 'night' ? 'day' : 'night');
    localStorage.setItem(THEME_KEY, currentTheme);
}

// ─── Kéo thả (Drag) ─────────────────────────────────────────────────────────────────────

function onDragStart(e) {
    if ($(e.target).closest('.sp-icon-btn, .sp-view-btn').length) return;
    e.preventDefault();
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);

    // Chuyển từ căn giữa bằng CSS-transform sang tọa độ px cụ thể để tính toán kéo thả.
    if (sheet.style.transform !== 'none') {
        sheet.style.animation = 'none';           
        const snap = sheet.getBoundingClientRect(); 
        sheet.style.transform = 'none';
        sheet.style.right     = 'auto';
        sheet.style.left      = snap.left + 'px';
        sheet.style.top       = snap.top  + 'px';
    }

    const cx   = e.touches ? e.touches[0].clientX : e.clientX;
    const cy   = e.touches ? e.touches[0].clientY : e.clientY;
    const rect = sheet.getBoundingClientRect(); 
    dragState  = { startX: cx, startY: cy, origLeft: rect.left, origTop: rect.top };

    $(document).on('mousemove.spdrag', onDragMove).on('mouseup.spdrag', onDragEnd);
    document.addEventListener('touchmove', onDragMove, { passive: false });
    document.addEventListener('touchend',  onDragEnd);
    $('#sp-drag-handle').css('cursor', 'grabbing');
}

function onDragMove(e) {
    if (!dragState) return;
    e.preventDefault();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    const left = Math.max(0, Math.min(dragState.origLeft + cx - dragState.startX, window.innerWidth  - sheet.offsetWidth));
    const top  = Math.max(0, Math.min(dragState.origTop  + cy - dragState.startY, window.innerHeight - 60));
    sheet.style.left  = left + 'px';
    sheet.style.top   = top  + 'px';
    sheet.style.right = 'auto';
}

function onDragEnd() {
    if (!dragState) return;
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    const rect  = sheet.getBoundingClientRect();
    if (!isMobile()) {
        localStorage.setItem(POS_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
    }
    dragState = null;
    $(document).off('mousemove.spdrag mouseup.spdrag');
    document.removeEventListener('touchmove', onDragMove);
    document.removeEventListener('touchend',  onDragEnd);
    $('#sp-drag-handle').css('cursor', 'grab');
}

// ─── Thay đổi kích thước (Resize) ───────────────────────────────────────────────────────────────────

function onResizeStart(e) {
    e.preventDefault();
    e.stopPropagation();
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    sheet.style.willChange = 'width, height';
    document.body.style.userSelect = 'none';
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    resizeState = {
        startX: cx, startY: cy,
        origW : sheet.offsetWidth, origH : sheet.offsetHeight,
    };
    $(document).on('mousemove.spresize', onResizeMove).on('mouseup.spresize', onResizeEnd);
    document.addEventListener('touchmove', onResizeMove, { passive: false });
    document.addEventListener('touchend',  onResizeEnd);
}

function onResizeMove(e) {
    if (!resizeState) return;
    e.preventDefault();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    if (resizeRAF) return;
    resizeRAF = requestAnimationFrame(() => {
        resizeRAF = null;
        const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
        const w = Math.max(280, Math.min(window.innerWidth * 0.9, resizeState.origW + cx - resizeState.startX));
        const h = Math.max(300, Math.min(window.innerHeight * 0.95, resizeState.origH + cy - resizeState.startY));
        sheet.style.width     = w + 'px';
        sheet.style.height    = h + 'px';
        sheet.style.maxHeight = h + 'px';
    });
}

function onResizeEnd() {
    if (!resizeState) return;
    if (resizeRAF) { cancelAnimationFrame(resizeRAF); resizeRAF = null; }
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    sheet.style.willChange = '';
    document.body.style.userSelect = '';
    localStorage.setItem(SIZE_KEY, JSON.stringify({ width: sheet.offsetWidth, height: sheet.offsetHeight }));
    resizeState = null;
    $(document).off('mousemove.spresize mouseup.spresize');
    document.removeEventListener('touchmove', onResizeMove);
    document.removeEventListener('touchend',  onResizeEnd);
}

function restoreOutlineChatHeight() {
    const h = parseInt(localStorage.getItem('sp-outline-chat-h')) || 210;
    const el = document.getElementById('sp-outline-chat');
    if (el) el.style.height = h + 'px';
}

function restorePositionAndSize() {
    setTimeout(() => {
        const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
        if (!sheet) return;
        const pos  = JSON.parse(localStorage.getItem(POS_KEY)  || 'null');
        const size = JSON.parse(localStorage.getItem(SIZE_KEY) || 'null');
        if (pos) {
            sheet.style.left  = Math.min(pos.left, window.innerWidth  - sheet.offsetWidth)  + 'px';
            sheet.style.top   = Math.min(pos.top,  window.innerHeight - 60) + 'px';
            sheet.style.right = 'auto';
        }
        if (size) {
            sheet.style.width     = size.width  + 'px';
            sheet.style.height    = size.height + 'px';
            sheet.style.maxHeight = size.height + 'px';
        }
    }, 0);
}

function positionPanel() {
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    if (!sheet) return;
    if (isMobile()) {
        sheet.style.left      = '';
        sheet.style.top       = '';
        sheet.style.right     = '';
        sheet.style.transform = '';
        syncMobileViewport();
        bindViewportSync();
        return;
    }
    const pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    if (pos) {
        sheet.style.left  = Math.min(pos.left, window.innerWidth  - sheet.offsetWidth)  + 'px';
        sheet.style.top   = Math.min(pos.top,  window.innerHeight - 60) + 'px';
        sheet.style.right = 'auto';
    }
}

function bindViewportSync() {
    if (viewportSyncBound) return;
    viewportSyncBound = true;
    const onViewportChange = () => syncMobileViewport();
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('orientationchange', onViewportChange);
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', onViewportChange);
        window.visualViewport.addEventListener('scroll', onViewportChange);
    }
}

function syncMobileViewport() {
    if (!isMobile()) return;
    const root = document.getElementById(MODAL_ID);
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    if (!root || !sheet || root.style.display === 'none') return;

    const vv = window.visualViewport;
    const vh = Math.max(320, Math.round((vv?.height || window.innerHeight)));
    const top = 70;
    const bottomGap = 20;
    const maxH = Math.max(260, vh - top - bottomGap);

    sheet.style.top = `${top}px`;
    sheet.style.maxHeight = `${maxH}px`;
}

// ─── Thông báo (Toast - ở phía trên) ──────────────────────────────────────────────

function injectToastContainer() {
    if (!$('#sp-toast-wrap').length) document.documentElement.insertAdjacentHTML('beforeend', '<div id="sp-toast-wrap"></div>');
}

function showToast(msg, onClick, isError = false) {
    const $t = $(`<div class="sp-toast${isError ? ' sp-toast-error' : ''}">
        <i class="fa-solid ${isError ? 'fa-circle-exclamation' : 'fa-calendar-check'}"></i>
        <span>${escapeHtml(msg)}</span>
    </div>`);
    $('#sp-toast-wrap').append($t);
    requestAnimationFrame(() => $t.addClass('sp-toast-show'));
    if (onClick) $t.css('cursor', 'pointer').on('click', () => { onClick(); $t.remove(); });
    setTimeout(() => { $t.removeClass('sp-toast-show'); setTimeout(() => $t.remove(), 350); }, 4000);
}

// ─── Kết xuất nội dung (Rendering) ────────────────────────────────────────────────────────────────

const TYPE_META = {
    main  : { icon: 'fa-bolt',      label: 'Tuyến sáng', cls: 'sp-type-world'     },
    hidden: { icon: 'fa-eye-slash', label: 'Tuyến tối', cls: 'sp-type-major'     },
    bond  : { icon: 'fa-heart',     label: 'Tuyến hồng', cls: 'sp-type-character' },
};

function renderSchedule(raw, userName, perspective = 'user') {
    const { days, future, startDate } = parseCalendar(raw);
    const hasFuture = future && future.events.length > 0;
    if (days.length === 0 && !hasFuture) return `<div class="sp-raw">${escapeHtml(raw).replace(/\n/g, '<br>')}</div>`;

    const WEEKDAYS = ['Chủ Nhật','Thứ Hai','Thứ Ba','Thứ Tư','Thứ Năm','Thứ Sáu','Thứ Bảy'];
    const totalTabs = days.length + (hasFuture ? 1 : 0);
    const chipCls   = perspective === 'char' ? 'sp-char-chip' : 'sp-user-chip';

    const header = `<div class="sp-schedule-header">
        <span class="${chipCls}">${escapeHtml(userName)}</span>
        <span class="sp-schedule-label"> của lịch trình</span>
    </div>`;

    const tabs = days.map((_, i) => {
        let numLabel = String(i + 1);
        let wdLabel = '';
        if (startDate) {
            const d = new Date(startDate);
            d.setDate(d.getDate() + i);
            wdLabel  = WEEKDAYS[d.getDay()];
            numLabel = `${d.getMonth() + 1}/${d.getDate()}`;
        }
        return `<button class="sp-tab${i === 0 ? ' sp-tab-active' : ''}" data-day="${i}">
            <span class="sp-tab-num">${numLabel}</span>
            ${wdLabel ? `<span class="sp-tab-wd">${wdLabel}</span>` : ''}
        </button>`;
    });
    if (hasFuture) tabs.push(`<button class="sp-tab" data-day="${days.length}">
        <span class="sp-tab-num">Tương lai</span>
    </button>`);

    const panels = days.map(day =>
        `<div class="sp-day-panel" style="width:calc(100%/${totalTabs})">${day.events.map(renderEvent).join('')}</div>`
    );
    if (hasFuture) panels.push(
        `<div class="sp-day-panel sp-future-panel" style="width:calc(100%/${totalTabs})">${future.events.map(renderEvent).join('')}</div>`
    );

    const debug = days.length < 3 ? `
        <details class="sp-debug"><summary>⚠ Chỉ phân tích được ${days.length} ngày</summary>
        <pre class="sp-debug-raw">${escapeHtml(raw)}</pre></details>` : '';

    return `${header}<div class="sp-tab-bar" data-total="${totalTabs}">${tabs.join('')}</div>
        <div class="sp-days-wrap"><div class="sp-days-track" data-total="${totalTabs}" style="width:${totalTabs * 100}%">${panels.join('')}</div></div>${debug}`;
}

function parseCalendar(raw) {
    const m = raw.match(/<calendar_widget[^>]*>([\s\S]*?)<\/calendar_widget>/i);
    const content = m ? m[1] : raw;

    const dateMatch = content.match(/^StartDate:\s*(\d{4}-\d{2}-\d{2})/m);
    let startDate = null;
    if (dateMatch) {
        const d = new Date(dateMatch[1]);
        if (!isNaN(d)) startDate = d;
    }

    const days = []; let cur = null; let inFuture = false; let future = null;
    for (const line of content.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('<!--')) continue;
        if (/^Day\s*:?\s*\d+/i.test(t) || /^第[一二三四五六七\d]+天/.test(t)) {
            if (cur && !inFuture) days.push(cur);
            cur = { events: [] }; inFuture = false; continue;
        }
        if (/^Future\s*:/i.test(t) || /^未来\s*:/i.test(t)) {
            if (cur && !inFuture) days.push(cur);
            future = { events: [] }; cur = future; inFuture = true; continue;
        }
        if (/^Event\s*:/i.test(t)) {
            if (!cur) cur = { events: [] };
            const parts = t.replace(/^Event\s*:\s*/i, '').split('|');
            if (parts.length >= 4) cur.events.push({
                type: (parts[0]||'user').trim().toLowerCase(), title: (parts[1]||'').trim(),
                desc: (parts[2]||'').trim(), time: (parts[3]||'').trim(),
                location: (parts[4]||'').trim(), npcAction: (parts[5]||'').trim(),
            });
        }
    }
    if (cur && !inFuture) days.push(cur);
    return { days: days.filter(d => d.events.length > 0), future, startDate };
}

function renderEvent(ev) {
    const meta = TYPE_META[ev.type] || TYPE_META.main;
    const injectParts = ['【日程参考】'];
    if (ev.time) injectParts.push(`时间：${ev.time}`);
    injectParts.push(ev.title);
    if (ev.desc)      injectParts.push(ev.desc);
    if (ev.location)  injectParts.push(`地点：${ev.location}`);
    if (ev.npcAction) injectParts.push(`线头：${ev.npcAction}`);
    const injectBtn = makeInjectBtn(injectParts.join('\n'));
    return `<div class="sp-event ${meta.cls}">
        <div class="sp-event-head">
            <span class="sp-type-badge"><i class="fa-solid ${meta.icon}"></i>${escapeHtml(meta.label)}</span>
            <span class="sp-event-title">${escapeHtml(ev.title)}</span>
            ${ev.time ? `<span class="sp-event-time"><i class="fa-regular fa-clock"></i> ${escapeHtml(ev.time)}</span>` : ''}
            ${injectBtn}
        </div>
        ${ev.desc ? `<p class="sp-event-desc">${escapeHtml(ev.desc)}</p>` : ''}
        <div class="sp-event-meta">
            ${ev.location  ? `<span class="sp-event-loc"><i class="fa-solid fa-location-dot"></i>${escapeHtml(ev.location)}</span>` : ''}
            ${ev.npcAction ? `<span class="sp-event-npc"><i class="fa-solid fa-link"></i>${escapeHtml(ev.npcAction)}</span>` : ''}
        </div>
    </div>`;
}

function escapeHtml(s)  { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escapeAttr(s)  { return String(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function cleanText(s) {
    return String(s)
        .replace(/<ruby[^>]*>[\s\S]*?<\/ruby>/gi, (m) =>
            m.replace(/<rt[^>]*>[\s\S]*?<\/rt>/gi, '').replace(/<\/?ruby[^>]*>/gi, ''))
        .replace(/<rt[^>]*>[\s\S]*?<\/rt>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/_{1,2}(.+?)_{1,2}/g, '$1')
        .replace(/~~(.+?)~~/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .trim();
