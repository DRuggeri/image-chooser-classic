import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { send_message, send_cancel } from "./image_chooser_messaging.js";

const state = {
    overlay: null,
    session: null,
    stylesInjected: false,
    keyHandler: null,
};

function injectStyles() {
    if (state.stylesInjected) return;
    const style = document.createElement("style");
    style.id = "cg-image-chooser-style";
    style.textContent = `
    .cg-chooser-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.78);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000;
    }
    .cg-chooser-panel {
        background: #1e1f23;
        color: #f5f5f5;
        padding: 20px;
        border-radius: 10px;
        max-width: 90vw;
        max-height: 90vh;
        display: flex;
        flex-direction: column;
        gap: 16px;
        box-shadow: 0 15px 40px rgba(0, 0, 0, 0.6);
    }
    .cg-chooser-header {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }
    .cg-chooser-header h2 {
        margin: 0;
        font-size: 20px;
        font-weight: 600;
    }
    .cg-chooser-header span {
        font-size: 13px;
        color: #aaa;
    }
    .cg-chooser-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px;
        overflow: auto;
        padding: 4px;
    }
    .cg-chooser-tile {
        position: relative;
        border-radius: 8px;
        border: 2px solid transparent;
        background: #141414;
        overflow: hidden;
        cursor: pointer;
        min-height: 140px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    .cg-chooser-tile img {
        width: 100%;
        height: 100%;
        object-fit: contain;
        display: block;
    }
    .cg-chooser-tile:hover {
        border-color: rgba(255, 255, 255, 0.25);
    }
    .cg-chooser-tile.selected {
        border-color: #4caf50;
        box-shadow: 0 0 0 3px rgba(76, 175, 80, 0.35);
    }
    .cg-chooser-tile.negative {
        border-color: #e53935;
        box-shadow: 0 0 0 3px rgba(229, 57, 53, 0.45);
    }
    .cg-chooser-index {
        position: absolute;
        top: 6px;
        left: 6px;
        background: rgba(0, 0, 0, 0.65);
        color: #fff;
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 12px;
        pointer-events: none;
    }
    .cg-chooser-badge {
        position: absolute;
        bottom: 6px;
        right: 6px;
        background: rgba(0, 0, 0, 0.7);
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 12px;
        color: #fff;
        pointer-events: none;
    }
    .cg-chooser-instructions {
        font-size: 13px;
        color: #bbb;
        display: flex;
        justify-content: space-between;
        gap: 16px;
        flex-wrap: wrap;
    }
    .cg-chooser-actions {
        display: flex;
        justify-content: flex-end;
        gap: 12px;
    }
    .cg-chooser-actions button {
        background: #2f3138;
        color: #f2f2f2;
        border: none;
        border-radius: 6px;
        padding: 10px 16px;
        font-size: 14px;
        cursor: pointer;
        transition: background 0.15s ease;
    }
    .cg-chooser-actions button:disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }
    .cg-btn-cancel:hover {
        background: #b33a3a;
    }
    .cg-btn-rerun {
        background: #2f3138;
        color: #f2f2f2;
    }
    .cg-btn-rerun:hover {
        background: #8a6a00;
    }
    .cg-btn-progress {
        background: #4caf50;
        color: #0f0f0f;
        font-weight: 600;
    }
    .cg-btn-progress:hover:not(:disabled) {
        background: #5dc561;
    }
    `;
    document.head.appendChild(style);
    state.stylesInjected = true;
}

function makeImageUrl(entry) {
    const params = new URLSearchParams();
    params.set("filename", entry.filename);
    params.set("type", entry.type);
    if (entry.subfolder) {
        params.set("subfolder", entry.subfolder);
    }
    return api.apiURL(`/view?${params.toString()}`);
}

function findChooserNode(detail) {
    if (!app.graph) return null;
    const graph = app.graph;
    const candidates = [];
    if (detail.id !== undefined && detail.id !== null) candidates.push(detail.id);
    if (detail.unique_id) {
        candidates.push(detail.unique_id);
        const parts = detail.unique_id.split(":");
        if (parts.length > 1) candidates.push(parts[0], parts.at(-1));
    }
    for (const candidate of candidates) {
        if (candidate === undefined || candidate === null) continue;
        const key = candidate.toString();
        const byId = graph._nodes_by_id?.[key];
        if (byId?.isImageChooser) return byId;
    }
    const nodes = graph._nodes ?? [];
    return nodes.find((n) => n?.isImageChooser && (n._ic_unique_id === detail.unique_id));
}

function openChooser(event) {
    const detail = event?.detail ?? {};
    closeChooser("replace");
    injectStyles();

    const session = {
        uniqueId: detail.unique_id ?? detail.display_id ?? "",
        displayId: detail.display_id ?? "",
        chooserType: detail.chooser_type ?? "single",
        mode: detail.mode ?? "Always pause",
        count: detail.count ?? 1,
        urls: detail.urls ?? [],
        selection: new Set(),
        negative: new Set(),
        progressFirstPick: !!detail.progress_first_pick,
        overlay: null,
        grid: null,
        progressButton: null,
        cancelButton: null,
        rerunButton: null,
        sending: false,
    };

    state.session = session;

    const overlay = document.createElement("div");
    overlay.className = "cg-chooser-overlay";
    overlay.addEventListener("click", (evt) => {
        if (evt.target === overlay) {
            evt.stopPropagation();
            evt.preventDefault();
        }
    });

    const panel = document.createElement("div");
    panel.className = "cg-chooser-panel";

    const header = document.createElement("div");
    header.className = "cg-chooser-header";
    const title = document.createElement("h2");
    title.textContent = "Image Chooser";
    const subtitle = document.createElement("span");
    subtitle.textContent = `Mode: ${session.mode} • Images: ${session.urls.length}`;
    header.appendChild(title);
    header.appendChild(subtitle);

    const instructions = document.createElement("div");
    instructions.className = "cg-chooser-instructions";
    instructions.innerHTML = session.chooserType === "double"
        ? "<span>Left click: positive (green)</span><span>Right click: negative (red)</span><span>Press 0 to progress, Escape to cancel</span>"
        : "<span>Click images to toggle selection</span><span>Press numbers 1-9 to select</span><span>Press 0 to progress, Escape to cancel</span>";

    const grid = document.createElement("div");
    grid.className = "cg-chooser-grid";
    session.grid = grid;

    session.urls.forEach((u, idx) => {
        const tile = document.createElement("div");
        tile.className = "cg-chooser-tile";
        tile.dataset.index = String(idx);

        const indexBadge = document.createElement("div");
        indexBadge.className = "cg-chooser-index";
        indexBadge.textContent = String(idx + 1);
        tile.appendChild(indexBadge);

        const img = document.createElement("img");
        img.src = makeImageUrl(u);
        img.alt = `Preview ${idx + 1}`;
        tile.appendChild(img);

        if (session.chooserType === "double") {
            tile.addEventListener("contextmenu", (evt) => {
                evt.preventDefault();
                toggleNegative(session, idx, tile);
            });
        }

        tile.addEventListener("click", (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
            togglePositive(session, idx, tile);
        });

        grid.appendChild(tile);
    });

    const actions = document.createElement("div");
    actions.className = "cg-chooser-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "cg-btn-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => {
        send_cancel();
        closeChooser("cancel");
    });

    const rerunBtn = document.createElement("button");
    rerunBtn.className = "cg-btn-rerun";
    rerunBtn.textContent = "Rerun";
    rerunBtn.addEventListener("click", () => {
        send_cancel();
        closeChooser("rerun");
        app.queuePrompt(0, 1);
    });

    const progressBtn = document.createElement("button");
    progressBtn.className = "cg-btn-progress";
    progressBtn.textContent = "Progress";
    progressBtn.disabled = true;
    progressBtn.addEventListener("click", () => sendSelection(session));

    session.progressButton = progressBtn;
    session.cancelButton = cancelBtn;
    session.rerunButton = rerunBtn;

    actions.appendChild(cancelBtn);
    actions.appendChild(rerunBtn);
    actions.appendChild(progressBtn);

    panel.appendChild(header);
    panel.appendChild(instructions);
    panel.appendChild(grid);
    panel.appendChild(actions);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    state.overlay = overlay;
    session.overlay = overlay;

    attachKeyHandler();
}

function togglePositive(session, index, tile) {
    if (session.negative.has(index)) {
        session.negative.delete(index);
    }

    if (session.selection.has(index)) {
        session.selection.delete(index);
    } else {
        session.selection.add(index);
    }
    updateTileState(session, tile, index);
    updateButtons(session);

    if (session.progressFirstPick && session.selection.size > 0 && session.chooserType === "single") {
        sendSelection(session);
    }
}

function toggleNegative(session, index, tile) {
    if (session.negative.has(index)) {
        session.negative.delete(index);
    } else {
        session.selection.delete(index);
        session.negative.add(index);
    }
    updateTileState(session, tile, index);
    updateButtons(session);
}

function updateTileState(session, tile, index) {
    tile.classList.toggle("selected", session.selection.has(index));
    tile.classList.toggle("negative", session.negative.has(index));
}

function updateButtons(session) {
    if (!session.progressButton) return;
    let canSend = session.selection.size > 0;
    if (session.chooserType === "double") {
        canSend = session.selection.size > 0;
    }
    session.progressButton.disabled = !canSend;
    if (session.chooserType === "double") {
        session.progressButton.textContent = `Progress (${session.selection.size} + ${session.negative.size})`;
    } else {
        session.progressButton.textContent = `Progress (${session.selection.size})`;
    }
}

function sendSelection(session) {
    if (session.sending) return;
    if (session.selection.size === 0 && session.chooserType !== "double") return;
    session.sending = true;

    const positive = Array.from(session.selection).sort((a, b) => a - b);
    const negative = Array.from(session.negative).sort((a, b) => a - b);

    let payload = positive;
    if (session.chooserType === "double" && negative.length > 0) {
        payload = positive.concat([-1], negative);
    } else if (session.chooserType === "double" && negative.length === 0) {
        payload = positive.concat([-1]);
    }

    send_message(session.uniqueId, payload.join(","))
        .catch((error) => {
            console.error("Image chooser failed to send selection", error);
        })
        .finally(() => {
            closeChooser("sent");
        });
}

function attachKeyHandler() {
    detachKeyHandler();
    state.keyHandler = (event) => {
        if (!app.ui.settings.getSettingValue("ImageChooser.hotkeys", true)) return;
        const session = state.session;
        if (!session) return;
        if (event.target && event.target.tagName && ["INPUT", "TEXTAREA"].includes(event.target.tagName)) {
            return;
        }
        if (/^[1-9]$/.test(event.key)) {
            const index = parseInt(event.key, 10) - 1;
            const tile = session.grid?.querySelector(`.cg-chooser-tile[data-index="${index}"]`);
            if (tile) {
                togglePositive(session, index, tile);
            }
        } else if (event.key === "0") {
            if (session.selection.size > 0) {
                sendSelection(session);
            } else {
                send_cancel();
                closeChooser("cancel");
            }
        } else if (event.key === "Escape") {
            send_cancel();
            closeChooser("cancel");
        }
    };
    window.addEventListener("keydown", state.keyHandler, true);
}

function detachKeyHandler() {
    if (state.keyHandler) {
        window.removeEventListener("keydown", state.keyHandler, true);
        state.keyHandler = null;
    }
}

function closeChooser(reason = "close") {
    detachKeyHandler();
    if (state.overlay && state.overlay.parentElement) {
        state.overlay.parentElement.removeChild(state.overlay);
    }
    state.overlay = null;
    state.session = null;
}

function isChooserOpen() {
    return !!state.session;
}

export { openChooser, closeChooser, isChooserOpen };
