import { api } from "../../scripts/api.js";

function send_message(id, message) {
    const body = new FormData();
    body.append("id", id ?? "");
    body.append("message", message);
    return api.fetchApi("/image_chooser_classic_message", { method: "POST", body });
}

function send_cancel(id = -1) {
    return send_message(id, "__cancel__");
}

let skip_next = 0;
function skip_next_restart_message() {
    skip_next += 1;
}

function send_onstart() {
    if (skip_next > 0) {
        skip_next -= 1;
        return false;
    }
    send_message(-1, "__start__");
    return true;
}

// Re-fetch any chooser still awaiting a selection and replay it as if the
// notification had just arrived. Consumers are responsible for ignoring a
// replay of a chooser they already have open (see openChooser/handleEvent).
async function check_pending_choosers() {
    try {
        const response = await api.fetchApi("/image_chooser_classic_pending");
        if (!response.ok) return;
        const data = await response.json();
        for (const entry of data.pending ?? []) {
            if (!entry?.event) continue;
            api.dispatchEvent(new CustomEvent(entry.event, { detail: entry.context }));
        }
    } catch (error) {
        console.warn("Image Chooser Classic: failed to check for pending choosers", error);
    }
}

let pendingRecoveryRegistered = false;
function registerPendingChooserRecovery() {
    if (pendingRecoveryRegistered) return;
    pendingRecoveryRegistered = true;

    check_pending_choosers();
    api.addEventListener("reconnected", check_pending_choosers);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check_pending_choosers();
    });
    window.addEventListener("focus", check_pending_choosers);
    window.addEventListener("pageshow", check_pending_choosers);
}

export {
    send_message,
    send_cancel,
    send_onstart,
    skip_next_restart_message,
    registerPendingChooserRecovery,
};
