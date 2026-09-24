// ==UserScript==
// @name         start.me-better
// @namespace    https://github.com/Ovolsan/start.me-better
// @version      20260924
// @author       Ovolsan
// @description  Перемещает поиск закладок Start.me между виджетами
// @match        https://start.me/p/*
// @grant        GM_addStyle
// @run-at       document-idle
// @updateURL
// ==/UserScript==

(function () {
    'use strict';

    const SEARCH_SELECTOR = '.header-bookmark-search.header-right__search.lm20px';
    const POPUP_SELECTOR = '.search-popup.header-bookmark-search__popup';
    const WIDGET_SELECTOR = '.page-section__widget';
    const POPUP_WIDTH = 600;
    const VIEWPORT_GAP = 8;
    const STORAGE_KEY = 'moved-bookmark-search-position:' + location.pathname;

    function loadPlacement() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
            if (saved && ['before', 'after'].includes(saved.side) &&
                (saved.id || saved.dataId || saved.title || Number.isInteger(saved.index))) {
                return saved;
            }
        } catch (error) {
            // Поиск продолжит работать, даже если хранилище недоступно.
        }
        return { title: 'Hackerman', side: 'after' };
    }

    let placement = loadPlacement();
    let searchBox = null;
    let wrapper = null;
    let popup = null;
    let anchorWidget = null;
    let raisedColumn = null;
    let dragState = null;
    let siteDragActive = false;
    let fieldObserver = null;
    let syncQueued = false;
    let positionQueued = false;
    let widthQueued = false;

    GM_addStyle(`
        .moved-bookmark-search {
            display: flex;
            align-items: stretch;
            width: 100%;
            min-width: 0;
            max-width: 700px;
            margin: 20px auto;
            position: relative;
            z-index: 999999;
        }

        .moved-bookmark-search-column {
            position: relative !important;
            z-index: 1000000 !important;
            overflow: visible !important;
        }

        .moved-bookmark-search__handle {
            flex: 0 0 24px;
            align-self: stretch;
            width: 24px;
            min-height: 38px;
            padding: 0;
            border: 0;
            border-right: 1px solid #ffffff26;
            background: transparent;
            color: inherit;
            opacity: 0.55;
            font: 16px/1 sans-serif;
            cursor: grab;
            touch-action: none;
            user-select: none;
        }

        .moved-bookmark-search__handle:hover,
        .moved-bookmark-search__handle:focus-visible {
            opacity: 1;
        }

        .moved-bookmark-search__handle:active {
            cursor: grabbing;
        }

        .moved-bookmark-search.is-dragging {
            opacity: 0.55;
        }

        .moved-bookmark-search.is-dragging > .search-popup {
            pointer-events: none !important;
        }

        .moved-bookmark-search__drag-label,
        .moved-bookmark-search__drop-line {
            position: fixed;
            pointer-events: none;
            z-index: 2147483647;
        }

        .moved-bookmark-search__drag-label {
            padding: 6px 10px;
            border: 1px solid #5d87ad;
            background: #202a27;
            color: white;
            box-shadow: 0 4px 12px #0008;
        }

        .moved-bookmark-search__drop-line {
            height: 3px;
            background: #57a9ff;
            box-shadow: 0 0 6px #57a9ff;
            display: none;
        }

        .moved-bookmark-search .header-bookmark-search,
        .moved-bookmark-search .header-bookmark-search__box {
            box-sizing: border-box !important;
            min-width: 0 !important;
            max-width: 100% !important;
            position: relative !important;
            left: auto !important;
            right: auto !important;
            margin-left: 0 !important;
            transform: none !important;
        }

        .moved-bookmark-search .header-bookmark-search {
            flex: 1 1 0 !important;
            width: calc(100% - 24px) !important;
            margin: 0 !important;
            border-top-left-radius: 0 !important;
            border-bottom-left-radius: 0 !important;
        }

        .moved-bookmark-search .header-bookmark-search__box {
            width: 100% !important;
        }

        .moved-bookmark-search .header-bookmark-search * {
            box-sizing: border-box !important;
            max-width: 100% !important;
        }

        .moved-bookmark-search .header-bookmark-search input {
            min-width: 0 !important;
            max-width: 100% !important;
            box-sizing: border-box !important;
            left: 0 !important;
            margin-left: 0 !important;
            transform: none !important;
            translate: none !important;
        }

        .moved-bookmark-search > .search-popup.header-bookmark-search__popup {
            position: fixed !important;
            z-index: 2147483647 !important;
            left: var(--moved-search-popup-left) !important;
            top: var(--moved-search-popup-top) !important;
            width: min(600px, calc(100vw - 16px)) !important;
            min-width: 0 !important;
            max-width: calc(100vw - 16px) !important;
            max-height: none !important;
            margin: 0 !important;
            transform: none !important;
            overflow: visible !important;
        }

        html:has(.moved-bookmark-search:focus-within),
        body:has(.moved-bookmark-search:focus-within) {
            overflow-y: auto !important;
        }
    `);

    function queuePosition() {
        if (positionQueued || !searchBox?.isConnected || !popup?.isConnected) return;
        positionQueued = true;
        requestAnimationFrame(() => {
            positionQueued = false;
            if (!searchBox?.isConnected || !popup?.isConnected) return;

            const bounds = searchBox.getBoundingClientRect();
            const width = Math.min(POPUP_WIDTH, window.innerWidth - VIEWPORT_GAP * 2);
            const centeredLeft = bounds.left + (bounds.width - width) / 2;
            const left = Math.max(
                VIEWPORT_GAP,
                Math.min(centeredLeft, window.innerWidth - width - VIEWPORT_GAP)
            );

            popup.style.setProperty('--moved-search-popup-left', left + 'px');
            popup.style.setProperty('--moved-search-popup-top',
                bounds.bottom + VIEWPORT_GAP + 'px');
        });
    }

    function setImportant(element, property, value) {
        if (element.style.getPropertyValue(property) !== value ||
            element.style.getPropertyPriority(property) !== 'important') {
            element.style.setProperty(property, value, 'important');
        }
    }

    function queueWidthFix() {
        if (widthQueued || !wrapper?.isConnected || !searchBox?.isConnected) return;
        widthQueued = true;
        requestAnimationFrame(() => {
            widthQueued = false;
            if (!wrapper?.isConnected || !searchBox?.isConnected) return;

            const handle = wrapper.querySelector('.moved-bookmark-search__handle');
            const wrapperRect = wrapper.getBoundingClientRect();
            const handleWidth = handle?.getBoundingClientRect().width || 0;
            const fieldWidth = Math.max(0, wrapperRect.width - handleWidth);
            const fieldLeft = wrapperRect.left + handleWidth;
            setImportant(searchBox, 'width', fieldWidth + 'px');
            setImportant(searchBox, 'min-width', '0px');
            setImportant(searchBox, 'max-width', fieldWidth + 'px');

            for (const element of searchBox.querySelectorAll('*')) {
                if (element.closest(POPUP_SELECTOR)) continue;
                const rect = element.getBoundingClientRect();
                if (rect.height > 90 || rect.width < 80) continue;

                if (rect.width > fieldWidth + 1) {
                    setImportant(element, 'width', '100%');
                    setImportant(element, 'min-width', '0px');
                    setImportant(element, 'max-width', '100%');
                }
                if (rect.left < fieldLeft - 1 ||
                    rect.right > wrapperRect.right + 1) {
                    setImportant(element, 'left', '0px');
                    setImportant(element, 'right', 'auto');
                    setImportant(element, 'margin-left', '0px');
                    setImportant(element, 'transform', 'none');
                    setImportant(element, 'translate', 'none');
                    setImportant(element, 'scale', 'none');
                }
            }
            queuePosition();
        });
    }

    function widgetTitle(widget) {
        return widget.querySelector('.widget-header__text')?.textContent.trim() || '';
    }

    function findAnchorWidget() {
        const widgets = [...document.querySelectorAll(WIDGET_SELECTOR)];
        let widget = null;

        if (placement.dataId) {
            widget = widgets.find(item => item.getAttribute('data-widget-id') === placement.dataId ||
                item.getAttribute('data-id') === placement.dataId);
        }
        if (!widget && placement.id) {
            widget = widgets.find(item => item.id === placement.id);
        }
        if (!widget && placement.title) {
            const matches = widgets.filter(item => widgetTitle(item) === placement.title);
            widget = matches[placement.occurrence || 0] || matches[0];
        }
        if (!widget && Number.isInteger(placement.index)) {
            widget = widgets[placement.index];
        }
        return widget || widgets.find(item => widgetTitle(item) === 'Hackerman');
    }

    function describeWidget(widget, side) {
        const widgets = [...document.querySelectorAll(WIDGET_SELECTOR)];
        const title = widgetTitle(widget);
        return {
            id: widget.id || '',
            dataId: widget.getAttribute('data-widget-id') ||
                widget.getAttribute('data-id') || '',
            title,
            occurrence: widgets.filter(item => widgetTitle(item) === title).indexOf(widget),
            index: widgets.indexOf(widget),
            side
        };
    }

    function savePlacement() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(placement));
        } catch (error) {
            // Положение сохранится до перезагрузки страницы.
        }
    }

    function raiseSearchColumn(widget) {
        let column = widget.parentElement;
        while (column?.parentElement && column !== document.body) {
            const hasSiblingColumn = [...column.parentElement.children].some(sibling =>
                sibling !== column && sibling.querySelector(WIDGET_SELECTOR)
            );
            if (hasSiblingColumn) break;
            column = column.parentElement;
        }

        if (column && column !== document.body && column !== raisedColumn) {
            raisedColumn?.classList.remove('moved-bookmark-search-column');
            column.classList.add('moved-bookmark-search-column');
            raisedColumn = column;
        }
    }

    function isPlaced() {
        if (!wrapper || !anchorWidget ||
            wrapper.parentElement !== anchorWidget.parentElement) return false;
        return placement.side === 'before'
            ? wrapper.nextElementSibling === anchorWidget
            : anchorWidget.nextElementSibling === wrapper;
    }

    function createWrapper() {
        wrapper = document.createElement('div');
        wrapper.className = 'moved-bookmark-search';

        const handle = document.createElement('button');
        handle.type = 'button';
        handle.className = 'moved-bookmark-search__handle';
        handle.textContent = '⋮⋮';
        handle.title = 'Перетащить поиск';
        handle.setAttribute('aria-label', 'Перетащить поиск');
        handle.addEventListener('pointerdown', startDrag);
        handle.addEventListener('pointermove', moveDrag);
        handle.addEventListener('pointerup', finishDrag);
        handle.addEventListener('pointercancel', cancelDrag);
        handle.addEventListener('lostpointercapture', cancelDrag);
        handle.addEventListener('dragstart', event => event.preventDefault());
        wrapper.addEventListener('wheel', forwardWheel, { capture: true, passive: false });
        wrapper.appendChild(handle);
    }

    function forwardWheel(event) {
        if (event.ctrlKey || event.metaKey) return;

        let scrollTarget = wrapper.parentElement;
        while (scrollTarget) {
            const style = getComputedStyle(scrollTarget);
            if (/(auto|scroll)/.test(style.overflowY) &&
                scrollTarget.scrollHeight > scrollTarget.clientHeight) break;
            scrollTarget = scrollTarget === document.body
                ? null : scrollTarget.parentElement;
        }
        if (!scrollTarget) scrollTarget = document.scrollingElement;
        if (!scrollTarget || scrollTarget.scrollHeight <= scrollTarget.clientHeight) return;

        const scale = event.deltaMode === 1 ? 16
            : event.deltaMode === 2 ? window.innerHeight : 1;
        event.preventDefault();
        event.stopPropagation();
        scrollTarget.scrollBy(event.deltaX * scale, event.deltaY * scale);
    }

    function updateDrag(event) {
        const state = dragState;
        state.label.style.left = Math.min(event.clientX + 12, window.innerWidth - 80) + 'px';
        state.label.style.top = Math.min(event.clientY + 12, window.innerHeight - 36) + 'px';

        const element = document.elementFromPoint(event.clientX, event.clientY);
        const target = element?.closest(WIDGET_SELECTOR);
        if (!target) {
            state.target = null;
            state.line.style.display = 'none';
            return;
        }

        const rect = target.getBoundingClientRect();
        state.target = target;
        state.side = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
        state.line.style.left = rect.left + 'px';
        state.line.style.top = (state.side === 'before' ? rect.top : rect.bottom) + 'px';
        state.line.style.width = rect.width + 'px';
        state.line.style.display = 'block';
    }

    function startDrag(event) {
        if (event.button !== 0 || event.isPrimary === false) return;
        event.preventDefault();
        event.stopPropagation();

        const label = document.createElement('div');
        label.className = 'moved-bookmark-search__drag-label';
        label.textContent = 'Поиск';
        const line = document.createElement('div');
        line.className = 'moved-bookmark-search__drop-line';
        document.body.append(label, line);

        dragState = {
            pointerId: event.pointerId,
            handle: event.currentTarget,
            label,
            line,
            target: null,
            side: 'after'
        };
        wrapper.classList.add('is-dragging');
        event.currentTarget.setPointerCapture(event.pointerId);
        updateDrag(event);
    }

    function moveDrag(event) {
        if (!dragState || event.pointerId !== dragState.pointerId) return;
        event.preventDefault();
        updateDrag(event);
    }

    function endDrag() {
        if (!dragState) return;
        const state = dragState;
        dragState = null;
        if (state.handle.hasPointerCapture(state.pointerId)) {
            state.handle.releasePointerCapture(state.pointerId);
        }
        state.label.remove();
        state.line.remove();
        wrapper.classList.remove('is-dragging');
    }

    function finishDrag(event) {
        if (!dragState || event.pointerId !== dragState.pointerId) return;
        updateDrag(event);
        const target = dragState.target;
        const side = dragState.side;
        endDrag();

        if (target?.isConnected) {
            placement = describeWidget(target, side);
            savePlacement();
            anchorWidget = target;
            target.insertAdjacentElement(side === 'before' ? 'beforebegin' : 'afterend', wrapper);
            raiseSearchColumn(target);
            queuePosition();
        }
        queueSync();
    }

    function cancelDrag(event) {
        if (!dragState || event.pointerId !== dragState.pointerId) return;
        endDrag();
    }

    function syncSearch() {
        syncQueued = false;
        const nextSearch = document.querySelector(SEARCH_SELECTOR) || searchBox;
        const widget = findAnchorWidget();
        if (!nextSearch || !widget) return;

        if (!wrapper) createWrapper();
        if (searchBox !== nextSearch) {
            fieldObserver?.disconnect();
            if (searchBox?.parentElement === wrapper) searchBox.remove();
            searchBox = nextSearch;
            fieldObserver = new MutationObserver(queueWidthFix);
            fieldObserver.observe(searchBox, {
                attributes: true,
                subtree: true,
                attributeFilter: ['class', 'style']
            });
        }
        if (searchBox.parentElement !== wrapper) wrapper.appendChild(searchBox);
        queueWidthFix();

        anchorWidget = widget;
        if (!dragState && !siteDragActive && !isPlaced()) {
            widget.insertAdjacentElement(
                placement.side === 'before' ? 'beforebegin' : 'afterend', wrapper
            );
            raiseSearchColumn(widget);
        }

        const popups = document.querySelectorAll(POPUP_SELECTOR);
        const nextPopup = [...popups].find(candidate => candidate.parentElement !== wrapper)
            || popups[0];
        if (nextPopup && (nextPopup !== popup || nextPopup.parentElement !== wrapper)) {
            popup = nextPopup;
            wrapper.appendChild(popup);
            queuePosition();
        }
    }

    function queueSync() {
        if (syncQueued) return;
        syncQueued = true;
        requestAnimationFrame(syncSearch);
    }

    const observer = new MutationObserver(records => {
        if (!dragState && !siteDragActive && (!searchBox?.isConnected || !wrapper?.isConnected ||
            !anchorWidget?.isConnected || !isPlaced())) {
            queueSync();
            return;
        }

        if (popup && !popup.isConnected) {
            popup = null;
            queueSync();
            return;
        }

        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                if (node.matches(POPUP_SELECTOR) || node.querySelector(POPUP_SELECTOR) ||
                    node.matches(SEARCH_SELECTOR) || node.querySelector(SEARCH_SELECTOR) ||
                    node.matches(WIDGET_SELECTOR) || node.querySelector(WIDGET_SELECTOR)) {
                    queueSync();
                    return;
                }
            }
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    document.addEventListener('pointerdown', event => {
        if (event.target.closest?.(WIDGET_SELECTOR)) siteDragActive = true;
    }, true);
    function finishSiteDrag() {
        if (!siteDragActive) return;
        siteDragActive = false;
        queueSync();
    }
    document.addEventListener('pointerup', finishSiteDrag, true);
    document.addEventListener('pointercancel', finishSiteDrag, true);

    document.addEventListener('focusin', event => {
        if (searchBox?.contains(event.target)) {
            queueWidthFix();
            queuePosition();
        }
    });
    window.addEventListener('resize', () => {
        queueWidthFix();
        queuePosition();
    });
    window.addEventListener('scroll', queuePosition, true);

    queueSync();
})();